/**
 * Readiness artifact contracts.
 *
 * Strict Zod schemas for tracked and private readiness artifacts, plus canonical
 * hashing helpers. Every persisted object uses `.strict()` so removed crypto
 * fields (signingKeyId, signatureBase64, attestationSha256) fail validation if
 * accidentally re-added.
 */
import { z } from "zod";
import { createHash } from "node:crypto";
import {
  Category,
  Component,
  DomainTag,
  PatternType,
  StyleTag,
} from "../schema.js";

// ---------------------------------------------------------------------------
// Primitive schemas
// ---------------------------------------------------------------------------

/** Lowercase 64-hex SHA-256 digest. */
export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** Lowercase 40-hex Git SHA-1. */
export const GitSha = z.string().regex(/^[0-9a-f]{40}$/);

// ---------------------------------------------------------------------------
// Hashing helpers
// ---------------------------------------------------------------------------

/** SHA-256 hex digest of a Uint8Array. */
export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Recursively sort object keys by code-point order, preserve array order,
 * and emit compact UTF-8 JSON. Rejects `undefined`, functions, symbols,
 * non-finite numbers, and cyclic values.
 */
export function canonicalJsonStringify(value: unknown): string {
  const seen = new WeakSet();

  function recurse(val: unknown): string {
    if (val === null || typeof val !== "object") {
      if (val === undefined) throw new Error("undefined is not canonical JSON");
      if (typeof val === "function") throw new Error("function is not canonical JSON");
      if (typeof val === "symbol") throw new Error("symbol is not canonical JSON");
      if (typeof val === "number" && !Number.isFinite(val))
        throw new Error("non-finite number is not canonical JSON");
      return JSON.stringify(val);
    }

    if (seen.has(val as object)) throw new Error("cyclic value is not canonical JSON");
    seen.add(val as object);

    if (Array.isArray(val)) {
      return "[" + val.map(recurse).join(",") + "]";
    }

    const keys = Object.keys(val).sort();
    return (
      "{" +
      keys
        .map((k) => {
          const v = (val as Record<string, unknown>)[k];
          return JSON.stringify(k) + ":" + recurse(v);
        })
        .join(",") +
      "}"
    );
  }

  return recurse(value);
}

// ---------------------------------------------------------------------------
// Layered headers
// ---------------------------------------------------------------------------

export const BaseArtifactHeader = z
  .object({
    schemaVersion: z.literal("1.0"),
    artifactType: z.string().min(1),
    artifactId: z.string().min(1),
    createdAt: z.string().datetime(),
    createdByRole: z.string().min(1),
    sourceGitSha: GitSha,
    inputHashes: z.record(z.string().min(1), Sha256),
  })
  .strict();

export const CorpusBoundHeader = BaseArtifactHeader.extend({
  corpusSha256: Sha256,
  corpusEntryCount: z.number().int().nonnegative(),
  taxonomySha256: Sha256,
}).strict();

// ---------------------------------------------------------------------------
// Approval schemas (no crypto fields)
// ---------------------------------------------------------------------------

export const ApprovalRole = z.enum([
  "Repository Maintainer",
  "PM",
  "Product",
  "Engineering",
  "Gold Label Owner",
  "QA",
  "Evaluation Owner",
  "Corpus Owner",
  "Budget Owner",
]);

export const CheckpointApproval = z
  .object({
    approvalId: z.string().min(1),
    approvalKind: z.enum(["artifact-review", "checkpoint"]),
    checkpoint: z.enum(["C0", "C1", "C2", "C3", "C4", "C5"]),
    decision: z.enum(["approved", "rejected"]),
    actorId: z.string().min(1),
    role: ApprovalRole,
    actorKind: z.enum(["human", "agent"]),
    actorRegistryVersion: z.string().min(1),
    actorRegistrySha256: Sha256,
    checkpointTargetSha256: Sha256,
    approvedArtifacts: z
      .array(z.object({ artifactId: z.string().min(1), sha256: Sha256 }).strict())
      .min(1),
    planSha256: Sha256,
    specSha256: Sha256,
    contractHashes: z.record(z.string().min(1), Sha256),
    decidedAt: z.string().datetime(),
    rationale: z.string().optional(),
  })
  .strict();

export const LiveCostApproval = z
  .object({
    approvalId: z.string().min(1),
    actorId: z.string().min(1),
    role: z.literal("Budget Owner"),
    actorKind: z.literal("human"),
    actorRegistryVersion: z.string().min(1),
    actorRegistrySha256: Sha256,
    runId: z.string().min(1),
    runConfigSha256: Sha256,
    provider: z.string().min(1),
    model: z.string().min(1),
    maxCostUsd: z.number().positive(),
    decidedAt: z.string().datetime(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Taxonomy digest computation
// ---------------------------------------------------------------------------

export interface TaxonomyDigestResult {
  perEnum: Record<
    "Category" | "Component" | "DomainTag" | "PatternType" | "StyleTag",
    { values: string[]; sha256: string }
  >;
  aggregateSha256: string;
}

/**
 * Compute the canonical taxonomy digest from the live schema.ts enums.
 *
 * Per-enum hashes are SHA-256 of compact `JSON.stringify(enum.options)`.
 * The aggregate hash is SHA-256 of canonical-JSON `{ enumName: values[] }`
 * (keys sorted, arrays preserved in declaration order).
 */
export function computeTaxonomyDigest(): TaxonomyDigestResult {
  const map = {
    Category: Category.options,
    Component: Component.options,
    DomainTag: DomainTag.options,
    PatternType: PatternType.options,
    StyleTag: StyleTag.options,
  };

  const perEnum = Object.fromEntries(
    Object.entries(map).map(([name, values]) => [
      name,
      { values, sha256: sha256Hex(Buffer.from(JSON.stringify(values), "utf-8")) },
    ]),
  ) as TaxonomyDigestResult["perEnum"];

  const aggregateInput = Object.fromEntries(
    Object.entries(map).map(([name, values]) => [name, values]),
  );
  const aggregateSha256 = sha256Hex(
    Buffer.from(canonicalJsonStringify(aggregateInput), "utf-8"),
  );

  return { perEnum, aggregateSha256 };
}

// ---------------------------------------------------------------------------
// Type-specific artifact schemas
// ---------------------------------------------------------------------------

const TaxonomyEnumName = z.enum([
  "Category",
  "Component",
  "DomainTag",
  "PatternType",
  "StyleTag",
]);

const TaxonomyEntrySchema = z
  .object({
    count: z.number().int().nonnegative(),
    values: z.array(z.string().min(1)),
    sha256: Sha256,
    serialization: z.string().min(1),
  })
  .strict();

export const Phase0Summary = CorpusBoundHeader.extend({
  artifactType: z.literal("phase0-summary"),
  environment: z
    .object({
      nodeVersion: z.string().min(1),
      npmVersion: z.string().min(1),
      platform: z.string().min(1),
      corpusMode: z.enum(["seed", "private", "public-snapshot", "metadata-only-fixture"]),
      networkMode: z.enum(["credential-scrubbed", "fixture-http", "live"]),
    })
    .strict(),
  commandMatrix: z.array(
    z
      .object({
        command: z.string().min(1),
        exitCode: z.number().int(),
        runner: z.enum(["credential-scrubbed", "standard"]),
        result: z.string().min(1),
      })
      .strict(),
  ),
  skipGates: z.array(
    z
      .object({
        test: z.string().min(1),
        file: z.string().min(1),
        gate: z.string().min(1),
        fired: z.boolean(),
        reason: z.string().min(1),
        testCount: z.number().int().nonnegative(),
      })
      .strict(),
  ),
  doctorResult: z.object({ pass: z.number().int(), warn: z.number().int(), fail: z.number().int() }).strict(),
  validateCorpusResult: z
    .object({ valid: z.boolean(), entryCount: z.number().int().nonnegative(), uniqueIds: z.number().int().nonnegative() })
    .strict(),
  packAnalysis: z
    .object({
      totalFiles: z.number().int().nonnegative(),
      potentialLeaks: z.array(
        z.object({ path: z.string(), risk: z.enum(["low", "medium", "high"]), note: z.string() }).strict(),
      ),
      note: z.string(),
    })
    .strict(),
  credentialScrubbedRunner: z
    .object({
      script: z.string().min(1),
      approach: z.string().min(1),
      limitations: z.string().min(1),
      redactedKeys: z.array(z.string().min(1)),
    })
    .strict(),
  diagnosticBaseline: z
    .object({
      gitSha: z.string().min(1),
      date: z.string().min(1),
      imageCount: z.number().int().nonnegative(),
      patternTypeAccuracy: z.number().min(0).max(1),
      rawBannedPhrases: z.number().int().nonnegative(),
      rawIconOnlyClaims: z.number().int().nonnegative(),
      meanExtractionLatencyMs: z.number().nonnegative(),
      citationScorable: z.boolean(),
      extractionProvider: z.string().min(1),
      extractionModel: z.string().min(1),
      critiqueProvider: z.string().min(1),
      critiqueModel: z.string().min(1),
      modelPinned: z.boolean(),
      systemPromptSha256: Sha256,
      referenceManifestSha256: Sha256,
      machineRulesSha256: Sha256,
      note: z.string(),
      reusable: z.boolean(),
      nonReusableReasons: z.array(z.string()),
    })
    .strict(),
  ownershipMapRef: z.string().min(1),
  taxonomyDigestRef: z.string().min(1),
  c0Status: z.string().min(1),
  c0Note: z.string(),
}).strict();

export const OwnershipMap = BaseArtifactHeader.extend({
  artifactType: z.literal("ownership-map"),
  entries: z.array(
    z
      .object({
        path: z.string().min(1),
        classification: z.enum([
          "owned-by-current-increment",
          "owned-by-other-work",
          "needs-user-decision",
        ]),
        decision: z.string().min(1),
        sha256: Sha256,
      })
      .strict(),
  ),
  critiqueQualityBranchDisposition: z
    .object({ branch: z.string().min(1), status: z.string().min(1), note: z.string() })
    .strict(),
}).strict();

export const TaxonomyDigestArtifact = BaseArtifactHeader.extend({
  artifactType: z.literal("taxonomy-digest"),
  taxonomies: z.record(TaxonomyEnumName, TaxonomyEntrySchema),
  aggregateSha256: Sha256,
}).strict();

export const ApprovalActorRegistry = BaseArtifactHeader.extend({
  artifactType: z.literal("approval-actor-registry"),
  registryVersion: z.string().min(1),
  previousRegistry: z
    .object({ registryVersion: z.string().min(1), sha256: Sha256 }).strict()
    .nullable(),
  actors: z
    .array(
      z
        .object({
          actorId: z.string().min(1),
          actorKind: z.enum(["human", "agent"]),
          roles: z.array(ApprovalRole).min(1),
        })
        .strict(),
    )
    .refine(
      (actors) => new Set(actors.map((a) => a.actorId)).size === actors.length,
      "duplicate actor IDs",
    ),
}).strict();

// ---------------------------------------------------------------------------
// Backward-compatible snapshot chain metadata
// ---------------------------------------------------------------------------

/**
 * Reference to the previous snapshot in an append-only chain.
 *
 * `version` is the human-readable predecessor identifier (e.g. registry-style
 * version string); `sha256` is its canonical-content digest. Both fields are
 * required when a predecessor is present. A `null`/absent predecessor marks a
 * genesis (first) snapshot. Schemas consume this via `VersionedSnapshotFields`.
 */
export const SnapshotPredecessor = z.object({
  version: z.string().trim().min(1),
  sha256: Sha256,
}).strict();

/**
 * Optional, backward-compatible chain metadata shared by versioned snapshot
 * artifacts (`CheckpointApprovals`, `ArtifactIndex`).
 *
 * - `ordinalVersion`: 1-based ordinal of the snapshot in its chain.
 * - `predecessor`: reference to the prior snapshot, or `null` for genesis.
 *
 * Absence (rather than a default) is how historical v1 snapshots stay
 * distinguishable from v2+ snapshots that explicitly declare `ordinalVersion: 1`
 * with a `null` predecessor.
 */
const VersionedSnapshotFields = {
  ordinalVersion: z.number().int().min(1).optional(),
  predecessor: SnapshotPredecessor.nullable().optional(),
};

export const CheckpointApprovals = BaseArtifactHeader.extend({
  artifactType: z.literal("checkpoint-approvals"),
  ...VersionedSnapshotFields,
  approvals: z.array(CheckpointApproval),
}).strict();

export const ArtifactIndex = BaseArtifactHeader.extend({
  artifactType: z.literal("artifact-index"),
  ...VersionedSnapshotFields,
  artifacts: z.array(
    z
      .object({
        artifactId: z.string().min(1),
        artifactType: z.string().min(1),
        sha256: Sha256,
        path: z.string().min(1),
      })
      .strict(),
  ),
  implementationActorIds: z.array(z.string().min(1)).min(1),
}).strict();

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

export const TrackedArtifact = z.discriminatedUnion("artifactType", [
  Phase0Summary,
  OwnershipMap,
  TaxonomyDigestArtifact,
  ApprovalActorRegistry,
  CheckpointApprovals,
  ArtifactIndex,
]);

// ---------------------------------------------------------------------------
// Checkpoint target construction
// ---------------------------------------------------------------------------

export interface CheckpointTarget {
  checkpoint: "C0" | "C1" | "C2" | "C3" | "C4" | "C5";
  baselineGitSha: string;
  artifacts: Array<{ artifactId: string; artifactType: string; sha256: string }>;
  planSha256: string;
  specSha256: string;
  actorRegistryVersion: string;
  actorRegistrySha256: string;
  contractHashes: Record<string, string>;
  inputHashes: Record<string, string>;
}

export interface BuildCheckpointTargetOptions {
  checkpoint: "C0" | "C1" | "C2" | "C3" | "C4" | "C5";
  baselineGitSha: string;
  artifacts: Array<{ artifactId: string; artifactType: string; sha256: string }>;
  planSha256: string;
  specSha256: string;
  actorRegistryVersion: string;
  actorRegistrySha256: string;
  contractHashes: Record<string, string>;
  inputHashes: Record<string, string>;
}

/**
 * Build a canonical checkpoint target. Artifacts are sorted by `artifactId`,
 * record keys are sorted via canonical serialization, and duplicate IDs are
 * rejected.
 */
export function buildCheckpointTarget(opts: BuildCheckpointTargetOptions): CheckpointTarget {
  const ids = new Set<string>();
  for (const a of opts.artifacts) {
    if (ids.has(a.artifactId)) {
      throw new Error(`duplicate artifact ID in checkpoint target: ${a.artifactId}`);
    }
    ids.add(a.artifactId);
  }

  return {
    checkpoint: opts.checkpoint,
    baselineGitSha: opts.baselineGitSha,
    artifacts: [...opts.artifacts].sort((a, b) =>
      a.artifactId < b.artifactId ? -1 : a.artifactId > b.artifactId ? 1 : 0,
    ),
    planSha256: opts.planSha256,
    specSha256: opts.specSha256,
    actorRegistryVersion: opts.actorRegistryVersion,
    actorRegistrySha256: opts.actorRegistrySha256,
    contractHashes: opts.contractHashes,
    inputHashes: opts.inputHashes,
  };
}

/** Compute the deterministic SHA-256 of a checkpoint target. */
export function computeCheckpointTargetSha256(target: CheckpointTarget): string {
  return sha256Hex(Buffer.from(canonicalJsonStringify(target), "utf-8"));
}

// ---------------------------------------------------------------------------
// Registry and ledger validation helpers
// ---------------------------------------------------------------------------

/** Validate an approval-actor-registry beyond schema parsing. Returns issues (empty = valid). */
export function validateRegistry(
  registry: z.infer<typeof ApprovalActorRegistry>,
): string[] {
  const issues: string[] = [];

  // previousRegistry: null only for v1
  if (registry.previousRegistry === null) {
    if (registry.registryVersion !== "1.0" && !/^[0-9]/.test(registry.registryVersion)) {
      // accept any version starting with a digit for v1 — convention is "1.0"
    }
  }
  // If registryVersion starts with "1" but previousRegistry is non-null, that's wrong
  if (registry.registryVersion.startsWith("1") && registry.previousRegistry !== null) {
    issues.push("v1 registry must have previousRegistry: null");
  }
  // If registryVersion is > 1, must reference prior
  if (!registry.registryVersion.startsWith("1") && registry.previousRegistry === null) {
    issues.push("non-v1 registry must reference a previousRegistry");
  }

  // Unique actor IDs
  const seen = new Set<string>();
  for (const actor of registry.actors) {
    if (seen.has(actor.actorId)) {
      issues.push(`duplicate actor ID: ${actor.actorId}`);
    }
    seen.add(actor.actorId);

    // Non-empty, duplicate-free roles
    if (actor.roles.length === 0) {
      issues.push(`actor ${actor.actorId} has no roles`);
    }
    const roleSet = new Set(actor.roles);
    if (roleSet.size !== actor.roles.length) {
      issues.push(`actor ${actor.actorId} has duplicate roles`);
    }
  }

  return issues;
}

/** Validate that a current ledger is an append-only superset of a previous one. Returns issues. */
export function validateLedgerAppendOnly(
  current: { approvals: z.infer<typeof CheckpointApproval>[] },
  previous: { approvals: z.infer<typeof CheckpointApproval>[] },
): string[] {
  const issues: string[] = [];

  const currentMap = new Map(
    current.approvals.map((a) => [a.approvalId, canonicalJsonStringify(a)]),
  );

  for (const prevApproval of previous.approvals) {
    const currentCanonical = currentMap.get(prevApproval.approvalId);
    const prevCanonical = canonicalJsonStringify(prevApproval);
    if (currentCanonical === undefined) {
      issues.push(`prior approval deleted: ${prevApproval.approvalId}`);
    } else if (currentCanonical !== prevCanonical) {
      issues.push(`prior approval mutated: ${prevApproval.approvalId}`);
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type BaseArtifactHeaderT = z.infer<typeof BaseArtifactHeader>;
export type CorpusBoundHeaderT = z.infer<typeof CorpusBoundHeader>;
export type CheckpointApprovalT = z.infer<typeof CheckpointApproval>;
export type LiveCostApprovalT = z.infer<typeof LiveCostApproval>;
export type ApprovalRoleT = z.infer<typeof ApprovalRole>;
export type Phase0SummaryT = z.infer<typeof Phase0Summary>;
export type OwnershipMapT = z.infer<typeof OwnershipMap>;
export type TaxonomyDigestArtifactT = z.infer<typeof TaxonomyDigestArtifact>;
export type ApprovalActorRegistryT = z.infer<typeof ApprovalActorRegistry>;
export type CheckpointApprovalsT = z.infer<typeof CheckpointApprovals>;
export type ArtifactIndexT = z.infer<typeof ArtifactIndex>;
export type SnapshotPredecessorT = z.infer<typeof SnapshotPredecessor>;
export type TrackedArtifactT = z.infer<typeof TrackedArtifact>;
