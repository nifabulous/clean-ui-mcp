/**
 * Pure readiness artifact graph validator.
 *
 * This module owns all validation logic. The CLI (validate-readiness-artifacts.ts)
 * is a thin wrapper that supplies repository paths and formats results.
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { resolve, relative, join, sep } from "node:path";
import {
  TrackedArtifact,
  Phase0Summary,
  OwnershipMap,
  TaxonomyDigestArtifact,
  ApprovalActorRegistry,
  CheckpointApproval,
  CheckpointApprovals,
  ArtifactIndex,
  validateRegistry,
  validateLedgerAppendOnly,
  computeTaxonomyDigest,
  buildCheckpointTarget,
  computeCheckpointTargetSha256,
  canonicalJsonStringify,
  sha256Hex,
} from "./contracts.js";
import type {
  CheckpointRecipe,
  GitSourceResolver,
} from "./checkpoint-policy.js";
import { CHECKPOINT_RECIPES } from "./checkpoint-policy.js";
import type { z } from "zod";
import {
  selectChain,
  registryChainNode,
  ordinalChainNode,
  type ChainIssue,
  type ChainNode,
  type ChainNodeResult,
} from "./chains.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ValidateReadinessOptions {
  artifactRoot: string;
  mode: "public" | "private";
  corpusPath?: string;
  privateArtifactRoot?: string;
  previousLedgerPath?: string;
  /**
   * Repository toplevel (git rev-parse --show-toplevel). Used only for
   * artifact-index path containment. The artifact root is a subdirectory of
   * the repo (quality-contracts/agent-readiness), NOT the repo root.
   */
  repoRoot?: string;
  /**
   * Pure resolver for git-bound historical bytes. REQUIRED — this gate is a
   * security boundary, so there is no back-compat "skip recomputation" path.
   * Callers without git must surface the failure rather than trust the ledger.
   */
  gitSourceResolver: GitSourceResolver;
}

export interface ValidationIssue {
  code: string;
  artifactId?: string;
  path?: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  checkpointStatus: Record<string, "open" | "closed">;
  checkedArtifacts: number;
  issues: ValidationIssue[];
}

/**
 * A parsed artifact with its computed content digest, file path, and the
 * raw record. Used throughout validation and chain construction.
 */
interface ParsedArtifact {
  type: string;
  data: Record<string, unknown>;
  filePath: string;
  sha: string;
}

/**
 * Resolved governance snapshot chains for the three versioned artifact
 * families (registries, indexes, ledgers). `registryHead` / `indexHead` /
 * `ledgerHead` are the unique terminal heads selected by the chain engine,
 * or `undefined` when the family has issues (e.g. fork, missing predecessor).
 * `registryByVersion` maps every validated registry version to its artifact;
 * `orderedLedgers` is the root-to-head ledger order when sound.
 */
interface GovernanceChains {
  registries: readonly ParsedArtifact[];
  indexes: readonly ParsedArtifact[];
  ledgers: readonly ParsedArtifact[];
  registryHead?: ParsedArtifact;
  indexHead?: ParsedArtifact;
  ledgerHead?: ParsedArtifact;
  registryByVersion: ReadonlyMap<string, ParsedArtifact>;
  orderedLedgers: readonly ParsedArtifact[];
}

// ---------------------------------------------------------------------------
// Required role sets per checkpoint
// ---------------------------------------------------------------------------

const CHECKPOINT_ROLES: Record<string, string[]> = {
  C0: ["Repository Maintainer", "PM"],
  C1: ["Product", "Engineering"],
  C2: ["Gold Label Owner", "QA"],
  C3: ["Product", "QA", "Engineering"],
  C4: ["Evaluation Owner", "Product", "QA"],
  C5: ["PM", "Corpus Owner"],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fileSha256(filePath: string): string {
  return sha256Hex(readFileSync(filePath));
}

/** Normalize to forward-slash repo-relative path (no leading slash). */
function normalizeRepoPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "");
}

/**
 * Repo-relative path of an artifact file. Index paths are recorded relative
 * to the repo toplevel (e.g. "quality-contracts/agent-readiness/foo.json"),
 * NOT relative to the artifact root. When `repoRoot` is known we compute the
 * true repo-relative path; otherwise we fall back to joining the conventional
 * artifact-root suffix with the file basename.
 */
function repoRelativePath(
  filePath: string,
  absArtifactRoot: string,
  opts: ValidateReadinessOptions,
): string {
  if (opts.repoRoot) {
    // realpath both sides: on macOS the artifact root is resolved via
    // realpathSync (resolving /tmp → /private/tmp), so the repoRoot must be
    // resolved the same way or relative() produces an upward-climbing path.
    const realRepo = realpathSync(resolve(opts.repoRoot));
    const rel = relative(realRepo, realpathSync(filePath));
    return normalizeRepoPath(rel);
  }
  // Fallback (no repoRoot): conventional artifact-root prefix + basename.
  const base = filePath.split(sep).pop() ?? "";
  return normalizeRepoPath(join("quality-contracts/agent-readiness", base));
}

/** True if `recordedPath` lives under the artifact root (forward slashes). */
function isUnderArtifactRoot(
  recordedPath: string,
  opts: ValidateReadinessOptions,
): boolean {
  const normalized = normalizeRepoPath(recordedPath);
  // The artifact root's repo-relative location is quality-contracts/agent-readiness.
  // Index paths must be contained under it. When repoRoot is known we use it;
  // otherwise we accept the conventional prefix.
  const artifactRootSuffix = "quality-contracts/agent-readiness/";
  if (opts.repoRoot) {
    // Containment under repoRoot + artifact suffix is the strong check.
    return (
      normalized.startsWith(artifactRootSuffix) ||
      normalized.startsWith(normalizeRepoPath(relative(opts.repoRoot, opts.artifactRoot)) + "/")
    );
  }
  return normalized.startsWith(artifactRootSuffix);
}

const FORBIDDEN_KEYS = new Set([
  "prompt",
  "systemPrompt",
  "rawPrompt",
  "providerPayload",
  "imageBytes",
  "entryId",
]);

/** Deep-walk an object looking for forbidden keys or eval/agent-readiness paths. */
function findLeaks(
  obj: unknown,
  path: string,
  entryIds?: Set<string>,
): { key?: string; value?: string; reason: string }[] {
  const leaks: { key?: string; value?: string; reason: string }[] = [];

  function walk(val: unknown, keyTrail: string) {
    if (val === null || typeof val !== "object") {
      // Leaf: check string values
      if (typeof val === "string") {
        if (val.startsWith("eval/agent-readiness/")) {
          leaks.push({ value: val, reason: `private path at ${keyTrail}` });
        }
        if (entryIds && entryIds.has(val)) {
          leaks.push({ value: val, reason: `exact entry ID match at ${keyTrail}` });
        }
      }
      return;
    }

    if (Array.isArray(val)) {
      val.forEach((item, i) => walk(item, `${keyTrail}[${i}]`));
      return;
    }

    const record = val as Record<string, unknown>;
    for (const [k, v] of Object.entries(record)) {
      if (FORBIDDEN_KEYS.has(k)) {
        leaks.push({ key: k, reason: `forbidden key at ${keyTrail}.${k}` });
      }
      walk(v, keyTrail ? `${keyTrail}.${k}` : k);
    }
  }

  walk(obj, path);
  return leaks;
}

// ---------------------------------------------------------------------------
// Main validation function
// ---------------------------------------------------------------------------

export function validateReadinessArtifacts(opts: ValidateReadinessOptions): ValidationResult {
  const issues: ValidationIssue[] = [];
  const checkpointStatus: Record<string, "open" | "closed"> = {
    C0: "open",
    C1: "open",
    C2: "open",
    C3: "open",
    C4: "open",
    C5: "open",
  };

  // Resolve artifact root — use realpath to match how file paths resolve
  const absRoot = realpathSync(resolve(opts.artifactRoot));

  // 1. Enumerate JSON files deterministically
  let files: string[];
  try {
    files = readdirSync(absRoot)
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch {
    issues.push({ code: "artifact-root-missing", path: absRoot, message: `cannot read artifact root: ${absRoot}` });
    return { ok: false, checkpointStatus, checkedArtifacts: 0, issues };
  }

  // 2. Parse each artifact
  const artifacts = new Map<string, { type: string; data: Record<string, unknown>; filePath: string; sha: string }>();

  for (const file of files) {
    const filePath = join(absRoot, file);

    // Reject symlinks
    const stat = lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      issues.push({ code: "symlink", path: file, message: `symlink not allowed: ${file}` });
      continue;
    }

    // Containment check
    const real = realpathSync(filePath);
    if (!real.startsWith(absRoot + sep) && real !== absRoot) {
      issues.push({ code: "path-escape", path: file, message: `path escapes artifact root: ${file}` });
      continue;
    }

    let raw: string;
    let parsed: unknown;
    try {
      raw = readFileSync(filePath, "utf-8");
      parsed = JSON.parse(raw);
    } catch (e) {
      issues.push({ code: "malformed-json", path: file, message: `cannot parse ${file}: ${(e as Error).message}` });
      continue;
    }

    const sha = sha256Hex(Buffer.from(raw, "utf-8"));
    const record = parsed as Record<string, unknown>;
    const artifactId = record.artifactId as string | undefined;
    const artifactType = record.artifactType as string | undefined;

    if (!artifactId || !artifactType) {
      issues.push({ code: "missing-header", path: file, message: `missing artifactId or artifactType in ${file}` });
      continue;
    }

    // Schema-validate via discriminated union
    const parseResult = TrackedArtifact.safeParse(parsed);
    if (!parseResult.success) {
      issues.push({
        code: "schema-error",
        artifactId,
        path: file,
        message: `schema validation failed for ${artifactId}: ${parseResult.error.issues.map((i) => i.message).join("; ")}`,
      });
      continue;
    }

    // Reject duplicate parsed artifactIds across files. Detected here (during
    // parsing) rather than after, because the Map below would otherwise
    // silently overwrite the earlier file.
    if (artifacts.has(artifactId)) {
      issues.push({
        code: "duplicate-artifact-id",
        artifactId,
        path: file,
        message: `duplicate artifactId ${artifactId} in ${file} (already seen)`,
      });
    }
    artifacts.set(artifactId, { type: artifactType, data: record, filePath, sha });
  }

  // 3. Resolve governance snapshot chains (registries, indexes, ledgers).
  //    The chain engine selects a unique terminal head per family and reports
  //    structural issues (forks, missing predecessors, duplicate keys). This
  //    replaces the former enumeration-order `.find()` selection.
  const chains = resolveGovernanceChains(artifacts, issues);
  const indexEntry = chains.indexHead;
  const ledgerEntry = chains.ledgerHead;
  const registry = chains.registryHead;

  if (!indexEntry) {
    issues.push({ code: "missing-index", message: "artifact-index not found" });
  } else {
    // Index must list every evidence/registry artifact exactly once, excluding itself and ledger
    const indexedRows = (indexEntry.data.artifacts as Array<Record<string, string>>) || [];
    const indexedIds = new Set(indexedRows.map((r) => r.artifactId));
    const implementationActorIds = new Set(
      (indexEntry.data.implementationActorIds as string[]) || [],
    );

    // Check that indexed artifacts exist and hashes match
    const seenIndexPaths = new Set<string>();
    for (const row of indexedRows) {
      const entry = artifacts.get(row.artifactId);
      if (!entry) {
        issues.push({
          code: "index-mismatch",
          artifactId: row.artifactId,
          message: `index references non-existent artifact: ${row.artifactId}`,
        });
        continue;
      }
      if (entry.sha !== row.sha256) {
        issues.push({
          code: "hash-mismatch",
          artifactId: row.artifactId,
          path: entry.filePath,
          message: `hash mismatch for ${row.artifactId}: index says ${row.sha256}, file is ${entry.sha}`,
        });
      }
      if (entry.type !== row.artifactType) {
        issues.push({
          code: "type-mismatch",
          artifactId: row.artifactId,
          message: `type mismatch for ${row.artifactId}: index says ${row.artifactType}, file is ${entry.type}`,
        });
      }

      // Index path integrity: must match the recorded repo-relative path,
      // must be contained under the artifact root, and no two rows may share
      // a path. Paths use forward slashes; normalize before comparison.
      const recordedPath = normalizeRepoPath(row.path);
      const relFilePath = repoRelativePath(entry.filePath, absRoot, opts);
      if (recordedPath !== relFilePath) {
        issues.push({
          code: "index-path-mismatch",
          artifactId: row.artifactId,
          path: row.path,
          message: `index path for ${row.artifactId} (${row.path}) does not match resolved path (${relFilePath})`,
        });
      }
      if (!isUnderArtifactRoot(recordedPath, opts)) {
        issues.push({
          code: "index-path-mismatch",
          artifactId: row.artifactId,
          path: row.path,
          message: `index path for ${row.artifactId} (${row.path}) is not contained under the artifact root`,
        });
      }
      if (seenIndexPaths.has(recordedPath)) {
        issues.push({
          code: "index-duplicate-path",
          artifactId: row.artifactId,
          path: row.path,
          message: `duplicate index path: ${row.path}`,
        });
      }
      seenIndexPaths.add(recordedPath);
    }

    // Check that every non-index, non-ledger artifact is indexed
    for (const [id, entry] of artifacts) {
      if (entry.type === "artifact-index" || entry.type === "checkpoint-approvals") continue;
      if (!indexedIds.has(id)) {
        issues.push({
          code: "missing-artifact",
          artifactId: id,
          message: `artifact ${id} (${entry.type}) exists but is not in the index`,
        });
      }
    }

    // 4. Public structural leak checks on all artifacts
    for (const [id, entry] of artifacts) {
      const leaks = findLeaks(entry.data, id);
      for (const leak of leaks) {
        issues.push({
          code: "leak",
          artifactId: id,
          path: entry.filePath,
          message: leak.reason,
        });
      }
    }

    // 5. Taxonomy cross-artifact hash consistency
    const phase0 = [...artifacts.values()].find((a) => a.type === "phase0-summary");
    const taxonomy = [...artifacts.values()].find((a) => a.type === "taxonomy-digest");
    if (phase0 && taxonomy) {
      const phase0TaxHash = phase0.data.taxonomySha256 as string;
      const taxAggregate = taxonomy.data.aggregateSha256 as string;
      if (phase0TaxHash !== taxAggregate) {
        issues.push({
          code: "taxonomy-hash-mismatch",
          artifactId: phase0.data.artifactId as string,
          message: `phase0 taxonomySha256 (${phase0TaxHash}) does not match taxonomy-digest aggregateSha256 (${taxAggregate})`,
        });
      }

      // 6. Recompute taxonomy hashes from live schema
      const computed = computeTaxonomyDigest();
      if (taxAggregate !== computed.aggregateSha256) {
        issues.push({
          code: "taxonomy-recompute",
          artifactId: taxonomy.data.artifactId as string,
          message: `taxonomy-digest aggregateSha256 (${taxAggregate}) does not match recomputed (${computed.aggregateSha256})`,
        });
      }
    }

    // 7. Validate registry (head selected via chain engine in section 3)
    if (registry) {
      const registryIssues = validateRegistry(registry.data as z.infer<typeof ApprovalActorRegistry>);
      for (const msg of registryIssues) {
        issues.push({
          code: "registry-error",
          artifactId: registry.data.artifactId as string,
          message: msg,
        });
      }
    }

    // 7b. Append-only verification across every adjacent root-to-head ledger
    //     edge. Each predecessor approval list must survive unchanged (same
    //     approvalId, same canonical bytes, same order) in its successor.
    for (let i = 1; i < chains.orderedLedgers.length; i++) {
      const previous = CheckpointApprovals.safeParse(chains.orderedLedgers[i - 1]!.data);
      const current = CheckpointApprovals.safeParse(chains.orderedLedgers[i]!.data);
      if (!previous.success || !current.success) continue; // schema errors already recorded
      for (const message of validateLedgerAppendOnly(current.data, previous.data)) {
        const deleted = message.startsWith("prior approval deleted:");
        const reordered = message.startsWith("prior approval reordered:");
        issues.push({
          code: deleted
            ? "ledger-approval-deleted"
            : reordered
              ? "ledger-approval-reordered"
              : "ledger-approval-mutated",
          artifactId: String(chains.orderedLedgers[i]!.data.artifactId),
          message,
        });
      }
    }

    // 8. Approvals and checkpoint closure
    if (ledgerEntry && registry) {
      validateApprovalsAndCheckpoint(
        ledgerEntry,
        registry,
        implementationActorIds,
        artifacts,
        absRoot,
        opts,
        issues,
        checkpointStatus,
      );
    }

    // 9. Private mode: verify corpus identity
    if (opts.mode === "private") {
      if (!opts.corpusPath) {
        issues.push({ code: "config-error", message: "private mode requires --corpus-path" });
      } else {
        try {
          const corpusBytes = readFileSync(opts.corpusPath);
          const corpusSha = sha256Hex(corpusBytes);
          const corpusJson = JSON.parse(corpusBytes.toString("utf-8"));
          const entryCount = corpusJson.entries?.length ?? 0;

          if (phase0) {
            const claimedSha = phase0.data.corpusSha256 as string;
            if (claimedSha !== corpusSha) {
              issues.push({
                code: "corpus-hash-mismatch",
                artifactId: phase0.data.artifactId as string,
                message: `corpusSha256 (${claimedSha}) does not match actual file (${corpusSha})`,
              });
            }
            const claimedCount = phase0.data.corpusEntryCount as number;
            if (claimedCount !== entryCount) {
              issues.push({
                code: "corpus-count-mismatch",
                artifactId: phase0.data.artifactId as string,
                message: `corpusEntryCount (${claimedCount}) does not match actual (${entryCount})`,
              });
            }

            // Private exact entry-ID leak check
            const entryIds = new Set<string>(corpusJson.entries.map((e: { id: string }) => e.id));
            for (const [id, entry] of artifacts) {
              const leaks = findLeaks(entry.data, id, entryIds);
              for (const leak of leaks) {
                if (leak.reason.includes("entry ID")) {
                  issues.push({
                    code: "leak",
                    artifactId: id,
                    path: entry.filePath,
                    message: leak.reason,
                  });
                }
              }
            }
          }
        } catch (e) {
          issues.push({
            code: "corpus-unreadable",
            path: opts.corpusPath,
            message: `cannot read corpus: ${(e as Error).message}`,
          });
        }
      }
    }
  }

  return {
    ok: issues.length === 0,
    checkpointStatus,
    checkedArtifacts: artifacts.size,
    issues,
  };
}

// ---------------------------------------------------------------------------
// Governance chain resolution
// ---------------------------------------------------------------------------

/** Map a structural ChainIssue to a ValidationIssue (codes preserved). */
function chainIssueToValidationIssue(issue: ChainIssue): ValidationIssue {
  return {
    code: issue.code,
    artifactId: issue.nodeId,
    message: issue.message,
  };
}

/**
 * Collect every registry/index/ledger artifact, adapt each to its chain node
 * representation, and run `selectChain` per family. Chain issues (forks,
 * missing predecessors, duplicate keys, etc.) are pushed onto `issues`. Heads
 * are left undefined for any family with issues.
 *
 * A family with a single artifact and no chain metadata forms a degenerate
 * chain of one node whose head is that node — this keeps the existing v1-only
 * real repo validating.
 */
function resolveGovernanceChains(
  artifacts: Map<string, ParsedArtifact>,
  issues: ValidationIssue[],
): GovernanceChains {
  const registries = [...artifacts.values()].filter((a) => a.type === "approval-actor-registry");
  const indexes = [...artifacts.values()].filter((a) => a.type === "artifact-index");
  const ledgers = [...artifacts.values()].filter((a) => a.type === "checkpoint-approvals");

  // Registries use string version keys via registryChainNode.
  const registryAdapted: ChainNode<ParsedArtifact>[] = registries.map(registryChainNode);
  const registrySelection = selectChain("registry", registryAdapted);

  // Indexes and ledgers use ordinal keys via ordinalChainNode. An adaptation
  // failure (e.g. malformed predecessor) is itself a chain issue.
  const indexAdapted: ChainNodeResult<ParsedArtifact>[] = indexes.map(ordinalChainNode);
  const ledgerAdapted: ChainNodeResult<ParsedArtifact>[] = ledgers.map(ordinalChainNode);

  const indexValid: ChainNode<ParsedArtifact>[] = [];
  const ledgerValid: ChainNode<ParsedArtifact>[] = [];
  for (const result of indexAdapted) {
    if (result.ok) {
      indexValid.push(result.node);
    } else {
      issues.push(chainIssueToValidationIssue(result.issue));
    }
  }
  for (const result of ledgerAdapted) {
    if (result.ok) {
      ledgerValid.push(result.node);
    } else {
      issues.push(chainIssueToValidationIssue(result.issue));
    }
  }

  const indexSelection = selectChain("index", indexValid);
  const ledgerSelection = selectChain("ledger", ledgerValid);

  // Surface structural issues from every family.
  for (const issue of [...registrySelection.issues, ...indexSelection.issues, ...ledgerSelection.issues]) {
    issues.push(chainIssueToValidationIssue(issue));
  }

  // registryByVersion spans every validated registry node (not only the head),
  // keyed by its version string. Built from the adapted nodes so the key set
  // matches what the chain engine actually considered.
  const registryByVersion = new Map<string, ParsedArtifact>();
  for (const node of registryAdapted) {
    registryByVersion.set(String(node.key), node.value);
  }

  return {
    registries,
    indexes,
    ledgers,
    registryHead: registrySelection.head?.value,
    indexHead: indexSelection.head?.value,
    ledgerHead: ledgerSelection.head?.value,
    registryByVersion,
    orderedLedgers: ledgerSelection.ordered.map((n) => n.value),
  };
}

// ---------------------------------------------------------------------------
// Approval validation
// ---------------------------------------------------------------------------

function validateApprovalsAndCheckpoint(
  ledgerEntry: ParsedArtifact,
  registry: ParsedArtifact,
  implementationActorIds: Set<string>,
  artifacts: Map<string, ParsedArtifact>,
  absRoot: string,
  opts: ValidateReadinessOptions,
  issues: ValidationIssue[],
  checkpointStatus: Record<string, "open" | "closed">,
): void {
  const ledgerData = CheckpointApprovals.safeParse(ledgerEntry.data);
  if (!ledgerData.success) {
    // Schema error already recorded
    return;
  }

  const approvals = ledgerData.data.approvals;
  const registryData = registry.data as z.infer<typeof ApprovalActorRegistry>;
  const registryActorMap = new Map(registryData.actors.map((a) => [a.actorId, a]));

  // ------------------------------------------------------------------
  // Git-bound recomputation of the canonical checkpoint target(s).
  // Only checkpoints with a known recipe are recomputed; others fall back
  // to the legacy presence-only closure check.
  // ------------------------------------------------------------------
  const recompute = computeCanonicalTargets(artifacts, absRoot, opts);

  // Per-approval set of issue codes that this approval produced. An approval
  // with any issue cannot contribute to closure.
  const approvalIssueCodes = new Map<string, Set<string>>();
  const noteApprovalIssue = (approvalId: string, code: string) => {
    let set = approvalIssueCodes.get(approvalId);
    if (!set) {
      set = new Set();
      approvalIssueCodes.set(approvalId, set);
    }
    set.add(code);
  };

  // Track target SHAs per checkpoint (for divergent-target detection)
  const targetShas = new Map<string, Set<string>>();

  for (const approval of approvals) {
    const iid = approval.approvalId;

    // Implementer cannot approve (checked first — no continue, all checks run)
    if (implementationActorIds.has(approval.actorId)) {
      issues.push({
        code: "implementer-self-approval",
        artifactId: iid,
        message: `approval ${iid}: implementer ${approval.actorId} cannot approve`,
      });
      noteApprovalIssue(iid, "implementer-self-approval");
    }

    // Actor must exist in registry
    const actor = registryActorMap.get(approval.actorId);
    if (!actor) {
      issues.push({
        code: "actor-not-found",
        artifactId: iid,
        message: `approval ${iid}: actor ${approval.actorId} not in registry`,
      });
      noteApprovalIssue(iid, "actor-not-found");
      continue;
    }

    // Actor must be authorized for the claimed role
    if (!actor.roles.includes(approval.role)) {
      issues.push({
        code: "actor-role-mismatch",
        artifactId: iid,
        message: `approval ${iid}: actor ${approval.actorId} not authorized for role ${approval.role}`,
      });
      noteApprovalIssue(iid, "actor-role-mismatch");
    }

    // Actor kind must match registry
    if (actor.actorKind !== approval.actorKind) {
      issues.push({
        code: "actor-kind-mismatch",
        artifactId: iid,
        message: `approval ${iid}: actorKind ${approval.actorKind} does not match registry ${actor.actorKind}`,
      });
      noteApprovalIssue(iid, "actor-kind-mismatch");
    }

    // Registry hash must match actual file
    if (approval.actorRegistrySha256 !== registry.sha) {
      issues.push({
        code: "registry-hash-mismatch",
        artifactId: iid,
        message: `approval ${iid}: registry hash ${approval.actorRegistrySha256} does not match file ${registry.sha}`,
      });
      noteApprovalIssue(iid, "registry-hash-mismatch");
    }

    // Git-bound recomputation checks. When a recipe exists, recomputation is
    // MANDATORY and fail-closed: a resolved target must compare against the
    // approval, or — if resolution threw — the approval is disqualified and the
    // checkpoint cannot close. There is no skip path; the resolver is required.
    const recipe = recompute.recipes[approval.checkpoint];
    const recomputeError = recompute.recomputeFailures.get(approval.checkpoint);
    if (recipe && recomputeError !== undefined) {
      issues.push({
        code: "checkpoint-recompute-failed",
        artifactId: iid,
        message: `approval ${iid}: checkpoint ${approval.checkpoint} target could not be recomputed (${recomputeError}); approval cannot contribute to closure`,
      });
      noteApprovalIssue(iid, "checkpoint-recompute-failed");
    } else if (recipe && recompute.canonical[approval.checkpoint]) {
      const canonical = recompute.canonical[approval.checkpoint]!;

      // checkpointTargetSha256 must equal the recomputed canonical target.
      if (approval.checkpointTargetSha256 !== canonical.targetSha256) {
        issues.push({
          code: "checkpoint-target-mismatch",
          artifactId: iid,
          message: `approval ${iid}: checkpointTargetSha256 ${approval.checkpointTargetSha256} does not match recomputed ${canonical.targetSha256}`,
        });
        noteApprovalIssue(iid, "checkpoint-target-mismatch");
      }

      // planSha256 / specSha256 must match resolved historical bytes.
      if (approval.planSha256 !== canonical.planSha256) {
        issues.push({
          code: "plan-hash-mismatch",
          artifactId: iid,
          message: `approval ${iid}: planSha256 ${approval.planSha256} does not match resolved ${canonical.planSha256}`,
        });
        noteApprovalIssue(iid, "plan-hash-mismatch");
      }
      if (approval.specSha256 !== canonical.specSha256) {
        issues.push({
          code: "spec-hash-mismatch",
          artifactId: iid,
          message: `approval ${iid}: specSha256 ${approval.specSha256} does not match resolved ${canonical.specSha256}`,
        });
        noteApprovalIssue(iid, "spec-hash-mismatch");
      }

      // contractHashes: exact key set + per-key value match.
      const expectedContractKeys = new Set(recipe.contractBindings.map((b) => b.key));
      const actualContractKeys = new Set(Object.keys(approval.contractHashes));
      const contractKeyMismatch =
        expectedContractKeys.size !== actualContractKeys.size ||
        [...expectedContractKeys].some((k) => !actualContractKeys.has(k));
      if (contractKeyMismatch) {
        issues.push({
          code: "contract-hash-mismatch",
          artifactId: iid,
          message: `approval ${iid}: contractHashes keys (${[...actualContractKeys].sort().join(",")}) do not match expected (${[...expectedContractKeys].sort().join(",")})`,
        });
        noteApprovalIssue(iid, "contract-hash-mismatch");
      } else {
        for (const b of recipe.contractBindings) {
          if (approval.contractHashes[b.key] !== canonical.contractHashes[b.key]) {
            issues.push({
              code: "contract-hash-mismatch",
              artifactId: iid,
              message: `approval ${iid}: contractHashes[${b.key}] ${approval.contractHashes[b.key]} does not match resolved ${canonical.contractHashes[b.key]}`,
            });
            noteApprovalIssue(iid, "contract-hash-mismatch");
          }
        }
      }

      // approvedArtifacts must exactly equal the recipe artifact set.
      verifyApprovedArtifactSet(approval, recipe, artifacts, issues, noteApprovalIssue);
    }

    // Track target SHAs per checkpoint
    if (!targetShas.has(approval.checkpoint)) {
      targetShas.set(approval.checkpoint, new Set());
    }
    targetShas.get(approval.checkpoint)!.add(approval.checkpointTargetSha256);
  }

  // Check divergent targets
  for (const [cp, shas] of targetShas) {
    if (shas.size > 1) {
      issues.push({
        code: "divergent-targets",
        message: `checkpoint ${cp} has ${shas.size} different target SHAs`,
      });
    }
  }

  // Verify phase0-summary inputHashes against resolved historical bytes.
  verifySummaryInputHashes(artifacts, recompute, issues);

  // Determine checkpoint closure for C0–C5. Only approvals that are
  // (decision:"approved" + approvalKind:"checkpoint") AND produced no issue
  // can contribute to closure.
  for (const cp of ["C0", "C1", "C2", "C3", "C4", "C5"]) {
    const required = CHECKPOINT_ROLES[cp] || [];
    const cpApprovals = approvals.filter(
      (a) =>
        a.checkpoint === cp &&
        a.decision === "approved" &&
        a.approvalKind === "checkpoint" &&
        !approvalIssueCodes.has(a.approvalId),
    );

    const approvedRoles = new Set<string>();
    const approvedActors = new Set<string>();
    for (const a of cpApprovals) {
      approvedRoles.add(a.role);
      approvedActors.add(a.actorId);
    }

    const allRolesPresent = required.every((r) => approvedRoles.has(r));
    const distinctActors = approvedActors.size === cpApprovals.length;

    if (allRolesPresent && distinctActors) {
      checkpointStatus[cp] = "closed";
    }
  }
}

// ---------------------------------------------------------------------------
// Canonical checkpoint-target recomputation
// ---------------------------------------------------------------------------

interface CanonicalTarget {
  targetSha256: string;
  planSha256: string;
  specSha256: string;
  contractHashes: Record<string, string>;
}

interface RecomputeState {
  recipes: Partial<Record<string, CheckpointRecipe>>;
  canonical: Partial<Record<string, CanonicalTarget>>;
  /** Checkpoints whose recomputation threw — every approval must fail closed. */
  recomputeFailures: Map<string, string>;
  /** Resolved git-file inputHashes for phase0-summary verification (key → sha). */
  inputHashes: Record<string, string>;
}

/**
 * Recompute the canonical checkpoint target for every checkpoint with a known
 * recipe. The resolver is REQUIRED (validated by the caller). Resolver throws
 * are recorded in `recomputeFailures` so the per-approval loop can emit a
 * blocking issue and disqualify every affected approval — this is fail-closed.
 */
function computeCanonicalTargets(
  artifacts: Map<string, ParsedArtifact>,
  _absRoot: string,
  opts: ValidateReadinessOptions,
): RecomputeState {
  const resolver = opts.gitSourceResolver;

  const recipes: Partial<Record<string, CheckpointRecipe>> = {};
  const canonical: Partial<Record<string, CanonicalTarget>> = {};
  const recomputeFailures = new Map<string, string>();
  const inputHashes: Record<string, string> = {};

  for (const [cp, recipe] of Object.entries(CHECKPOINT_RECIPES)) {
    recipes[cp] = recipe;

    try {
      const planSha256 = sha256Hex(resolver.resolve(recipe.planBinding.gitCommit, recipe.planBinding.repositoryPath));
      const specSha256 = sha256Hex(resolver.resolve(recipe.specBinding.gitCommit, recipe.specBinding.repositoryPath));
      const contractHashes: Record<string, string> = {};
      for (const b of recipe.contractBindings) {
        contractHashes[b.key] = sha256Hex(resolver.resolve(b.gitCommit, b.repositoryPath));
      }

      // Resolve artifact-root inputHash aliases from in-memory parsed
      // artifacts (already integrity-pinned by the index hash check).
      // Resolve git-file inputHash aliases via the resolver.
      const fullInputHashes: Record<string, string> = {};
      for (const b of recipe.inputHashBindings) {
        fullInputHashes[b.key] = sha256Hex(resolver.resolve(b.gitCommit, b.repositoryPath));
      }
      // Artifact-root aliases: find the parsed artifact whose filename matches
      // the alias key and use its in-memory .sha.
      for (const key of recipe.inputHashKeys) {
        if (fullInputHashes[key] !== undefined) continue;
        const entry = findArtifactByFilename(artifacts, key);
        if (entry) {
          fullInputHashes[key] = entry.sha;
        }
      }
      Object.assign(inputHashes, fullInputHashes);

      // Build the artifact set for the target. The artifact shas come from
      // the in-memory parsed artifacts (the same values the index pins).
      const targetArtifacts = recipe.artifacts.map((a) => {
        const entry = [...artifacts.values()].find(
          (e) => e.data.artifactId === a.artifactId,
        );
        return {
          artifactId: a.artifactId,
          artifactType: a.artifactType,
          sha256: entry?.sha ?? "",
        };
      });

      // Registry version + sha from the in-memory registry artifact.
      const registryEntry = [...artifacts.values()].find(
        (e) => e.type === "approval-actor-registry",
      );
      const registryVersion =
        (registryEntry?.data.registryVersion as string | undefined) ?? "";
      const registrySha = registryEntry?.sha ?? "";

      const targetInputHashes = recipe.targetIncludesInputHashes ? fullInputHashes : {};

      const target = buildCheckpointTarget({
        checkpoint: recipe.checkpoint,
        baselineGitSha: recipe.baselineGitSha,
        artifacts: targetArtifacts,
        planSha256,
        specSha256,
        actorRegistryVersion: registryVersion,
        actorRegistrySha256: registrySha,
        contractHashes,
        inputHashes: targetInputHashes,
      });

      canonical[cp] = {
        targetSha256: computeCheckpointTargetSha256(target),
        planSha256,
        specSha256,
        contractHashes,
      };
    } catch (e) {
      // Fail closed: record the failure so the per-approval loop emits a
      // blocking issue for every approval of this checkpoint and disqualifies
      // them from closure. Resolution failure must NEVER silently close a
      // checkpoint — that would reintroduce the fabricated-approval exploit.
      recomputeFailures.set(cp, (e as Error).message ?? String(e));
    }
  }

  return { recipes, canonical, recomputeFailures, inputHashes };
}

/** Find a parsed artifact whose filePath basename matches `filename`. */
function findArtifactByFilename(
  artifacts: Map<string, ParsedArtifact>,
  filename: string,
): ParsedArtifact | undefined {
  for (const entry of artifacts.values()) {
    const base = entry.filePath.split(sep).pop() ?? "";
    if (base === filename) return entry;
  }
  return undefined;
}

/**
 * Verify an approval's approvedArtifacts[] exactly equals the recipe artifact
 * set: same IDs, no missing/extra/duplicate, each sha matches the in-memory
 * artifact, and every ID is known.
 */
function verifyApprovedArtifactSet(
  approval: z.infer<typeof CheckpointApproval>,
  recipe: CheckpointRecipe,
  artifacts: Map<string, ParsedArtifact>,
  issues: ValidationIssue[],
  note: (approvalId: string, code: string) => void,
): void {
  const iid = approval.approvalId;
  const expectedIds = recipe.artifacts.map((a) => a.artifactId).sort();
  const actualIds = approval.approvedArtifacts.map((a) => a.artifactId).sort();

  // Duplicate artifactId within the approval's list
  const seen = new Set<string>();
  for (const a of approval.approvedArtifacts) {
    if (seen.has(a.artifactId)) {
      issues.push({
        code: "approved-artifact-set-mismatch",
        artifactId: iid,
        message: `approval ${iid}: duplicate approvedArtifact ${a.artifactId}`,
      });
      note(iid, "approved-artifact-set-mismatch");
    }
    seen.add(a.artifactId);
  }

  const expectedSet = new Set(expectedIds);
  const actualSet = new Set(actualIds);

  // Missing / extra
  const missing = expectedIds.filter((id) => !actualSet.has(id));
  const extra = actualIds.filter((id) => !expectedSet.has(id));
  if (missing.length > 0 || extra.length > 0 || expectedIds.length !== actualIds.length) {
    issues.push({
      code: "approved-artifact-set-mismatch",
      artifactId: iid,
      message: `approval ${iid}: approvedArtifacts set mismatch (missing=[${missing.join(",")}], extra=[${extra.join(",")}])`,
    });
    note(iid, "approved-artifact-set-mismatch");
  }

  // Per-artifact: unknown id and hash mismatch
  for (const a of approval.approvedArtifacts) {
    if (!expectedSet.has(a.artifactId)) {
      issues.push({
        code: "approved-artifact-unknown",
        artifactId: iid,
        message: `approval ${iid}: approvedArtifact ${a.artifactId} is not in the recipe artifact set`,
      });
      note(iid, "approved-artifact-unknown");
      continue;
    }
    const entry = [...artifacts.values()].find((e) => e.data.artifactId === a.artifactId);
    if (!entry) continue; // already reported elsewhere
    if (entry.sha !== a.sha256) {
      issues.push({
        code: "approved-artifact-hash-mismatch",
        artifactId: iid,
        message: `approval ${iid}: approvedArtifact ${a.artifactId} sha256 ${a.sha256} does not match in-memory ${entry.sha}`,
      });
      note(iid, "approved-artifact-hash-mismatch");
    }
  }
}

/**
 * Verify the phase0-summary inputHashes: keys must equal the recipe's
 * inputHashKeys, and each value must match the resolved historical hash.
 */
function verifySummaryInputHashes(
  artifacts: Map<string, ParsedArtifact>,
  recompute: RecomputeState,
  issues: ValidationIssue[],
): void {
  const phase0 = [...artifacts.values()].find((a) => a.type === "phase0-summary");
  if (!phase0) return;

  // Use the C0 recipe's inputHashKeys (the only recipe today).
  const recipe = recompute.recipes["C0"];
  if (!recipe) return;

  const summaryHashes = (phase0.data.inputHashes as Record<string, string>) || {};
  const expectedKeys = new Set(recipe.inputHashKeys);
  const actualKeys = new Set(Object.keys(summaryHashes));

  const missing = [...expectedKeys].filter((k) => !actualKeys.has(k));
  const extra = [...actualKeys].filter((k) => !expectedKeys.has(k));

  if (missing.length > 0 || extra.length > 0) {
    issues.push({
      code: "summary-input-hash-mismatch",
      artifactId: phase0.data.artifactId as string,
      message: `phase0-summary inputHashes keys mismatch (missing=[${missing.join(",")}], extra=[${extra.join(",")}])`,
    });
    return;
  }

  for (const key of recipe.inputHashKeys) {
    const claimed = summaryHashes[key];
    const resolved = recompute.inputHashes[key];
    // Fail closed: an unresolvable input-hash binding is a mismatch, not a skip.
    // (Resolver failures are also surfaced per-checkpoint as checkpoint-recompute-failed;
    // reaching here with undefined means the recipe declared a key we could not resolve.)
    if (resolved === undefined) {
      issues.push({
        code: "summary-input-hash-mismatch",
        artifactId: phase0.data.artifactId as string,
        message: `phase0-summary inputHashes[${key}] has no resolved historical hash`,
      });
      continue;
    }
    if (claimed !== resolved) {
      issues.push({
        code: "summary-input-hash-mismatch",
        artifactId: phase0.data.artifactId as string,
        message: `phase0-summary inputHashes[${key}] ${claimed} does not match resolved ${resolved}`,
      });
    }
  }
}
