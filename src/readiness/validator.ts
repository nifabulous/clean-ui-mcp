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
  isApprovalRow,
  isRetractionRow,
} from "./contracts.js";
import type { CheckpointRetractionT, LedgerRowT } from "./contracts.js";
import type {
  CheckpointRecipe,
  GitSourceResolver,
} from "./checkpoint-policy.js";
import { CHECKPOINT_RECIPES, CHECKPOINT_POLICIES } from "./checkpoint-policy.js";
import type { z } from "zod";
import {
  selectChain,
  registryChainNode,
  ordinalChainNode,
  type ChainIssue,
  type ChainNode,
  type ChainNodeResult,
} from "./chains.js";
import { ledgerApprovalRowsDigest, resolveLedgerApprovalPins } from "./ledger-pins.js";
import type { LedgerPinScope } from "./ledger-pins.js";
import {
  C2LabelIntegritySelectionSchema,
  C2IndependentLabelSubmissionSchema,
  C2LabelIntegrityBaselineMetricsSchema,
  C2LabelAgreementReportSchema,
  C2LabelAgreementAdjudicationSchema,
} from "../c2/evaluation-contracts.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ValidateReadinessOptions {
  artifactRoot: string;
  mode: "public" | "private";
  corpusPath?: string;
  privateArtifactRoot?: string;
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
  /**
   * EXTRA approval-row pins, keyed by the ledger's PATH within `artifactRoot`
   * (e.g. "checkpoint-approvals-v1.json"), for artifact graphs this repository
   * does not track (fixtures). Merged UNDER `TRACKED_LEDGER_APPROVAL_PINS` and
   * only for the tracked root, so it can neither weaken a tracked pin nor
   * declare the tracked chain untracked — see `resolveLedgerApprovalPins`. The
   * CLI never sets this.
   */
  additionalLedgerApprovalPins?: Readonly<Record<string, string>>;
}

export interface ValidationIssue {
  code: string;
  artifactId?: string;
  path?: string;
  message: string;
  /**
   * The checkpoint this finding concerns, when the emitting check knows it.
   *
   * WHY THIS EXISTS AND WHY IT IS NOT `artifactId`. Closure attribution asks
   * "which checkpoint does this issue hold open?" and answers it from
   * identifiers on the issue (see the attribution block in
   * `validateApprovalsAndCheckpoint`). `artifactId` cannot carry that answer: it
   * means "the artifact this finding is about", and for most checks it is an
   * ARTIFACT id — a string that can never equal a checkpoint name or an
   * approvalId. Overloading it with a checkpoint id would make one field mean
   * two things and would DESTROY the artifact identity in the reported issue
   * (`c2-evidence-unavailable` would stop naming the evidence manifest), and for
   * `divergent-targets` there is no artifact at all, so `artifactId: "C0"` would
   * invent one.
   *
   * This field is therefore the attribution channel and `artifactId` stays the
   * identity channel. It is OPTIONAL and fail-closed: an issue that sets neither
   * this nor an attributable `artifactId` holds EVERY checkpoint open, and a
   * value that is not one of `C0`–`C5` is not treated as an attribution at all
   * (a typo over-blocks rather than silently attributing to nothing).
   */
  checkpoint?: string;
}

export interface ValidationResult {
  ok: boolean;
  checkpointStatus: Record<string, "open" | "closed">;
  checkedArtifacts: number;
  issues: ValidationIssue[];
  /**
   * Non-blocking caveats surfaced alongside the result. These do NOT affect
   * `ok` or the exit code — they document limits the validator cannot enforce
   * (e.g. C2 externality is asserted but not machine-verifiable). Callers
   * SHOULD surface them in the report so the closure claim is honest.
   */
  warnings: ValidationIssue[];
  /**
   * Which ledger approval-pin table was in force for this run.
   *
   * WHY THIS IS PART OF THE RESULT AND NOT JUST A DIAGNOSTIC. The pins
   * (`TRACKED_LEDGER_APPROVAL_PINS`) are what anchor the governance ledger's
   * approval rows from outside the artifact graph, and they apply to exactly one
   * directory — this repository's own artifact root. Every other root runs the
   * gate with those three rules inert. The CLI says so on stderr, but stderr is
   * for humans: a machine consumer reading `--json` had NO way to tell an
   * attested run from an unpinned one, so `ok:false` from a copy and `ok:false`
   * from the tracked root were indistinguishable, and so were the `ok:true`
   * cases. Emitting the scope alongside `ok` makes "were the pins in force?" a
   * field rather than a stderr-parsing exercise.
   *
   * The value is decided by `resolveLedgerApprovalPins` from the resolved root
   * and the caller's `additionalLedgerApprovalPins` alone — no artifact's
   * contents participate, so nothing under `quality-contracts/` can change what
   * this reports. `"tracked"` is the only value for which the tracked table
   * applies; `"caller"` means only caller-supplied fixture pins were checked;
   * `"none"` means all three pin rules were inert.
   */
  ledgerPinScope: LedgerPinScope;
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

/**
 * Role requirements for checkpoints without a declared closed-world policy
 * (C2–C5). C0 and C1 derive their required roles from `CHECKPOINT_POLICIES`
 * (consumed at runtime via `CHECKPOINT_POLICIES[cp].requiredRoles`); this table
 * only covers the future checkpoints that still use the legacy presence-only
 * closure check.
 */
const FUTURE_CHECKPOINT_ROLES: Record<string, string[]> = {
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
  const warnings: ValidationIssue[] = [];
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

  // WHICH PIN TABLE IS IN FORCE — resolved HERE, before a single artifact is
  // read, because the answer depends only on the resolved root and the caller's
  // fixture pins. Resolving it up front is what lets `ledgerPinScope` be
  // reported on EVERY return path, including the early one below: a run that
  // could not even enumerate the root still has to say whether it would have
  // been an attested run. `approvalRowPins`/`ledgerPinScope` are consumed by
  // step 7c far below; see the three rules documented there.
  const { pins: approvalRowPins, scope: ledgerPinScope } = resolveLedgerApprovalPins({
    absArtifactRoot: absRoot,
    additional: opts.additionalLedgerApprovalPins,
  });

  // 1. Enumerate JSON files deterministically
  let files: string[];
  try {
    files = readdirSync(absRoot)
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch {
    issues.push({ code: "artifact-root-missing", path: absRoot, message: `cannot read artifact root: ${absRoot}` });
    return { ok: false, checkpointStatus, checkedArtifacts: 0, issues, warnings, ledgerPinScope };
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

    // 7. Validate EVERY registry in the sound chain, not just the head.
    //    Approvals resolve pinned historical versions; a malformed historical
    //    registry (e.g. separation-of-duties with a forbidden bootstrap owner)
    //    must not remain authoritative without producing a registry-error.
    for (const reg of chains.registries) {
      const registryIssues = validateRegistry(reg.data as z.infer<typeof ApprovalActorRegistry>);
      for (const msg of registryIssues) {
        issues.push({
          code: "registry-error",
          artifactId: reg.data.artifactId as string,
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

    // 7c. Approval-row pins — the anchor at the NEWEST end of the chain.
    //
    //     7b above compares each ledger against its PREDECESSOR's approvals, so
    //     the head's own appended rows are compared against nothing. Combined
    //     with the ledger family's exemption from index membership (step 3) and
    //     the fact that `predecessor.sha256` pins the predecessor rather than
    //     the file declaring it, the head ledger's rows were attested by nothing
    //     at all — editing two `decidedAt` fields in place cleared two blocking
    //     governance findings and turned the gate green. `ledger-pins.ts` holds
    //     the anchor OUTSIDE the artifact graph, because an anchor inside it is
    //     reachable by the same edit; that module's docblock states precisely
    //     what the pin is and is not durable against.
    //
    //     KEYED ON THE LEDGER'S PATH WITHIN THE ARTIFACT ROOT, not on any field
    //     the file declares about itself. Two prior revisions keyed on
    //     `artifactId` and both were evaded by editing it — first by renaming
    //     the head so its pin was never consulted, then, after a chain-coverage
    //     rule was added, by renaming ALL FIVE ids and repairing the four
    //     `predecessor.sha256` values in a loop (the link is keyed on the chain
    //     ORDINAL, not on the predecessor's id, so the cascade repairs cleanly
    //     and the head's file digest is pinned by nothing). Both evasions were
    //     reproduced end to end and produced `ok: true` with `C2: closed` and
    //     zero issues. A filename is held by the directory rather than by the
    //     file's contents, so it is not editable from inside the file.
    //
    //     THREE RULES, ALL BLOCKING, RUN WHENEVER THE TABLE IS IN FORCE:
    //
    //       A. every `checkpoint-approvals` file under the root has a pin
    //          → `ledger-approval-pin-missing`
    //       B. every pinned path resolves to a parsed file
    //          → `ledger-approval-pin-absent`
    //       C. a pinned file's rows digest to the pinned value
    //          → `ledger-approval-pin-mismatch`
    //
    //     Rule B is why deletion is now caught: the one-directional form of this
    //     check iterated the chain and never the table, so `rm` of the three
    //     newest ledgers erased both blocking findings and produced `ok: true`
    //     with zero issues (reproduced). Rule A is why an appended head, or a
    //     renamed ledger FILE, fails loudly instead of silently.
    //
    //     Whether the table is in force is decided OUTSIDE the artifact graph —
    //     `resolveLedgerApprovalPins` compares the root being validated against
    //     this repository's own artifact root, derived from the module's location
    //     on disk — which is what makes rule B meaningful at all. No artifact's
    //     contents participate in that decision, so no edit under
    //     `quality-contracts/` can declare the chain untracked.
    //
    //     All three rules are mode-independent (the `opts.mode === "private"`
    //     branch is far below) and all run BEFORE
    //     `validateApprovalsAndCheckpoint`, so `ledgerRowsAuthoritative` is
    //     already settled when closure is computed.
    //     The table itself is resolved at the TOP of this function (so
    //     `ledgerPinScope` can be reported on every return path); this step
    //     consumes `approvalRowPins`/`ledgerPinScope` and enforces the rules.
    let ledgerRowsAuthoritative = true;

    if (ledgerPinScope !== "none") {
      // Iterates EVERY parsed checkpoint-approvals artifact, not only the
      // resolved chain: a ledger parked outside the chain is still a governance
      // ledger sitting in the tracked directory, and requiring a pin for it does
      // not depend on chain resolution having succeeded.
      const pinnedPathsPresent = new Set<string>();

      for (const ledger of [...artifacts.values()].filter(
        (a) => a.type === "checkpoint-approvals",
      )) {
        const artifactId = String(ledger.data.artifactId);
        const relPath = normalizeRepoPath(relative(absRoot, ledger.filePath));
        const pin = approvalRowPins[relPath];

        // ── rule A ──────────────────────────────────────────────────────────
        if (pin === undefined) {
          // FAIL CLOSED. An unpinned ledger file is not "not yet attested" — it
          // is a ledger whose rows no anchor outside the graph covers, which is
          // exactly the state the pin exists to prevent. It must not be a
          // warning: a warning does not move `ok` and does not stop closure, so
          // the operator would still read `All checks passed.`
          ledgerRowsAuthoritative = false;
          issues.push({
            code: "ledger-approval-pin-missing",
            artifactId,
            path: relPath,
            message:
              `ledger file ${relPath} (${artifactId}) has no source pin. Every ` +
              `checkpoint-approvals file under a pinned artifact root must be ` +
              `pinned by PATH, root to head: an unpinned ledger's approval rows ` +
              `are attested by nothing outside the artifact graph, so appending a ` +
              `new head or renaming a ledger file would silently release the ` +
              `chain. If this ledger was just appended, add its entry to ` +
              `TRACKED_LEDGER_APPROVAL_PINS in src/readiness/ledger-pins.ts in ` +
              `the same change. If the FILE was renamed, restore the filename — ` +
              `the pinned rows are unchanged by a rename.`,
          });
          continue;
        }
        pinnedPathsPresent.add(relPath);

        // ── rule C ──────────────────────────────────────────────────────────
        const parsed = CheckpointApprovals.safeParse(ledger.data);
        if (!parsed.success) continue; // schema errors already recorded
        const actual = ledgerApprovalRowsDigest(parsed.data.approvals);
        if (actual !== pin) {
          // FAIL CLOSED ON CLOSURE, NOT JUST ON `ok`. If a pinned ledger's rows
          // are not the pinned rows, nothing in that ledger is authoritative — an
          // arbitrary edit could have added a role, moved an actor, or dated a
          // decision. So no checkpoint may report "closed" and the C2 externality
          // caveat (emitted only on closure) must not be raised either. Without
          // this, the gate printed `ok: false` beside `✓ C2: closed`, which is the
          // contradictory shape this branch is fixing elsewhere.
          ledgerRowsAuthoritative = false;
          issues.push({
            code: "ledger-approval-pin-mismatch",
            artifactId,
            path: relPath,
            // Names the file, the artifact and the digests only. Never echoes an
            // approval's contents — an approval carries actor ids and rationale
            // prose.
            message:
              `approval rows of ledger file ${relPath} (${artifactId}) do not ` +
              `match their source pin (expected ${pin}, got ${actual}). The rows ` +
              `were changed in place; the chain only permits growth by APPENDING ` +
              `a successor ledger. See TRACKED_LEDGER_APPROVAL_PINS in ` +
              `src/readiness/ledger-pins.ts.`,
          });
        }
      }

      // ── rule B ────────────────────────────────────────────────────────────
      // The direction the earlier revision omitted. A pinned path with no
      // parsed file behind it means the ledger was deleted, renamed, or failed
      // to parse — in every case its approval rows are no longer in the graph,
      // and the governance record the pin exists to preserve is gone.
      for (const pinnedPath of Object.keys(approvalRowPins).sort()) {
        if (pinnedPathsPresent.has(pinnedPath)) continue;
        ledgerRowsAuthoritative = false;
        issues.push({
          code: "ledger-approval-pin-absent",
          path: pinnedPath,
          message:
            `pinned ledger file ${pinnedPath} is not present as a parsed ` +
            `checkpoint-approvals artifact under the artifact root. A pinned ` +
            `ledger may never be deleted or renamed: the chain's approval record ` +
            `is the governance record, and removing the file removes the rows ` +
            `that hold a checkpoint open. Restore the file. Retiring a pin is a ` +
            `deliberate source change to TRACKED_LEDGER_APPROVAL_PINS in ` +
            `src/readiness/ledger-pins.ts and must be reviewed as one.`,
        });
      }
    }

    // C2's public evidence manifest contains only hashes and repo-relative
    // paths. In private mode, resolve those paths and verify the underlying
    // ignored evidence bytes before any C2 approval can contribute to closure.
    verifyPrivateC2Evidence(artifacts, opts, issues);

    // 8. Approvals and checkpoint closure
    //
    // Gated on a resolved ledger head AND a resolved registry head, which also
    // gates the two temporal provenance invariants inside. That gating is
    // intended and fail-closed: without a resolved registry there is no
    // authoritative actor list, so no approval can be validated and no
    // checkpoint can be marked closed (checkpointStatus defaults to "open").
    //
    // A ledger with no resolvable registry head is reported here as
    // `missing-registry`. `selectChain` returns no issues for an EMPTY family
    // (chains.ts), so an artifact graph carrying an index and a ledger full of
    // approvals but no registry artifact would otherwise produce zero issues:
    // `ok: true` and exit code 0 with every approval uninspected. Emitting the
    // signal keeps the skip fail-closed on `ok` as well as on checkpointStatus.
    if (ledgerEntry && !registry) {
      issues.push({
        code: "missing-registry",
        artifactId: String(ledgerEntry.data.artifactId),
        message:
          "approval ledger present but no approval-actor-registry chain head resolved; no approval can be validated and no checkpoint can close",
      });
    }
    if (ledgerEntry && registry) {
      validateApprovalsAndCheckpoint(
        ledgerEntry,
        chains.registryByVersion,
        implementationActorIds,
        artifacts,
        absRoot,
        opts,
        issues,
        checkpointStatus,
        warnings,
        ledgerRowsAuthoritative,
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
          // NO `checkpoint` AND NO `artifactId`, DELIBERATELY, AND ADDING EITHER
          // WOULD BE INERT HERE. This is the commonest finding on a clean clone
          // (`corpus/entries.json` is gitignored) and it is fully unattributable,
          // so under the closure gate's widening it would hold EVERY checkpoint
          // open — including C0 and C1, which nothing in the run impeaches. It
          // does not, because this is step 9: closure was already computed by
          // step 8's `validateApprovalsAndCheckpoint`, so this row moves `ok` and
          // the exit code and holds no checkpoint open. Measured on a clean
          // worktree, private mode: as-is `{C0 closed, C1 closed, C2 open}`; the
          // identical unattributed row pushed before step 8 instead gives
          // `{C0 open, C1 open, C2 open}`.
          //
          // So do not "fix" the missing attribution: a `checkpoint` field added
          // here changes nothing (the map it would feed is already final), and
          // `"C2"` would be the wrong value anyway — the corpus is a Phase-0
          // input, bound by `phase0-summary.corpusSha256`, and no C2 record
          // mentions it. If this check ever MOVES ahead of step 8, it must carry
          // a truthful attribution at that point or it will reopen C0 and C1 on
          // every clean clone. The same caveat covers `config-error`,
          // `corpus-hash-mismatch`, `corpus-count-mismatch` and the private-mode
          // `leak`; see the attribution block in `validateApprovalsAndCheckpoint`.
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
    warnings,
    ledgerPinScope,
  };
}

/**
 * Production schemas for each C2 evidence artifactType the private readiness
 * validator may encounter. Used to schema-validate referenced evidence files
 * in addition to the hash + identity checks — a well-hashed but structurally
 * invalid payload must still be rejected. Types without a dedicated production
 * schema. The registry is intentionally closed over every C2 artifact type
 * currently accepted by the private evidence manifest.
 */
export const C2_EVIDENCE_SCHEMAS: Readonly<Record<string, z.ZodType>> = {
  "c2-label-integrity-selection": C2LabelIntegritySelectionSchema,
  "c2-independent-label-submission": C2IndependentLabelSubmissionSchema,
  "c2-label-integrity-baseline-metrics": C2LabelIntegrityBaselineMetricsSchema,
  "c2-label-agreement-report": C2LabelAgreementReportSchema,
  "c2-label-agreement-adjudication": C2LabelAgreementAdjudicationSchema,
};

const REQUIRED_C2_EVIDENCE = [
  { artifactId: "c2-label-integrity-selection-v1", artifactType: "c2-label-integrity-selection", path: "eval/c2/label-integrity/selection.json" },
  { artifactId: "c2-submission-reviewer-gold-v1", artifactType: "c2-independent-label-submission", path: "eval/c2/label-integrity/parent-evidence/reviewer-gold-pass3.json" },
  { artifactId: "c2-submission-reviewer-qa-v1", artifactType: "c2-independent-label-submission", path: "eval/c2/label-integrity/parent-evidence/reviewer-qa-pass3.json" },
  { artifactId: "c2-parent-baseline-reviewer-gold-v1", artifactType: "c2-independent-label-submission", path: "eval/c2/label-integrity/parent-evidence/reviewer-gold.json" },
  { artifactId: "c2-parent-baseline-reviewer-qa-v1", artifactType: "c2-independent-label-submission", path: "eval/c2/label-integrity/parent-evidence/reviewer-qa.json" },
  { artifactId: "c2-label-integrity-baseline-metrics-v1", artifactType: "c2-label-integrity-baseline-metrics", path: "eval/c2/label-integrity/baseline-metrics.json" },
  { artifactId: "c2-adjudication-v1", artifactType: "c2-label-agreement-adjudication", path: "eval/c2/label-integrity/adjudication.json" },
  { artifactId: "c2-label-agreement-report-v1", artifactType: "c2-label-agreement-report", path: "eval/c2/label-integrity/agreement-report.json" },
] as const;

type ResolvedC2Evidence = {
  ref: Record<string, string>;
  raw: Record<string, unknown>;
  path: string;
};

function sameC2Ref(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return a.artifactId === b.artifactId && (a.artifactType === undefined || a.artifactType === b.artifactType) && a.path === b.path && a.sha256 === b.sha256;
}

/**
 * Private-mode C2 evidence verification.
 *
 * EVERY FINDING THIS FUNCTION CAN EMIT CONCERNS C2, AND IS STAMPED `checkpoint:
 * "C2"` HERE RATHER THAN AT EACH PUSH SITE. That is deliberate and it is the fix
 * for a real regression: the inner checks key `artifactId` to the evidence
 * MANIFEST's id (`c2-evidence-v1`) or to an individual evidence artifact's id,
 * none of which closure attribution can resolve to a checkpoint. Left
 * unattributed they were fail-closed against every checkpoint, so a checkout
 * that simply does not carry the untracked private evidence (seven of the eight
 * declared paths live under `eval/`, which `.gitignore` excludes) reported
 * **C0 and C1 open** — checkpoints nothing in the run impeached.
 *
 * Stamping in one place instead of at the thirteen push sites makes the
 * attribution structural: a fourteenth check added inside this C2-only function
 * is attributed to C2 whether or not its author remembers to say so. The
 * collector below must therefore stay C2-only — if a non-C2 finding is ever
 * added to it, it must be pushed onto `issues` directly instead.
 */
function verifyPrivateC2Evidence(
  artifacts: Map<string, ParsedArtifact>,
  opts: ValidateReadinessOptions,
  issues: ValidationIssue[],
): void {
  if (opts.mode !== "private") return;
  const c2Issues: ValidationIssue[] = [];
  collectPrivateC2EvidenceIssues(artifacts, opts, c2Issues);
  for (const issue of c2Issues) issues.push({ ...issue, checkpoint: "C2" });
}

function collectPrivateC2EvidenceIssues(
  artifacts: Map<string, ParsedArtifact>,
  opts: ValidateReadinessOptions,
  issues: ValidationIssue[],
): void {
  const manifest = [...artifacts.values()].find(
    (entry) => entry.type === "c2-evidence-manifest",
  );
  if (!manifest) return;

  const repoRoot = realpathSync(resolve(opts.repoRoot ?? opts.artifactRoot));
  const evidence = (manifest.data.evidence as Array<Record<string, string>>) ?? [];
  const resolvedById = new Map<string, ResolvedC2Evidence>();
  // Duplicate detection runs BEFORE any file resolution, so it must use its own
  // seen-set. `resolvedById` is only populated further down (after hashing), so
  // consulting it here would make the duplicate-id check permanently dead —
  // mirror the sibling `seenPaths` pattern instead.
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  for (const ref of evidence) {
    if (seenIds.has(ref.artifactId)) {
      issues.push({ code: "c2-evidence-duplicate-id", artifactId: String(manifest.data.artifactId), path: ref.path, message: `C2 evidence artifactId is duplicated: ${ref.artifactId}` });
    }
    seenIds.add(ref.artifactId);
    if (seenPaths.has(ref.path)) {
      issues.push({ code: "c2-evidence-duplicate-path", artifactId: String(manifest.data.artifactId), path: ref.path, message: `C2 evidence path is duplicated: ${ref.path}` });
    }
    seenPaths.add(ref.path);
  }
  if (evidence.length !== REQUIRED_C2_EVIDENCE.length) {
    issues.push({ code: "c2-evidence-set-mismatch", artifactId: String(manifest.data.artifactId), message: `C2 evidence manifest must contain exactly ${REQUIRED_C2_EVIDENCE.length} evidence rows` });
  }
  for (const expected of REQUIRED_C2_EVIDENCE) {
    const matches = evidence.filter((ref) => ref.artifactId === expected.artifactId);
    if (matches.length !== 1 || matches[0]?.artifactType !== expected.artifactType || matches[0]?.path !== expected.path) {
      issues.push({ code: "c2-evidence-set-mismatch", artifactId: String(manifest.data.artifactId), path: expected.path, message: `C2 evidence manifest is missing or misbinding ${expected.artifactId}` });
    }
  }
  for (const ref of evidence) {
    const relativePath = ref.path;
    const filePath = resolve(repoRoot, relativePath);
    const relativeToRoot = relative(repoRoot, filePath);
    if (
      relativeToRoot.startsWith(".." + sep) ||
      relativeToRoot === ".." ||
      relativeToRoot.startsWith(sep)
    ) {
      issues.push({
        code: "c2-evidence-path-escape",
        artifactId: String(manifest.data.artifactId),
        path: relativePath,
        message: `C2 evidence path escapes the repository root: ${relativePath}`,
      });
      continue;
    }

    try {
      const realPath = realpathSync(filePath);
      const realRelative = relative(repoRoot, realPath);
      if (
        realRelative.startsWith(".." + sep) ||
        realRelative === ".." ||
        realRelative.startsWith(sep)
      ) {
        throw new Error("resolved path escapes repository root");
      }
      const actualSha = fileSha256(realPath);
      if (actualSha !== ref.sha256) {
        issues.push({
          code: "c2-evidence-hash-mismatch",
          artifactId: String(manifest.data.artifactId),
          path: relativePath,
          message: `C2 evidence ${relativePath} hash ${actualSha} does not match manifest ${ref.sha256}`,
        });
        continue;
      }
      const raw = JSON.parse(readFileSync(realPath, "utf-8")) as Record<string, unknown>;
      if (raw.artifactId !== ref.artifactId || raw.artifactType !== ref.artifactType) {
        issues.push({
          code: "c2-evidence-identity-mismatch",
          artifactId: String(manifest.data.artifactId),
          path: relativePath,
          message: `C2 evidence ${relativePath} identity does not match ${ref.artifactId}/${ref.artifactType}`,
        });
      }
      // Schema validation: parse the artifact through its production schema so a
      // structurally malformed submission/baseline/agreement with the right
      // hash + identity fields is still rejected. Hash + identity checks are
      // necessary but not sufficient — they cannot catch a well-hashed but
      // schema-invalid payload.
      const schemaForType = C2_EVIDENCE_SCHEMAS[ref.artifactType];
      let parsed = raw;
      if (schemaForType) {
        const schemaResult = schemaForType.safeParse(raw);
        if (!schemaResult.success) {
          const firstIssue = schemaResult.error.issues[0];
          const at = firstIssue ? firstIssue.path.join(".") || "(root)" : "(root)";
          issues.push({
            code: "c2-evidence-schema-invalid",
            artifactId: String(manifest.data.artifactId),
            path: relativePath,
            message: `C2 evidence ${relativePath} (${ref.artifactType}) failed schema validation at ${at}: ${firstIssue?.message ?? "unknown"}`,
          });
        } else {
          parsed = schemaResult.data as Record<string, unknown>;
        }
      }
      resolvedById.set(ref.artifactId, { ref, raw: parsed, path: relativePath });
    } catch (error) {
      issues.push({
        code: "c2-evidence-unavailable",
        artifactId: String(manifest.data.artifactId),
        path: relativePath,
        message: `cannot resolve C2 evidence ${relativePath}: ${(error as Error).message}`,
      });
    }
  }

  const manifestRef = (artifactId: string): Record<string, unknown> | undefined => resolvedById.get(artifactId)?.ref;
  const requireManifestRef = (owner: string, nested: unknown): void => {
    if (!nested || typeof nested !== "object") {
      issues.push({ code: "c2-evidence-nested-ref-invalid", artifactId: owner, message: "nested C2 evidence reference is not an object" });
      return;
    }
    const nestedRef = nested as Record<string, unknown>;
    const bound = manifestRef(String(nestedRef.artifactId));
    if (!bound || !sameC2Ref(nestedRef, bound)) {
      issues.push({ code: "c2-evidence-nested-ref-unbound", artifactId: owner, message: `nested C2 evidence reference is not exactly bound in the manifest: ${String(nestedRef.artifactId)}` });
    }
  };

  const baseline = resolvedById.get("c2-label-integrity-baseline-metrics-v1")?.raw;
  if (baseline && Array.isArray(baseline.sourceArtifactRefs)) {
    for (const sourceRef of baseline.sourceArtifactRefs) {
      requireManifestRef("c2-label-integrity-baseline-metrics-v1", sourceRef);
      const sourceId = typeof sourceRef === "object" && sourceRef !== null ? String((sourceRef as Record<string, unknown>).artifactId) : "";
      if (!sourceId.startsWith("c2-parent-baseline-")) {
        issues.push({ code: "c2-baseline-source-not-parent", artifactId: "c2-label-integrity-baseline-metrics-v1", message: `baseline metric source must be parent-authority evidence: ${sourceId}` });
      }
    }
  }

  const agreement = resolvedById.get("c2-label-agreement-report-v1")?.raw;
  if (agreement) {
    for (const key of ["selectionRef", "goldOwnerSubmissionRef", "qaSubmissionRef", "baselineMetricsRef", "adjudicationRef"]) {
      requireManifestRef("c2-label-agreement-report-v1", agreement[key]);
    }
  }
  const adjudication = resolvedById.get("c2-adjudication-v1")?.raw;
  if (adjudication && agreement) {
    if (adjudication.goldOwnerSubmissionArtifactId !== (agreement.goldOwnerSubmissionRef as Record<string, unknown>)?.artifactId || adjudication.qaSubmissionArtifactId !== (agreement.qaSubmissionRef as Record<string, unknown>)?.artifactId) {
      issues.push({ code: "c2-adjudication-submissions-mismatch", artifactId: "c2-adjudication-v1", message: "adjudication submissions do not match the agreement report" });
    }
  }
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
  registryByVersion: ReadonlyMap<string, ParsedArtifact>,
  implementationActorIds: Set<string>,
  artifacts: Map<string, ParsedArtifact>,
  absRoot: string,
  opts: ValidateReadinessOptions,
  issues: ValidationIssue[],
  checkpointStatus: Record<string, "open" | "closed">,
  warnings: ValidationIssue[],
  /**
   * False when step 7c found the ledger pins unsatisfied in ANY of its three
   * directions: a pinned ledger's approval rows changed in place
   * (`ledger-approval-pin-mismatch`), a ledger file with no pin
   * (`ledger-approval-pin-missing`), or a pinned path with no file behind it
   * (`ledger-approval-pin-absent`). Approval validation still runs — the
   * diagnostics are worth having — but no checkpoint may close on a chain whose
   * rows are not the attested rows, whose membership is not the attested
   * membership, or which is missing a ledger outright.
   */
  ledgerRowsAuthoritative: boolean,
): void {
  const ledgerData = CheckpointApprovals.safeParse(ledgerEntry.data);
  if (!ledgerData.success) {
    // Schema error already recorded
    return;
  }

  const approvals = ledgerData.data.approvals;
  // Partition the mixed ledger once: approval semantics (supersession, actor/
  // role checks, closure) iterate ONLY `approvalRows`. `approvals` itself stays
  // available and MUST keep being read, unpartitioned, by tamper-evidence
  // (`validateLedgerAppendOnly`, `ledgerApprovalRowsDigest`) elsewhere in this
  // file — those verify the full mixed row sequence, not just approval rows.
  // No retraction rows exist in any real or test ledger yet, so at runtime
  // `approvalRows` is exactly `approvals` and `retractionRows` is empty; this
  // is a pure refactor with no behavior change.
  const approvalRows = approvals.filter(isApprovalRow);
  const retractionRows: CheckpointRetractionT[] = approvals.filter(isRetractionRow);
  // Classifies retraction validity and returns the ids cleared by a VALID
  // retraction. Consumed below (Task 4): a validly-retracted id is excluded
  // from the effective approval set (`activeApprovals`) and suppresses the two
  // temporal findings (`ledger-supersession-not-later`,
  // `approved-artifact-created-after-decision`) for THAT approval only. An
  // INVALID retraction (unauthorized/missing/out-of-order/duplicate) is never
  // added to this set, so it has no effect on closure — both temporal findings
  // still fire and the approval stays in the effective set, fail-closed.
  const retractedApprovalIds = computeRetractedApprovalIds(
    approvals,
    retractionRows,
    registryByVersion,
    issues,
  );
  // Approvals that a later, later-decided approval supersedes. Computed from
  // every approval row's own `supersedesApprovalId` over `approvalRows` — a
  // retraction row never touches this set. THIS IS INTENTIONAL AND IS MODEL B:
  // retracting a SUPERSEDER does not remove its `supersedesApprovalId`
  // contribution, so the predecessor it superseded stays superseded even after
  // the superseder is validly retracted. A retraction can only ever REMOVE an
  // approval from the effective set (via `retractedApprovalIds` below); it must
  // never ADD one back, i.e. never resurrect a superseded approval. Do not
  // "fix" this by deleting a retracted superseder's contribution to this set.
  const supersededApprovalIds = new Set(
    approvalRows.flatMap((approval) => approval.supersedesApprovalId ? [approval.supersedesApprovalId] : []),
  );

  // Per-approval set of issue codes that this approval produced. An approval
  // with any issue cannot contribute to closure. Declared BEFORE the provenance
  // checks below so they can taint an approval: a checkpoint must never report
  // "closed" on the strength of an approval whose provenance is invalid.
  const approvalIssueCodes = new Map<string, Set<string>>();
  const noteApprovalIssue = (approvalId: string, code: string) => {
    let set = approvalIssueCodes.get(approvalId);
    if (!set) {
      set = new Set();
      approvalIssueCodes.set(approvalId, set);
    }
    set.add(code);
  };

  // NOTE ON TAINTING: `ledger-supersession-not-later` (the temporal check
  // below) always pushes a BLOCKING issue and always taints its approval via
  // `noteApprovalIssue`, whether or not that approval has itself been
  // superseded — see the block comment at the check for why the finding is
  // unconditional and what the accepted consequence is.
  // The two structural `ledger-invalid-supersession` pushes still do NOT call
  // `noteApprovalIssue` — pre-existing behaviour, deliberately left unchanged
  // here so the taint semantics are not widened without a decision. They no
  // longer leave a checkpoint reporting "closed", though: the closure gate below
  // reads the ISSUE LIST as well as the taint map, so any blocking finding keyed
  // to a checkpoint-kind approval of a checkpoint holds that checkpoint open
  // whether or not the emitting check remembered to taint. See
  // `checkpointHasBlockingIssue`. Hole 1 of TODOS.md § "Approval provenance holes
  // the content-only validator cannot close" describes the taint-map gap that
  // remains.
  for (const approval of approvalRows) {
    if (approval.supersedesApprovalId !== undefined) {
      const priorIndex = approvalRows.findIndex((candidate) => candidate.approvalId === approval.supersedesApprovalId);
      const currentIndex = approvalRows.indexOf(approval);
      if (priorIndex < 0 || priorIndex >= currentIndex) {
        issues.push({ code: "ledger-invalid-supersession", artifactId: approval.approvalId, message: `approval ${approval.approvalId} supersedes a missing or later approval` });
      } else {
        const prior = approvalRows[priorIndex]!;
        if (prior.checkpoint !== approval.checkpoint || prior.role !== approval.role || prior.actorId !== approval.actorId) {
          issues.push({ code: "ledger-invalid-supersession", artifactId: approval.approvalId, message: `approval ${approval.approvalId} must supersede an earlier approval for the same checkpoint, role, and actor` });
        }
        // Temporal invariant: a replacement decision must be made STRICTLY
        // LATER than the decision it replaces. A successor that copies (or
        // predates) the superseded `decidedAt` while binding a different
        // target claims a decision was taken before the thing it decides
        // existed — ledger position alone cannot detect that.
        //
        // THE FINDING IS UNCONDITIONAL AND BLOCKING — DO NOT SCOPE IT.
        //
        // An earlier revision demoted this to a non-blocking warning once the
        // defective record had itself been superseded, so that a later valid
        // decision could restore a green gate. That was a fail-open hole and was
        // reproduced end-to-end: a superseding record only has to be strictly
        // LATER than the record it corrects (one millisecond suffices), and
        // `createdAt` is self-declared, so the sibling invariant
        // `approved-artifact-created-after-decision` cannot backstop a stale
        // `createdAt` (both `index-c1-v3` and `c2-evidence-v1` declare
        // 2026-07-26T20:15:01.000Z for bytes first written 2026-07-28).
        // Appending one fabricated record dated a second after the bad one
        // flipped the real gate from `ok: false` to `ok: true`, `issues: []`,
        // C2 closed — the defect surviving only as a warning. Reducing the cost
        // of hiding a governance defect from "edit a source constant in a
        // reviewable diff" to "append one record" destroys the whole value of the
        // invariant, which is to be a durable record that something went wrong.
        // ("Durable" is qualified precisely below — it does not mean unfakeable.)
        //
        // THE CONSEQUENCE IS ACCEPTED, NOT WORKED AROUND, AND WHAT ENFORCES IT
        // IS NARROWER THAN AN EARLIER REVISION OF THIS COMMENT CLAIMED. Two
        // mechanisms together keep the finding standing, and each covers a
        // different edit:
        //
        //  - A SUCCESSOR LEDGER cannot drop or rewrite the defective record.
        //    `validateLedgerAppendOnly` (contracts.ts) requires every prior
        //    approval to survive as an unchanged PREFIX of its successor, so a
        //    v(n+1) that omits it emits `ledger-approval-deleted` and a forked
        //    ordinal emits `chain-duplicate-key` / `chain-fork` /
        //    `chain-multiple-heads`.
        //  - AN IN-PLACE EDIT OF A TRACKED LEDGER'S OWN ROWS is caught by the
        //    approval-row pins in `ledger-pins.ts` (step 7c of
        //    `validateReadinessArtifacts`). They have to exist, because
        //    `validateLedgerAppendOnly` iterates the PREDECESSOR's approvals: the
        //    head's appended suffix is compared against nothing until a successor
        //    pins it. Before the pins existed, editing two `decidedAt` fields in
        //    `checkpoint-approvals-v5.json` turned this gate green — verified end
        //    to end. Do not describe the append-only check alone as making this
        //    finding un-editable; it does not.
        //  - A RENAMED LEDGER, A DELETED LEDGER OR AN UNPINNED NEW HEAD is caught
        //    by step 7c's two COVERAGE directions. Both were fail-open holes and
        //    both were reproduced. When the pin was looked up by the ledger's own
        //    `artifactId`, renaming the head skipped the pin and the same two
        //    edits produced `ok: true` with C0/C1/C2 closed and zero issues; and
        //    when the chain was renamed WHOLESALE with the four
        //    `predecessor.sha256` values repaired in a loop, the added
        //    chain-coverage rule went inert and the result was the same. The pins
        //    are therefore keyed on the ledger's FILE PATH, which no edit inside
        //    the file can change. Separately, coverage that only iterated the
        //    chain never noticed a pin whose file was gone: `rm` of the three
        //    newest ledgers erased both blocking findings and produced `ok: true`
        //    with zero issues. Rule B (every pinned path must resolve to a parsed
        //    file) closes that direction.
        //
        // SO, PRECISELY — AND ONLY THIS: `ok: false` has been verified to survive
        // the specific attacks enumerated, with their before/after gate output, in
        // docs/c2/c2-checkpoint-approval-handoff.md and in the
        // `ledger-pins.ts` docblock. Nothing here claims durability against a
        // CLASS of attacks: every generalisation from a tested attack to a class
        // made on this control has so far been falsified by the next variant. It
        // is NOT durable against a change that also edits
        // `TRACKED_LEDGER_APPROVAL_PINS` in source; that remains
        // reviewable-in-diff rather than mechanically impossible, and
        // `ledger-pins.ts` says so plainly. Do not restate this as durability
        // against "any change confined to `quality-contracts/`" — that absolute
        // stood in this comment once and was falsified twice. Clearing this
        // finding requires a validly-authorized retraction record naming who
        // retracted what, when, and why — implemented (`computeRetractedApprovalIds`,
        // the `retraction-*` issue codes below), and exercised for real by
        // `checkpoint-approvals-v6.json`, which retracts the two defective C2 v2
        // approvals this way (see docs/c2/c2-checkpoint-approval-handoff.md and
        // docs/AGENT_READINESS_STATUS.md for the resulting, still-open C2 state).
        // Do NOT reintroduce a supersession- or severity-based escape hatch here
        // to clear a finding without a retraction record.
        //
        // CLOSURE AGREES WITH `ok` — this used to be a documented residual and no
        // longer is. The taint below lands on the defective record itself, and
        // checkpoint CLOSURE is computed over the effective approval set
        // (`activeApprovals`), so a SUPERSEDED defect once left `checkpointStatus`
        // reading "closed" beside a blocking issue and exit 1. Closure is now
        // additionally gated on the checkpoint carrying no blocking issue on ANY
        // of its approvals (see `checkpointHasBlockingIssue` below), so a
        // temporal defect holds its checkpoint open whether or not something
        // supersedes it. `ok` is still the value CI and the review hooks consume;
        // `checkpointStatus` no longer contradicts it.
        //
        // The sibling invariant `approved-artifact-created-after-decision`
        // (`verifyApprovalArtifactTimestamps`) is unconditional in the same way,
        // for the same reason. The two are deliberately consistent; if you are
        // about to scope either one, read this comment first.
        //
        // Task 4 adds exactly ONE gate on top of the above, and it is NOT a
        // supersession-based demotion: a VALID retraction (the approval's id is
        // in `retractedApprovalIds`, i.e. an authorized Repository Maintainer
        // retraction that named it, in order, with no prior retraction) is the
        // sole way to suppress this finding. An INVALID retraction is never in
        // that set, so the finding still fires unconditionally exactly as
        // before — this is what keeps the invariant fail-closed.
        const priorDecidedAt = Date.parse(prior.decidedAt);
        const decidedAt = Date.parse(approval.decidedAt);
        if (
          Number.isFinite(priorDecidedAt) &&
          Number.isFinite(decidedAt) &&
          decidedAt <= priorDecidedAt
        ) {
          if (!retractedApprovalIds.has(approval.approvalId)) {
            issues.push({
              code: "ledger-supersession-not-later",
              artifactId: approval.approvalId,
              message: `approval ${approval.approvalId} decidedAt (${approval.decidedAt}) must be strictly later than superseded approval ${prior.approvalId} decidedAt (${prior.decidedAt})`,
            });
            // Taint the defective record. While it is still effective this is what
            // a checkpoint would close on, so the checkpoint reports "open".
            noteApprovalIssue(approval.approvalId, "ledger-supersession-not-later");
          }
        }
      }
    }
  }

  // Temporal invariant: an approval's decidedAt cannot precede the DECLARED
  // createdAt of an artifact version it binds. Applies to every approval
  // (including superseded ones, which remain historical evidence) and to every
  // checkpoint, independent of whether a recipe exists for it. The same pass
  // reports an ACTIVE approval whose bound row resolves to no on-disk artifact
  // version when its checkpoint has no recipe — the only place such a binding is
  // checked at all. See the function's docstring for exactly what this does and
  // does not detect.
  verifyApprovalArtifactTimestamps(
    approvalRows,
    artifacts,
    supersededApprovalIds,
    retractedApprovalIds,
    issues,
    noteApprovalIssue,
  );

  // ------------------------------------------------------------------
  // Git-bound recomputation of the canonical checkpoint target(s).
  // Only checkpoints with ACTIVE approvals are recomputed; recipes for
  // checkpoints with no approval are declared but skipped, so a future
  // checkpoint (e.g. C1) stays open without producing spurious issues
  // from unresolved sources.
  // ------------------------------------------------------------------
  // A validly-retracted approval is excluded here too — a retraction can only
  // ever REMOVE an approval from the effective set, same as supersession. See
  // the comment at `supersededApprovalIds` above for why retracting a
  // SUPERSEDER does not put its predecessor back in this set (Model B).
  const activeApprovals = approvalRows.filter(
    (approval) => !supersededApprovalIds.has(approval.approvalId) && !retractedApprovalIds.has(approval.approvalId),
  );
  const activeCheckpoints = new Set(activeApprovals.map((a) => a.checkpoint));
  const recompute = computeCanonicalTargets(artifacts, absRoot, opts, activeCheckpoints, activeApprovals, registryByVersion);

  // Each approval pins the exact registry version + digest it was issued
  // against. Retain the resolved registry for every approval so the actor-
  // cardinality check can consult each approval's own pinned registry rather
  // than only the chain head (a newer head that reverts governance mode must
  // not retroactively change an older approval's separation rules).
  const resolvedRegistryByApprovalId = new Map<
    string,
    z.infer<typeof ApprovalActorRegistry>
  >();

  // Track target SHAs per checkpoint (for divergent-target detection)
  const targetShas = new Map<string, Set<string>>();

  for (const approval of approvalRows) {
    const iid = approval.approvalId;
    const isSuperseded = supersededApprovalIds.has(iid);

    // Implementer cannot approve (checked first — independent of registry
    // resolution so all applicable errors are reported).
    if (implementationActorIds.has(approval.actorId)) {
      issues.push({
        code: "implementer-self-approval",
        artifactId: iid,
        message: `approval ${iid}: implementer ${approval.actorId} cannot approve`,
      });
      noteApprovalIssue(iid, "implementer-self-approval");
    }

    // Resolve the registry matching THIS approval's recorded version. Each
    // approval pins the exact registry version + digest it was issued
    // against; an older approval must resolve against its own version even
    // when a newer registry is the chain head.
    const resolvedRegistry = resolveApprovalRegistry(
      approval,
      registryByVersion,
      issues,
      noteApprovalIssue,
    );

    if (resolvedRegistry) {
      resolvedRegistryByApprovalId.set(iid, resolvedRegistry);
    }

    // Superseded approvals remain immutable historical evidence, but no longer
    // participate in target, role, or closure calculations. Their replacement
    // must be appended with an explicit supersedesApprovalId.
    if (isSuperseded) continue;

    // Actor existence / role / kind checks use the approval's resolved
    // registry. When the registry cannot be resolved we still run the
    // remaining recomputation/policy checks below; actor checks are skipped
    // only because there is no authoritative actor list to consult.
    if (resolvedRegistry) {
      const actorMap = new Map(resolvedRegistry.actors.map((a) => [a.actorId, a]));
      const actor = actorMap.get(approval.actorId);
      if (!actor) {
        issues.push({
          code: "actor-not-found",
          artifactId: iid,
          message: `approval ${iid}: actor ${approval.actorId} not in registry`,
        });
        noteApprovalIssue(iid, "actor-not-found");
      } else {
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
      }
    }

    // Git-bound recomputation checks. When a recipe exists for an ACTIVE
    // checkpoint, recomputation is MANDATORY and fail-closed: a resolved
    // target must compare against the approval, or — if resolution threw —
    // the approval is disqualified and the checkpoint cannot close. There
    // is no skip path; the resolver is required.
    const recipe = recompute.recipes[approval.checkpoint];
    const recomputeFailure = recompute.recomputeFailures.get(approval.checkpoint);
    if (recipe && activeCheckpoints.has(approval.checkpoint) && recomputeFailure !== undefined) {
      const code = recomputeFailure.code;
      issues.push({
        code,
        artifactId: iid,
        message: `approval ${iid}: checkpoint ${approval.checkpoint} target could not be recomputed (${recomputeFailure.message}); approval cannot contribute to closure`,
      });
      noteApprovalIssue(iid, code);
    } else if (recipe && activeCheckpoints.has(approval.checkpoint) && recompute.canonical[approval.checkpoint]) {
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

      // contractHashes per-key value match (set membership is enforced by the
      // closed-world policy check below).
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

      // approvedArtifacts must exactly equal the recipe artifact set.
      verifyApprovedArtifactSet(approval, recipe, artifacts, issues, noteApprovalIssue);

      // Closed-world policy: exact-set equality for every category against
      // the declared C0/C1 policy. Missing AND unexpected members are errors.
      verifyCheckpointPolicy(approval, recipe, artifacts, issues, noteApprovalIssue);
    }

    // Track target SHAs per checkpoint
    if (!targetShas.has(approval.checkpoint)) {
      targetShas.set(approval.checkpoint, new Set());
    }
    targetShas.get(approval.checkpoint)!.add(approval.checkpointTargetSha256);
  }

  // Check divergent targets. `checkpoint: cp` because the loop variable IS the
  // affected checkpoint and the message already names it — without the field the
  // finding was unattributable and held all six checkpoints open while naming
  // one. Not `artifactId: cp`: there is no artifact here.
  for (const [cp, shas] of targetShas) {
    if (shas.size > 1) {
      issues.push({
        code: "divergent-targets",
        checkpoint: cp,
        message: `checkpoint ${cp} has ${shas.size} different target SHAs`,
      });
    }
  }

  // Verify phase0-summary inputHashes against resolved historical bytes.
  verifySummaryInputHashes(artifacts, recompute, issues);

  // ─── ISSUE → CHECKPOINT ATTRIBUTION, AND WHAT HAPPENS WHEN IT FAILS ────────
  //
  // The closure gate below asks "does a blocking issue hold this checkpoint
  // open?". It used to answer that by matching `issue.artifactId` against the
  // checkpoint name or against a checkpoint-kind approvalId — and to treat every
  // other issue as blocking NOTHING. That is fail-OPEN, and it is not a
  // hypothetical: `issue.artifactId` is an ARTIFACT id for most checks
  // (`index-path-mismatch` carries the index row's artifactId,
  // `c2-evidence-unavailable` the evidence manifest's), some checks carry no
  // `artifactId` at all (`malformed-json`, `symlink`, `path-escape`, and until
  // this change `divergent-targets`), and none of those strings can ever equal "C2" or an
  // approvalId. So `checkpointStatus` could report `closed` for a checkpoint
  // whose own evidence the run had just failed to resolve, beside `ok: false`
  // and exit 1 — precisely the two-channel disagreement the block below this one
  // was written to eliminate, re-entering through the identifier space instead
  // of through supersession.
  //
  // The rule is now: an issue is ATTRIBUTABLE when it carries an explicit
  // `checkpoint` naming one of C0–C5, or when its `artifactId` names a
  // checkpoint, or names an approval in this ledger (in which case it is
  // attributed to that approval's checkpoint — regardless of `approvalKind`,
  // since a defect on a non-checkpoint-kind approval is still a defect in that
  // checkpoint's record; see the note on that at `checkpointHasBlockingIssue`).
  // Anything else is UNATTRIBUTABLE and holds EVERY checkpoint open. Fail-closed
  // by construction FOR ANY CHECK THAT RUNS BEFORE CLOSURE IS COMPUTED: such a
  // check, if it forgets to key its issue to a checkpoint, over-blocks instead of
  // under-blocking, and no allowlist of codes has to be maintained to keep that
  // true. THE BOUND IS REAL AND IS NOT CLOSED HERE: this snapshot is taken inside
  // `validateApprovalsAndCheckpoint`, and step 9's issues (`config-error`,
  // `corpus-hash-mismatch`, `corpus-count-mismatch`, the private-mode `leak`,
  // `corpus-unreadable`) are pushed AFTER that call returns, so they move `ok`
  // and hold no checkpoint open at all. That ordering predates this block; a
  // check placed after step 8 inherits the old fail-open behaviour and must key
  // its own attribution or be moved.
  //
  // WHY THE EXPLICIT `checkpoint` FIELD IS NEEDED AT ALL, i.e. why "unattributed
  // ⇒ block everything" is not sufficient on its own. Over-blocking is safe as a
  // DEFAULT but wrong as an OUTCOME wherever the precise checkpoint is already
  // known at the push site. The regression that forced this: `verifyPrivateC2Evidence`
  // keys its findings to the evidence manifest's artifactId, so on any checkout
  // lacking the untracked `eval/` evidence — which is every clean clone, seven of
  // the eight declared paths being gitignored — seven `c2-evidence-unavailable`
  // rows held **C0 and C1** open too. Measured on clean per-commit checkouts,
  // private mode, same ten issues in each: before the field, {C0 open, C1 open};
  // with it, {C0 closed, C1 closed, C2 open}, matching the tracked root and the
  // documented status. The field carries the attribution the emitting check
  // already had; `divergent-targets` is the same case (it names one checkpoint in
  // its own message and used to block six).
  //
  // THIS ONLY EVER HOLDS A CHECKPOINT OPEN. It cannot close one that was open,
  // so it cannot relax any gate. What it CAN do is stop a legitimate closure, so
  // it was checked against the real graph in BOTH modes and on a clean checkout
  // as well as a working tree carrying the untracked private evidence: the
  // tracked root's only two ledger issues are keyed to C2 approvalIds
  // (`ledger-supersession-not-later`), any `c2-evidence-*` findings are stamped
  // `checkpoint: "C2"`, so C0 and C1 close and only C2 is held open in every one
  // of those conditions. A copy at a non-tracked root, whose `index-path-mismatch`
  // findings are keyed to artifact ids and describe the whole graph, still
  // correctly holds every checkpoint open — the index there does not describe the
  // files being validated, so nothing about that graph is attested.
  //
  // SNAPSHOT SEMANTICS. The unattributable flag is computed from the issues that
  // exist BEFORE the per-checkpoint loop, so it does not depend on the order in
  // which checkpoints are visited. Every issue the loop itself pushes (the role
  // and actor-separation checks) is keyed to the checkpoint being examined, so
  // those are picked up by the in-loop attributable check instead.
  const CHECKPOINT_IDS: ReadonlySet<string> = new Set(["C0", "C1", "C2", "C3", "C4", "C5"]);
  const checkpointOfApprovalId = new Map<string, string>(
    approvalRows.map((a) => [a.approvalId, a.checkpoint]),
  );
  // An unrecognised `checkpoint` value is NOT an attribution: a typo'd "c2" must
  // over-block (unattributable ⇒ every checkpoint open) rather than attribute to
  // a checkpoint that does not exist and so hold nothing open.
  const isAttributableToACheckpoint = (issue: ValidationIssue): boolean =>
    (issue.checkpoint !== undefined && CHECKPOINT_IDS.has(issue.checkpoint)) ||
    (issue.artifactId !== undefined &&
      (CHECKPOINT_IDS.has(issue.artifactId) || checkpointOfApprovalId.has(issue.artifactId)));
  const hasUnattributableBlockingIssue = issues.some((i) => !isAttributableToACheckpoint(i));

  // Determine checkpoint closure for C0–C5. Only approvals that are
  // (decision:"approved" + approvalKind:"checkpoint") AND produced no issue
  // can contribute to closure. For policy-backed checkpoints (C0/C1) the
  // required roles come from CHECKPOINT_POLICIES and the approved-role set is
  // itself closed-world (extra roles are rejected); future checkpoints use
  // the FUTURE_CHECKPOINT_ROLES table with the legacy presence-only check.
  for (const cp of ["C0", "C1", "C2", "C3", "C4", "C5"]) {
    const policy = CHECKPOINT_POLICIES[cp as keyof typeof CHECKPOINT_POLICIES];
    const required = policy ? policy.requiredRoles : (FUTURE_CHECKPOINT_ROLES[cp] || []);

    // ALL approved checkpoint-kind approvals for this checkpoint — used for
    // the closed-world role-set check (duplicates/extras are structural and
    // must be visible even when an approval is tainted by another issue).
    const allCpApproved = activeApprovals.filter(
      (a) =>
        a.checkpoint === cp &&
        a.decision === "approved" &&
        a.approvalKind === "checkpoint",
    );
    const allRoles = allCpApproved.map((a) => a.role);

    // Closed-world role check for policy-backed checkpoints WITH approvals.
    // When a checkpoint has no approvals it stays open silently (the future-
    // checkpoint invariant: e.g. C1 unresolved until a C1 approval appears).
    // When approvals exist, the approved role multiset must exactly equal the
    // required set (no missing, no extra, no duplicates); comparePolicySet
    // records any mismatch and taints the checkpoint's approvals.
    if (policy && allCpApproved.length > 0) {
      comparePolicySet(
        cp,
        "role",
        required,
        allRoles,
        issues,
        (id, code) => {
          // Attach to the checkpoint (not a single approval); mark every
          // approval of this checkpoint as tainted so closure is blocked.
          for (const a of allCpApproved) noteApprovalIssue(a.approvalId, code);
          void id;
        },
      );
    }

    // Closure contribution: only approvals that produced NO issue. Re-derive
    // the clean set AFTER the role check may have tainted approvals.
    const cpApprovals = allCpApproved.filter(
      (a) => !approvalIssueCodes.has(a.approvalId),
    );
    const cleanRoles = new Set<string>(cpApprovals.map((a) => a.role));

    const allRolesPresent = required.every((r) => cleanRoles.has(r));

    // Actor separation is enforced per approval against its OWN pinned registry.
    // Distinct actors always satisfy separation; a single shared actor is valid
    // only when every contributing approval's pinned registry declares
    // sole-maintainer-bootstrap with that actor as the human owner.
    const actorCardinalityValid = approvalsSatisfyActorCardinality(
      cpApprovals,
      resolvedRegistryByApprovalId,
      implementationActorIds,
    );

    if (allRolesPresent && cpApprovals.length > 0 && !actorCardinalityValid) {
      const code = "checkpoint-actor-separation-violation";
      issues.push({
        code,
        artifactId: cp,
        message: `checkpoint ${cp} approvals do not satisfy the actor-separation mode of their pinned registries`,
      });
      for (const approval of cpApprovals) {
        noteApprovalIssue(approval.approvalId, code);
      }
    }

    // ─── A CHECKPOINT CARRYING A BLOCKING PROVENANCE ISSUE CANNOT CLOSE ───────
    //
    // Closure is computed over the EFFECTIVE approval set (`activeApprovals`),
    // and `approvalIssueCodes` is consulted only for those. A blocking issue on
    // a SUPERSEDED approval therefore used to leave `checkpointStatus[cp]`
    // reading "closed" while `ok` was false — and the repository's own
    // documented C2 remediation (append a successor ledger whose new records are
    // dated later than the defective ones) produces exactly that shape. A
    // consumer reading `checkpointStatus` instead of `ok` was told the checkpoint
    // was closed while the gate failed, and the C2 externality caveat was
    // re-raised at the same time.
    //
    // The two channels now agree by construction: any approval of this
    // checkpoint that produced a blocking issue holds the checkpoint open,
    // whether or not something later supersedes it. This can only ever hold a
    // checkpoint OPEN — it never closes one that was open before, so it cannot
    // relax any gate. `ok` remains the value CI and the review hooks consume;
    // `checkpointStatus` is now safe to read alongside it rather than instead of
    // it.
    // Two sources, because tainting and issue-emission are not the same set.
    // `approvalIssueCodes` is what the per-approval checks record; the issue list
    // additionally carries blocking findings that push WITHOUT tainting — the two
    // structural `ledger-invalid-supersession` pushes are the live example, and
    // any future check that forgets to taint would be covered here too. Reading
    // the issue list makes the invariant hold by construction rather than by
    // every author remembering to call `noteApprovalIssue`.
    //
    // Snapshotting here (inside the per-checkpoint loop) is deliberate: every
    // per-approval check has already run by the time this loop starts, and this
    // checkpoint's own role check has already pushed above.
    const blockingIssueArtifactIds = new Set(
      issues.map((i) => i.artifactId).filter((id): id is string => id !== undefined),
    );
    // Four ways this checkpoint is held open by a blocking issue:
    //   1. an issue this run could not attribute to ANY checkpoint (see the
    //      attribution block above the loop) — fail-closed, holds every
    //      checkpoint open;
    //   2. an issue that explicitly names this checkpoint;
    //   3. an issue keyed to this checkpoint's own name via `artifactId`;
    //   4. an issue keyed to, or a taint recorded against, one of this
    //      checkpoint's approvals.
    //
    // WHY (4)'s ISSUE-KEYED BRANCH DOES NOT REQUIRE `approvalKind === "checkpoint"`,
    // AND MUST NOT. `checkpointOfApprovalId` above is built from ALL approvals
    // regardless of kind, so an issue keyed to an `artifact-review` approval's
    // approvalId is classified ATTRIBUTABLE and is therefore excluded from
    // `hasUnattributableBlockingIssue`. If this branch then filtered on
    // `approvalKind === "checkpoint"`, that issue would hold NO checkpoint open at
    // all — the exact fail-open this block exists to close, re-entering through
    // the kind space instead of the identifier space. The two predicates have to
    // agree on which approvals count, and they do. None of the per-approval
    // checks gate on `approvalKind`, so an `artifact-review` row can and does
    // produce blocking findings; a defect in one is a defect in that checkpoint's
    // record. The taint-only branch still requires checkpoint kind: a taint with
    // no accompanying issue keyed to the approval cannot be attributed from the
    // issue list, and narrowing it is the conservative half of this pair.
    const checkpointHasBlockingIssue =
      hasUnattributableBlockingIssue ||
      issues.some((i) => i.checkpoint === cp) ||
      blockingIssueArtifactIds.has(cp) ||
      approvalRows.some(
        (a) =>
          a.checkpoint === cp &&
          (blockingIssueArtifactIds.has(a.approvalId) ||
            (a.approvalKind === "checkpoint" && approvalIssueCodes.has(a.approvalId))),
      );

    if (allRolesPresent && actorCardinalityValid && !checkpointHasBlockingIssue && ledgerRowsAuthoritative) {
      checkpointStatus[cp] = "closed";
      // C2 externality caveat: the validator enforces distinct actor IDs and
      // that the QA actor is not an implementation actor, but it CANNOT verify
      // that the QA actor ID corresponds to a genuinely external human (the
      // design spec requires "QA approval by an external human who is
      // registered truthfully"). A sole operator can create two distinct human
      // actor IDs and obtain C2 closure. Surface this as a warning so the
      // readiness report is honest about the limit rather than silently
      // asserting externality the validator never checked. The check still
      // PASSES — externality must be established out-of-band (signed
      // attestations, distinct GitHub accounts, etc.; see TODOS.md).
      if (cp === "C2") {
        warnings.push({
          code: "c2-external-qa-unverifiable",
          message:
            "C2 closure assumes the QA reviewer actor ID is a genuinely external human. The validator enforces distinct, non-implementation actors but cannot verify externality; it must be established out-of-band (e.g. distinct signed commit authors, distinct GitHub accounts, or a signed attestation).",
        });
      }
    }
  }
}

/**
 * Classify each retraction row as VALID or INVALID and return the set of
 * approvalIds cleared by a valid retraction. This does NOT change closure
 * (Task 4 consumes the returned set); it only classifies retractions and
 * pushes one finding per invalid retraction.
 *
 * GOVERNING INVARIANT (fail-closed): a retraction only ever REMOVES an
 * approval. Any resolution failure — retractor not resolvable/authorized,
 * target missing, out-of-order, target-not-an-approval, duplicate — must NOT
 * add the target to the returned set.
 *
 * Ordering uses each row's index in the ORIGINAL mixed `allRows` array (a
 * retraction must follow the approval it names); `retractionRows` is the
 * pre-filtered subset (via `isRetractionRow`) supplying the rows to classify.
 *
 * Retractor authorization mirrors `resolveApprovalRegistry` exactly: resolve
 * the retraction's OWN pinned registry version, verify its content digest
 * (`entry.sha === retractedBy.actorRegistrySha256`), parse it as an
 * `ApprovalActorRegistry`, then require the named actor to be a `"human"`
 * with the `"Repository Maintainer"` role IN THAT REGISTRY — not merely on
 * the retraction row's self-declared `retractedBy.role`/`actorKind`, which is
 * an audit trail, not an authorization source.
 */
export function computeRetractedApprovalIds(
  allRows: LedgerRowT[],
  retractionRows: CheckpointRetractionT[],
  registryByVersion: ReadonlyMap<string, ParsedArtifact>,
  issues: ValidationIssue[],
): Set<string> {
  const retracted = new Set<string>();

  // First index of each approvalId in the mixed list.
  const approvalIndexById = new Map<string, number>();
  allRows.forEach((row, i) => {
    if (isApprovalRow(row) && !approvalIndexById.has(row.approvalId)) {
      approvalIndexById.set(row.approvalId, i);
    }
  });
  const retractionIndex = new Map<CheckpointRetractionT, number>();
  allRows.forEach((row, i) => {
    if (isRetractionRow(row)) retractionIndex.set(row, i);
  });

  const push = (code: string, targetId: string, message: string) =>
    issues.push({ code, artifactId: targetId, message });

  for (const r of retractionRows) {
    // FAIL-CLOSED GUARD (not a `!` non-null assertion): every real caller
    // passes `retractionRows` as a subset of `allRows` (production always
    // supplies `approvals.filter(isRetractionRow)`), so `retractionIndex` has
    // an entry for every row here today. But a `!` assertion would, for a
    // hypothetical retraction row absent from `allRows`, resolve `rIdx` to
    // `undefined` — and `targetApprovalIdx >= undefined` is always `false`,
    // silently passing the out-of-order check and adding the target to
    // `retracted` (fail-OPEN: an untethered retraction record could clear an
    // approval). Skip the row instead — it names no position in the ledger, so
    // it cannot be validated as in-order, and must not retract anything.
    const rIdx = retractionIndex.get(r);
    if (rIdx === undefined) continue;
    const targetId = r.retractsApprovalId;

    // Authorization: the actor must resolve in the retraction's OWN pinned
    // registry (version + sha256 verified) as a human authorized for
    // Repository Maintainer. Any resolution failure is fail-closed →
    // retraction-unauthorized (inert). This mirrors `resolveApprovalRegistry`
    // exactly, including its semantic pass (`validateRegistry`): a registry
    // that is schema-valid but semantically corrupt (bad governance-mode /
    // bootstrap-owner combination, a broken version chain) must not be
    // trusted to authorize a retraction just because it wasn't trusted to
    // authorize an approval — both paths share one notion of "a valid
    // registry".
    const entry = registryByVersion.get(r.retractedBy.actorRegistryVersion);
    const registry =
      entry && entry.sha === r.retractedBy.actorRegistrySha256
        ? ApprovalActorRegistry.safeParse(entry.data)
        : undefined;
    const registrySemanticallyValid =
      registry?.success === true && validateRegistry(registry.data).length === 0;
    const actor = registrySemanticallyValid
      ? registry.data.actors.find((a) => a.actorId === r.retractedBy.actorId)
      : undefined;
    if (!actor || actor.actorKind !== "human" || !actor.roles.includes("Repository Maintainer")) {
      push(
        "retraction-unauthorized",
        targetId,
        `retraction of ${targetId}: retractor ${r.retractedBy.actorId} is not an authorized human Repository Maintainer`,
      );
      continue;
    }

    // Classify the target: approval / retraction-row-or-self / absent.
    const targetApprovalIdx = approvalIndexById.get(targetId);
    if (targetApprovalIdx === undefined) {
      // targetId names an approvalId; if it instead matches a retractionId
      // (its own — self — or another retraction's), it is not an approval.
      const namesARetraction = allRows.some(
        (row) => isRetractionRow(row) && row.retractionId === targetId,
      );
      push(
        namesARetraction ? "retraction-target-not-approval" : "retraction-target-missing",
        targetId,
        `retraction ${r.retractionId} names ${targetId}, which is not an earlier approval row`,
      );
      continue;
    }
    if (targetApprovalIdx >= rIdx) {
      push(
        "retraction-out-of-order",
        targetId,
        `retraction of ${targetId} must follow the approval it retracts`,
      );
      continue;
    }
    if (retracted.has(targetId)) {
      push("retraction-duplicate", targetId, `duplicate retraction of ${targetId}`);
      continue;
    }
    retracted.add(targetId);
  }
  return retracted;
}

/**
 * Compare each approval's `decidedAt` against the DECLARED `createdAt` of every
 * artifact version it binds via `approvedArtifacts`, and emit
 * `approved-artifact-created-after-decision` when the decision precedes the
 * declared creation.
 *
 * ## What this detects
 *
 * Exactly one thing: a bound artifact whose own `createdAt` field claims a
 * creation time LATER than the approval's `decidedAt`, for the artifact version
 * the approval actually approved (`bound.sha256` must equal the on-disk bytes'
 * hash — see "resolution" below).
 *
 * ## What this does NOT detect — do not read this as target provenance
 *
 * - **A stale `createdAt`.** `createdAt` is self-declared, unverified content of
 *   the artifact. An artifact rewritten in a later commit without bumping
 *   `createdAt` still declares the old time, so an approval of the new bytes
 *   compares against a creation time that is not the real one and passes. This
 *   is not hypothetical: it is the shape of the very defect that motivated this
 *   invariant (`c2-*-v2` in `checkpoint-approvals-v5.json` bind bytes first
 *   written on 2026-07-28 while both artifacts still declare
 *   `createdAt: 2026-07-26T20:15:01.000Z`). That defect is caught ONLY by
 *   `ledger-supersession-not-later`, NOT by this check — which is precisely why
 *   that check is unconditional and blocking for every approval, superseded or
 *   not: it is the sole detector of this defect class, so a demotion there is
 *   backstopped by nothing here. An approval binding freshly-rewritten bytes
 *   with an unchanged `createdAt` and no supersession relation is caught by
 *   nothing at all.
 * - **`checkpointTargetSha256` provenance.** The origin time of a target hash is
 *   not derivable from artifact content at all; a target hash carries no
 *   timestamp and the artifacts it is computed over need not have been created
 *   when it was computed. This check never looks at
 *   `checkpointTargetSha256`. Establishing when a target hash first existed
 *   requires evidence outside the artifact graph (commit/authoring dates,
 *   signed attestations, a countersigned timestamp) and remains an open hole.
 *
 * Strengthening either of the above needs an out-of-band provenance source, so
 * it is deliberately out of scope for a content-only validator. Both are
 * tracked as hole 2 of TODOS.md § "Approval provenance holes the content-only
 * validator cannot close", which links back to this docstring.
 *
 * ## Resolution
 *
 * A bound row resolves ONLY when `bound.artifactId` names a parsed artifact AND
 * that artifact's hash equals `bound.sha256` — i.e. the on-disk bytes are the
 * version this approval approved. Comparing against a different version's
 * `createdAt` would be comparing against a document the approval never saw, and
 * would make a historically legitimate approval of an earlier version fail the
 * moment that artifact is rewritten with an honest, later `createdAt`.
 *
 * Rows that do not resolve — unknown `artifactId`, a `sha256` that is not the
 * on-disk version, a missing/unparseable `createdAt`, or an unparseable
 * `decidedAt` — are SKIPPED for the TEMPORAL comparison, because there is no
 * version-correct `createdAt` to compare against.
 *
 * ## Where an unresolvable binding IS reported
 *
 * Skipping the temporal comparison never leaves a broken binding unreported for
 * an ACTIVE approval:
 *
 * - **Checkpoint HAS a recipe (C0–C2).** `verifyApprovedArtifactSet` reports it:
 *   an id outside the recipe set as `approved-artifact-unknown`, a stale hash as
 *   `approved-artifact-hash-mismatch`. An id that IS in the recipe set but has no
 *   parsed artifact hits `if (!entry) continue;` there, and surfaces as
 *   `checkpoint-target-mismatch` instead — the recomputed target substitutes
 *   `sha256: ""` for the missing artifact. When recomputation itself failed, every
 *   approval of that checkpoint is disqualified by the recompute-failure code, so
 *   closure is blocked even though the individual row is not inspected. This
 *   function therefore does NOT re-report those rows: doing so would double-report.
 * - **Checkpoint has NO recipe (C3–C5).** Nothing downstream inspects the
 *   bindings at all: `verifyApprovedArtifactSet`, `verifyCheckpointPolicy` and
 *   target recomputation all sit behind `recipe && …`, and closure for these
 *   checkpoints goes through the presence-only `FUTURE_CHECKPOINT_ROLES` path.
 *   This function reports the row itself, as
 *   `approved-artifact-version-unresolved`, and taints the approval.
 *
 * SUPERSEDED approvals keep the plain skip in both cases. They are immutable
 * historical records that cannot contribute to closure, and the on-disk graph
 * has no way to reconstruct the version they bound, so the residual exposure is
 * a historical-record gap, not a closure gap. Tracked as hole 3 of TODOS.md
 * § "Approval provenance holes the content-only validator cannot close", which
 * links back to this docstring.
 *
 * ## Supersession scoping — what is and is not scoped, and why
 *
 * Two different decisions live in this function and they are deliberately
 * asymmetric:
 *
 * - `approved-artifact-created-after-decision` is UNCONDITIONAL WITH RESPECT TO
 *   SUPERSESSION. It runs over every approval, superseded or not, and always
 *   blocks and always taints. Task 4 adds exactly one further gate, shared with
 *   `ledger-supersession-not-later`: a VALID retraction (the approval's id is
 *   in `retractedApprovalIds`) suppresses this finding for that approval only.
 *   An INVALID retraction is never in that set, so the finding still fires
 *   exactly as before — see `computeRetractedApprovalIds`'s docstring for what
 *   makes a retraction valid. This is not the supersession-based demotion
 *   rejected below; retraction is a distinct, explicit, authorized act.
 *   This matches its sibling `ledger-supersession-not-later` in
 *   `validateApprovalsAndCheckpoint` exactly: both are temporal-impossibility
 *   findings, both are durable against the attacks enumerated in
 *   docs/c2/c2-checkpoint-approval-handoff.md —
 *   `validateLedgerAppendOnly` keeps every record in
 *   a ledger that is PRESENT, the approval-row pins in `ledger-pins.ts` keep a
 *   tracked ledger's own rows from being edited in place (the append-only check
 *   alone does not cover the head), and step 7c's three rules keep an unpinned
 *   ledger file, a renamed ledger file and a DELETED ledger file from releasing
 *   the chain (the append-only check cannot see a deletion — `rm` of the newest
 *   ledgers erased both findings before rule B existed). In both cases the
 *   durable record that a governance defect occurred IS the point. Neither is
 *   durable against a change that also edits the source pins, and no durability
 *   is claimed beyond the attacks actually run; see `ledger-pins.ts`. A
 *   supersession-based
 *   demotion was tried on the sibling and proved exploitable — one fabricated
 *   record dated a millisecond later suffices to hide the defect. Do not
 *   reintroduce it on either check. Clearing such a finding requires a
 *   validly-authorized retraction record targeting the specific approval (see
 *   `computeRetractedApprovalIds` and the `retraction-*` issue codes below,
 *   and `checkpoint-approvals-v6.json`, which retracts the two C2 v2
 *   approvals this way).
 * - `approved-artifact-version-unresolved` (via `reportUnresolved` below) IS
 *   scoped to active approvals. That is not a severity demotion: it is a
 *   detectability limit. The check needs the exact bytes the approval bound in
 *   order to say anything at all, and for a superseded approval those bytes are
 *   gone from the on-disk graph — there is no version-correct artifact to
 *   compare against, so the finding cannot be computed rather than being
 *   computed and then softened.
 *
 * A violation of either invariant taints the approval via `note`, so a
 * checkpoint cannot report "closed" on the strength of an approval carrying a
 * provenance issue.
 */
function verifyApprovalArtifactTimestamps(
  approvals: readonly z.infer<typeof CheckpointApproval>[],
  artifacts: Map<string, ParsedArtifact>,
  supersededApprovalIds: ReadonlySet<string>,
  retractedApprovalIds: ReadonlySet<string>,
  issues: ValidationIssue[],
  note: (approvalId: string, code: string) => void,
): void {
  // Recipes are declared for C0–C2 only. Widened to a string index so a
  // checkpoint id outside the recipe table (C3–C5) is a lookup miss rather than
  // a type error, and so adding a recipe automatically moves that checkpoint to
  // the verifyApprovedArtifactSet path below.
  const recipes: Partial<Record<string, CheckpointRecipe>> = CHECKPOINT_RECIPES;

  for (const approval of approvals) {
    const decidedAt = Date.parse(approval.decidedAt);
    // An ACTIVE approval of a checkpoint with no recipe has no other check
    // looking at its approvedArtifacts rows; one WITH a recipe is covered by
    // verifyApprovedArtifactSet / the recomputation path (see docstring).
    const reportUnresolved =
      !supersededApprovalIds.has(approval.approvalId) &&
      recipes[approval.checkpoint] === undefined;

    for (const bound of approval.approvedArtifacts) {
      const entry = artifacts.get(bound.artifactId);
      // Version gate: only the approved version's createdAt is meaningful for
      // the temporal comparison. An unresolvable row is a broken binding, and
      // for a recipeless checkpoint this is the only place it is reported.
      if (!entry || entry.sha !== bound.sha256) {
        if (reportUnresolved) {
          const code = "approved-artifact-version-unresolved";
          issues.push({
            code,
            artifactId: approval.approvalId,
            ...(entry ? { path: entry.filePath } : {}),
            message: entry
              ? `approval ${approval.approvalId}: approvedArtifact ${bound.artifactId} sha256 ${bound.sha256} is not the on-disk version (${entry.sha}); checkpoint ${approval.checkpoint} has no recipe, so this binding is verified nowhere else`
              : `approval ${approval.approvalId}: approvedArtifact ${bound.artifactId} (sha256 ${bound.sha256}) names no parsed artifact; checkpoint ${approval.checkpoint} has no recipe, so this binding is verified nowhere else`,
          });
          note(approval.approvalId, code);
        }
        continue;
      }
      if (!Number.isFinite(decidedAt)) continue;
      const createdAtRaw = entry.data.createdAt;
      if (typeof createdAtRaw !== "string") continue;
      const createdAt = Date.parse(createdAtRaw);
      if (!Number.isFinite(createdAt)) continue;
      if (decidedAt < createdAt && !retractedApprovalIds.has(approval.approvalId)) {
        issues.push({
          code: "approved-artifact-created-after-decision",
          artifactId: approval.approvalId,
          path: entry.filePath,
          message: `approval ${approval.approvalId}: decidedAt (${approval.decidedAt}) precedes createdAt (${createdAtRaw}) of approved artifact ${bound.artifactId}`,
        });
        note(approval.approvalId, "approved-artifact-created-after-decision");
      }
    }
  }
}

/**
 * Decide whether a set of (already issue-free) checkpoint approvals satisfies
 * the actor-separation rule of each approval's pinned registry.
 *
 * - Distinct actors always satisfy separation.
 * - A single shared actor is valid only when EVERY contributing approval's
 *   resolved pinned registry declares `sole-maintainer-bootstrap` with that
 *   shared actor as the human owner, and the owner is authorized for each
 *   approval's role. Implementation actors can never bootstrap.
 *
 * The resolved registry comes from each approval's recorded
 * `actorRegistryVersion` / `actorRegistrySha256`; do NOT substitute the chain
 * head, since a newer head may have reverted governance mode.
 */
function approvalsSatisfyActorCardinality(
  approvals: readonly z.infer<typeof CheckpointApproval>[],
  resolvedRegistryByApprovalId: ReadonlyMap<
    string,
    z.infer<typeof ApprovalActorRegistry>
  >,
  implementationActorIds: ReadonlySet<string>,
): boolean {
  if (approvals.length === 0) return false;

  const actorIds = new Set(approvals.map((approval) => approval.actorId));
  if (actorIds.size === approvals.length) return true;
  if (actorIds.size !== 1) return false;

  const [sharedActorId] = actorIds;
  if (!sharedActorId || implementationActorIds.has(sharedActorId)) return false;

  return approvals.every((approval) => {
    const registry = resolvedRegistryByApprovalId.get(approval.approvalId);
    if (!registry) return false;
    if (registry.governanceMode !== "sole-maintainer-bootstrap") return false;
    if (registry.bootstrapOwnerActorId !== sharedActorId) return false;

    const owner = registry.actors.find(
      (actor) => actor.actorId === sharedActorId,
    );
    return (
      owner?.actorKind === "human" &&
      approval.actorKind === "human" &&
      owner.roles.includes(approval.role)
    );
  });
}

/**
 * Resolve the registry matching an approval's recorded `actorRegistryVersion`.
 * Returns the parsed registry when the version exists AND its content digest
 * matches the approval's recorded `actorRegistrySha256`; otherwise records a
 * `registry-version-not-found` or `registry-hash-mismatch` issue and returns
 * undefined.
 */
function resolveApprovalRegistry(
  approval: z.infer<typeof CheckpointApproval>,
  registryByVersion: ReadonlyMap<string, ParsedArtifact>,
  issues: ValidationIssue[],
  note: (approvalId: string, code: string) => void,
): z.infer<typeof ApprovalActorRegistry> | undefined {
  const entry = registryByVersion.get(approval.actorRegistryVersion);
  if (!entry) {
    issues.push({
      code: "registry-version-not-found",
      artifactId: approval.approvalId,
      message: `registry version ${approval.actorRegistryVersion} not found`,
    });
    note(approval.approvalId, "registry-version-not-found");
    return undefined;
  }
  if (entry.sha !== approval.actorRegistrySha256) {
    issues.push({
      code: "registry-hash-mismatch",
      artifactId: approval.approvalId,
      message: `registry ${approval.actorRegistryVersion} digest does not match recorded digest`,
    });
    note(approval.approvalId, "registry-hash-mismatch");
    return undefined;
  }
  const parsed = ApprovalActorRegistry.safeParse(entry.data);
  if (!parsed.success) {
    issues.push({
      code: "registry-error",
      artifactId: approval.approvalId,
      message: `registry ${approval.actorRegistryVersion} failed schema validation for approval ${approval.approvalId}`,
    });
    note(approval.approvalId, "registry-error");
    return undefined;
  }
  // Semantic validation: governance mode, bootstrap owner, actor integrity.
  // An approval pinned to a semantically invalid registry cannot contribute
  // to closure even if it uses distinct actors — its authority is corrupt.
  const semanticIssues = validateRegistry(parsed.data);
  if (semanticIssues.length > 0) {
    for (const msg of semanticIssues) {
      issues.push({
        code: "registry-error",
        artifactId: approval.approvalId,
        message: `registry ${approval.actorRegistryVersion} (${approval.approvalId}): ${msg}`,
      });
    }
    note(approval.approvalId, "registry-error");
    return undefined;
  }
  return parsed.data;
}

/**
 * Closed-world policy enforcement for a single approval. Compares the
 * approval's observed artifact types, source keys, contract keys, input-hash
 * keys against the declared policy using exact set equality (missing AND
 * unexpected members are both errors). Duplicate declarations on either side
 * are also errors.
 */
function verifyCheckpointPolicy(
  approval: z.infer<typeof CheckpointApproval>,
  recipe: CheckpointRecipe,
  artifacts: Map<string, ParsedArtifact>,
  issues: ValidationIssue[],
  note: (approvalId: string, code: string) => void,
): void {
  const policy = CHECKPOINT_POLICIES[recipe.checkpoint];
  if (!policy) return; // future checkpoint — no closed-world policy yet
  const iid = approval.approvalId;

  // artifact-type: resolve each approved artifact to its parsed type. Unknown
  // approved artifact IDs do NOT collapse to an empty type — they keep being
  // reported by verifyApprovedArtifactSet as approved-artifact-unknown, and
  // are excluded here so they cannot mask a type mismatch.
  const actualArtifactTypes: string[] = [];
  for (const a of approval.approvedArtifacts) {
    const entry = [...artifacts.values()].find((e) => e.data.artifactId === a.artifactId);
    if (entry) actualArtifactTypes.push(entry.type);
  }
  comparePolicySet(iid, "artifact-type", policy.requiredArtifactTypes, actualArtifactTypes, issues, note);

  // source-key (plan + spec)
  const actualSourceKeys = [recipe.planBinding.key, recipe.specBinding.key];
  comparePolicySet(iid, "source-key", policy.requiredSourceKeys, actualSourceKeys, issues, note);

  // contract-key
  const actualContractKeys = Object.keys(approval.contractHashes);
  comparePolicySet(iid, "contract-key", policy.requiredContractKeys, actualContractKeys, issues, note);

  // input-hash-key
  comparePolicySet(iid, "input-hash-key", policy.requiredInputHashKeys, recipe.inputHashKeys, issues, note);
}

/**
 * Exact set equality comparison for one policy category. Emits a distinct
 * issue code per kind of mismatch: `policy-missing-<category>`,
 * `policy-unexpected-<category>`, and `policy-duplicate-<category>` when
 * either side declares a duplicate member.
 */
function comparePolicySet(
  approvalId: string,
  category: "artifact-type" | "source-key" | "contract-key" | "input-hash-key" | "role",
  expected: readonly string[],
  actual: readonly string[],
  issues: ValidationIssue[],
  note: (approvalId: string, code: string) => void,
): void {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  if (expectedSet.size !== expected.length) {
    const code = `policy-duplicate-${category}`;
    issues.push({ code, artifactId: approvalId, message: `policy declares duplicate ${category}` });
    note(approvalId, code);
  }
  if (actualSet.size !== actual.length) {
    const code = `policy-duplicate-${category}`;
    issues.push({ code, artifactId: approvalId, message: `approval contains duplicate ${category}` });
    note(approvalId, code);
  }
  for (const value of expectedSet) {
    if (!actualSet.has(value)) {
      const code = `policy-missing-${category}`;
      issues.push({ code, artifactId: approvalId, message: `missing ${category}: ${value}` });
      note(approvalId, code);
    }
  }
  for (const value of actualSet) {
    if (!expectedSet.has(value)) {
      const code = `policy-unexpected-${category}`;
      issues.push({ code, artifactId: approvalId, message: `unexpected ${category}: ${value}` });
      note(approvalId, code);
    }
  }
}

// ---------------------------------------------------------------------------
// Canonical checkpoint-target recomputation
// ---------------------------------------------------------------------------

/**
 * Typed failure carrier for checkpoint recomputation. A provenance mismatch
 * (reviewed vs merged bytes differ) keeps its specific issue code so the
 * per-approval loop can surface `checkpoint-provenance-mismatch`; all other
 * resolver/parsing exceptions map to `checkpoint-recompute-failed`.
 */
class CheckpointRecomputeError extends Error {
  constructor(
    readonly issueCode: "checkpoint-provenance-mismatch",
    message: string,
  ) {
    super(message);
  }
}

interface CanonicalTarget {
  targetSha256: string;
  planSha256: string;
  specSha256: string;
  contractHashes: Record<string, string>;
}

interface RecomputeFailure {
  code: string;
  message: string;
}

interface RecomputeState {
  recipes: Partial<Record<string, CheckpointRecipe>>;
  canonical: Partial<Record<string, CanonicalTarget>>;
  /** Checkpoints whose recomputation threw — every approval must fail closed. */
  recomputeFailures: Map<string, RecomputeFailure>;
  /** Resolved git-file inputHashes for phase0-summary verification (key → sha). */
  inputHashes: Record<string, string>;
}

/**
 * Recompute the canonical checkpoint target for every checkpoint with a known
 * recipe AND at least one active approval. Recipes for checkpoints with no
 * approval are declared (so policy is closed-world) but their sources are NOT
 * resolved — a future checkpoint (e.g. C1) stays open without producing
 * spurious issues from unresolved bytes.
 *
 * The resolver is REQUIRED (validated by the caller). Resolver throws are
 * recorded in `recomputeFailures` so the per-approval loop can emit a blocking
 * issue and disqualify every affected approval — this is fail-closed. A
 * `CheckpointRecomputeError` (provenance mismatch) keeps its specific code;
 * all other exceptions map to `checkpoint-recompute-failed`.
 *
 * The registry version + digest used to build each target comes from that
 * checkpoint's approvals (all valid approvals for one checkpoint must bind the
 * same target, hence the same registry version/digest pair). When a checkpoint
 * has approvals and `registryByVersion` is supplied, the unique pair is
 * resolved from there; otherwise the legacy single-registry fallback applies.
 */
function computeCanonicalTargets(
  artifacts: Map<string, ParsedArtifact>,
  _absRoot: string,
  opts: ValidateReadinessOptions,
  activeCheckpoints: Set<string>,
  approvals: z.infer<typeof CheckpointApproval>[] = [],
  registryByVersion: ReadonlyMap<string, ParsedArtifact> = new Map(),
): RecomputeState {
  const resolver = opts.gitSourceResolver;

  const recipes: Partial<Record<string, CheckpointRecipe>> = {};
  const canonical: Partial<Record<string, CanonicalTarget>> = {};
  const recomputeFailures = new Map<string, RecomputeFailure>();
  const inputHashes: Record<string, string> = {};

  for (const [cp, recipe] of Object.entries(CHECKPOINT_RECIPES)) {
    recipes[cp] = recipe;

    // Skip recomputation for checkpoints with no approval. The recipe stays
    // declared (closed-world policy), but its sources are not resolved, so a
    // future checkpoint does not produce spurious unresolved-byte issues.
    if (!activeCheckpoints.has(cp)) continue;

    try {
      // --- Integration provenance: for recipes that declare an
      // integrationGitSha, every bound source file must be byte-identical at
      // the reviewed commit and the merge commit. A divergence means the
      // merge altered reviewed content after review.
      const allBindings = [recipe.planBinding, recipe.specBinding, ...recipe.contractBindings];
      if (recipe.integrationGitSha) {
        for (const binding of allBindings) {
          const reviewed = resolver.resolve(binding.gitCommit, binding.repositoryPath);
          const merged = resolver.resolve(recipe.integrationGitSha, binding.repositoryPath);
          if (sha256Hex(reviewed) !== sha256Hex(merged)) {
            throw new CheckpointRecomputeError(
              "checkpoint-provenance-mismatch",
              `${binding.repositoryPath} differs between ${binding.gitCommit} and ${recipe.integrationGitSha}`,
            );
          }
        }
      }

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
      // Only C0's inputHashes feed the phase0-summary verification. Other
      // recipes may share keys (e.g. task1-plan.md) that resolve at different
      // commits; writing them would overwrite C0's resolved values. C0 is
      // always the phase0-summary source of truth, so prefer NOT to overwrite
      // an already-resolved key.
      for (const [k, v] of Object.entries(fullInputHashes)) {
        if (inputHashes[k] === undefined) inputHashes[k] = v;
      }

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

      // Registry version + sha. Prefer the unique pair recorded by this
      // checkpoint's approvals (resolved via registryByVersion); fall back to
      // the legacy single-registry lookup when no approval pins a version.
      const cpApprovals = approvals.filter((a) => a.checkpoint === cp);
      const versionDigestPairs = new Set(
        cpApprovals.map((a) => `${a.actorRegistryVersion}@${a.actorRegistrySha256}`),
      );
      let registryVersion = "";
      let registrySha = "";
      if (versionDigestPairs.size === 1) {
        const [version, digest] = [...versionDigestPairs][0]!.split("@");
        registryVersion = version!;
        // Confirm the version resolves and its digest matches; if not, leave
        // the target's registry fields empty so the recomputed target cannot
        // match a fabricated approval (per-approval resolution reports the
        // precise registry-hash-mismatch / registry-version-not-found code).
        const entry = registryByVersion.get(registryVersion);
        if (entry && entry.sha === digest) {
          registrySha = entry.sha;
        } else {
          registrySha = digest!;
        }
      } else {
        // Divergent pairs (or no approvals): legacy fallback to the single
        // in-memory registry artifact. Divergent approvals are caught by the
        // divergent-targets check in the caller.
        const registryEntry = [...artifacts.values()].find(
          (e) => e.type === "approval-actor-registry",
        );
        registryVersion =
          (registryEntry?.data.registryVersion as string | undefined) ?? "";
        registrySha = registryEntry?.sha ?? "";
      }

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
      if (e instanceof CheckpointRecomputeError) {
        recomputeFailures.set(cp, { code: e.issueCode, message: e.message });
      } else {
        recomputeFailures.set(cp, {
          code: "checkpoint-recompute-failed",
          message: (e as Error).message ?? String(e),
        });
      }
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
