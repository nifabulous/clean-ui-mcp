/**
 * C2 baseline manifest contract — the frozen 25-case baseline (Pass 3, Task B1).
 *
 * The baseline manifest binds every case package (brief + label + optional
 * source snapshot) plus its gold-evidence descriptor, declares the execution
 * matrix (3 primary conditions × 25 cases + 1 independent condition × 5
 * spec-locked cases = 80 planned runs), and pins the frozen calibration the
 * baseline runs against. The manifest is content-free — it carries hashes +
 * refs only — so it can be committed and pass the durable-artifact boundary
 * scan.
 *
 * Self-hash: `manifestSha256` is computed over the canonical JSON of the
 * manifest with `manifestSha256` set to `""`, the same pattern used by
 * `proposalSha256` on calibration proposals. Two manifests with identical
 * content (except the hash field itself) produce the same hash.
 *
 * This schema is INTENTIONALLY distinct from `C2PilotManifestSchema` (the
 * 3-case pilot contract): the baseline adds the `goldEvidenceDescriptor` ref
 * per case (the pilot resolves gold-evidence through a separate binding array
 * because the pilot descriptor is resolved-records, while the baseline only
 * pins the descriptor file ref — resolution happens at condition-build time).
 */
import { z } from "zod";
import {
  ArtifactFileRefSchema,
  C2CaseFamilySchema,
  StableId,
  hasUniqueStrings,
} from "./primitives.js";
import { C2CasePackageManifestSchema } from "./case-contracts.js";
import { canonicalJsonStringify, sha256Hex, Sha256 } from "../readiness/contracts.js";
import { NonEmptyText } from "./primitives.js";

// ---------------------------------------------------------------------------
// Case reference — a case package + the gold-evidence descriptor file ref.
//
// `C2CasePackageManifestSchema` already enforces the brief/label/sourceSnapshot
// hashes + the migration-requires-source-snapshot constraint. The baseline
// extends it with one field: `goldEvidenceDescriptor`, the descriptor file the
// gold-evidence condition resolves against. The descriptor file itself (pointer
// map + source artifact refs) is not duplicated into the manifest — only the
// ref is pinned, so the manifest stays content-free.
// ---------------------------------------------------------------------------

export const C2BaselineCaseRefSchema = C2CasePackageManifestSchema.extend({
  goldEvidenceDescriptor: ArtifactFileRefSchema,
});

export type C2BaselineCaseRef = z.infer<typeof C2BaselineCaseRefSchema>;

// ---------------------------------------------------------------------------
// Execution matrix — declared as data so the spec-lock is machine-checkable.
//
// The 5 independent case IDs are the exact cases the spec froze for the
// current-grounded independent condition. The total planned runs is the
// primary (caseCount × conditions) + independent (independentIds × conditions)
// arithmetic; the superRefine verifies the math holds.
// ---------------------------------------------------------------------------

const REQUIRED_INDEPENDENT_CASE_IDS = [
  "stablecoin-home",
  "finance-news-story-detail",
  "public-marketing-migration",
  "safety-conflicting-evidence",
  "named-inspiration-safety",
] as const;

export const C2ExecutionMatrixSchema = z
  .object({
    primaryConditions: z.tuple([
      z.literal("brief-only"),
      z.literal("current-grounded"),
      z.literal("gold-evidence"),
    ]),
    primaryCaseCount: z.literal(25),
    independentConditions: z.tuple([z.literal("current-grounded")]),
    independentCaseIds: z.array(StableId).length(5),
    totalPlannedRuns: z.literal(80),
  })
  .strict()
  .superRefine((matrix, ctx) => {
    const sortedActual = [...matrix.independentCaseIds].sort();
    const sortedRequired = [...REQUIRED_INDEPENDENT_CASE_IDS].sort();
    if (
      sortedActual.length !== sortedRequired.length ||
      sortedActual.some((id, i) => id !== sortedRequired[i])
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["independentCaseIds"],
        message: "independent case IDs must be exactly the 5 spec-locked cases",
      });
    }
    const expected =
      matrix.primaryCaseCount * matrix.primaryConditions.length +
      matrix.independentCaseIds.length * matrix.independentConditions.length;
    if (expected !== matrix.totalPlannedRuns) {
      ctx.addIssue({
        code: "custom",
        path: ["totalPlannedRuns"],
        message: `totalPlannedRuns must equal ${expected} (primary ${matrix.primaryCaseCount}×${matrix.primaryConditions.length} + independent ${matrix.independentCaseIds.length}×${matrix.independentConditions.length})`,
      });
    }
  });

export type C2ExecutionMatrix = z.infer<typeof C2ExecutionMatrixSchema>;

// ---------------------------------------------------------------------------
// The manifest.
//
// The cases array is NOT ordered by family — the superRefine counts families
// against `familyCounts` (15 product / 5 migration / 5 safety = 25). Case IDs
// must be unique across the manifest.
// ---------------------------------------------------------------------------

export const C2BaselineManifestSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    artifactType: z.literal("c2-baseline-manifest"),
    artifactId: StableId,
    caseCount: z.literal(25),
    familyCounts: z.object({
      product: z.literal(15),
      migration: z.literal(5),
      safety: z.literal(5),
    }),
    cases: z.array(C2BaselineCaseRefSchema).length(25),
    executionMatrix: C2ExecutionMatrixSchema,
    frozenCalibrationRef: ArtifactFileRefSchema,
    manifestSha256: Sha256,
    /** Explicitly documents incomplete sections of the baseline (e.g., pending
     * migration source snapshots). When non-empty, the manifest is STAGED, not
     * runnable — prepare/run must fail closed until all sections are resolved. */
    stagedSections: z.array(z.object({
      section: NonEmptyText,
      reason: NonEmptyText,
      affectedCaseIds: z.array(StableId),
    })).default([]),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const families = ["product", "migration", "safety"] as const;
    for (const family of families) {
      const actual = manifest.cases.filter((c) => c.family === family).length;
      const expected = manifest.familyCounts[family];
      if (actual !== expected) {
        ctx.addIssue({
          code: "custom",
          path: ["cases"],
          message: `familyCounts.${family}=${expected} but ${actual} ${family} cases present`,
        });
      }
    }
    if (!hasUniqueStrings(manifest.cases.map((c) => c.caseId))) {
      ctx.addIssue({
        code: "custom",
        path: ["cases"],
        message: "case IDs must be unique",
      });
    }
    // Every independent case ID must appear exactly once in the cases array.
    // Without this cross-field check, the execution matrix could declare runs
    // for cases that don't exist in the manifest.
    const caseIds = new Set(manifest.cases.map((c) => c.caseId));
    for (const independentId of manifest.executionMatrix.independentCaseIds) {
      if (!caseIds.has(independentId)) {
        ctx.addIssue({
          code: "custom",
          path: ["executionMatrix", "independentCaseIds"],
          message: `independent case ID '${independentId}' does not appear in manifest.cases`,
        });
      }
    }
  });

export type C2BaselineManifest = z.infer<typeof C2BaselineManifestSchema>;

// ---------------------------------------------------------------------------
// Self-hash — reproducible over canonical JSON with the hash field emptied.
//
// Mirrors the `proposalSha256` pattern: hashing the manifest with
// `manifestSha256: ""` makes two manifests with identical content (except the
// hash field itself) hash to the same value. The builder fills the empty
// placeholder, hashes, then patches the real digest back in.
// ---------------------------------------------------------------------------

export function computeManifestSha256(
  manifest: Omit<C2BaselineManifest, "manifestSha256">,
): string {
  const withEmptyHash = { ...manifest, manifestSha256: "" };
  const canonical = canonicalJsonStringify(withEmptyHash);
  return sha256Hex(Buffer.from(canonical, "utf-8"));
}
