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
import type { z } from "zod";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ValidateReadinessOptions {
  artifactRoot: string;
  mode: "public" | "private";
  corpusPath?: string;
  privateArtifactRoot?: string;
  previousLedgerPath?: string;
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

    artifacts.set(artifactId, { type: artifactType, data: record, filePath, sha });
  }

  // 3. Validate the artifact index
  let indexEntry: ParsedArtifact | undefined;
  let ledgerEntry: ParsedArtifact | undefined;
  for (const [, entry] of artifacts) {
    if (entry.type === "artifact-index") indexEntry = entry;
    if (entry.type === "checkpoint-approvals") ledgerEntry = entry;
  }

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

    // 7. Validate registry
    const registry = [...artifacts.values()].find((a) => a.type === "approval-actor-registry");
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

    // 8. Approvals and checkpoint closure
    if (ledgerEntry && registry) {
      validateApprovalsAndCheckpoint(
        ledgerEntry,
        registry,
        implementationActorIds,
        artifacts,
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
// Approval validation
// ---------------------------------------------------------------------------

interface ParsedArtifact {
  type: string;
  data: Record<string, unknown>;
  filePath: string;
  sha: string;
}

function validateApprovalsAndCheckpoint(
  ledgerEntry: ParsedArtifact,
  registry: ParsedArtifact,
  implementationActorIds: Set<string>,
  artifacts: Map<string, ParsedArtifact>,
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

  // Validate each approval
  const targetShas = new Map<string, Set<string>>(); // checkpoint → set of target SHAs

  for (const approval of approvals) {
    // Implementer cannot approve (checked first — no continue, all checks run)
    if (implementationActorIds.has(approval.actorId)) {
      issues.push({
        code: "implementer-self-approval",
        artifactId: approval.approvalId,
        message: `approval ${approval.approvalId}: implementer ${approval.actorId} cannot approve`,
      });
    }

    // Actor must exist in registry
    const actor = registryActorMap.get(approval.actorId);
    if (!actor) {
      issues.push({
        code: "actor-not-found",
        artifactId: approval.approvalId,
        message: `approval ${approval.approvalId}: actor ${approval.actorId} not in registry`,
      });
      continue;
    }

    // Actor must be authorized for the claimed role
    if (!actor.roles.includes(approval.role)) {
      issues.push({
        code: "actor-role-mismatch",
        artifactId: approval.approvalId,
        message: `approval ${approval.approvalId}: actor ${approval.actorId} not authorized for role ${approval.role}`,
      });
    }

    // Registry hash must match actual file
    if (approval.actorRegistrySha256 !== registry.sha) {
      issues.push({
        code: "registry-hash-mismatch",
        artifactId: approval.approvalId,
        message: `approval ${approval.approvalId}: registry hash ${approval.actorRegistrySha256} does not match file ${registry.sha}`,
      });
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

  // Determine checkpoint closure for C0–C5
  for (const cp of ["C0", "C1", "C2", "C3", "C4", "C5"]) {
    const required = CHECKPOINT_ROLES[cp] || [];
    const cpApprovals = approvals.filter(
      (a) => a.checkpoint === cp && a.decision === "approved" && a.approvalKind === "checkpoint",
    );

    // Check distinct actors for required roles
    const approvedRoles = new Set<string>();
    const approvedActors = new Set<string>();
    for (const a of cpApprovals) {
      approvedRoles.add(a.role);
      approvedActors.add(a.actorId);
    }

    // All required roles present
    const allRolesPresent = required.every((r) => approvedRoles.has(r));

    // All approvers are distinct actors (no one actor satisfying two independent roles)
    const distinctActors = approvedActors.size === cpApprovals.length;

    if (allRolesPresent && distinctActors) {
      checkpointStatus[cp] = "closed";
    }
  }
}
