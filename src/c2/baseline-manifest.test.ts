import { describe, expect, it } from "vitest";
import {
  C2BaselineManifestSchema,
  computeManifestSha256,
} from "./baseline-manifest.js";
import { scanDurableArtifact, type BoundaryScanConfig } from "./private-artifacts.js";

const SHA = "a".repeat(64);

function fileRef(artifactId: string, path: string) {
  return { artifactId, path, sha256: SHA };
}

// ---------------------------------------------------------------------------
// Synthetic 25-case manifest builder (15 product + 5 migration + 5 safety).
// ---------------------------------------------------------------------------

interface CaseSeed {
  caseId: string;
  family: "product" | "migration" | "safety";
}

const PRODUCT_CASES: CaseSeed[] = [
  { caseId: "stablecoin-home", family: "product" },
  { caseId: "product-2", family: "product" },
  { caseId: "product-3", family: "product" },
  { caseId: "product-4", family: "product" },
  { caseId: "product-5", family: "product" },
  { caseId: "product-6", family: "product" },
  { caseId: "product-7", family: "product" },
  { caseId: "product-8", family: "product" },
  { caseId: "product-9", family: "product" },
  { caseId: "product-10", family: "product" },
  { caseId: "product-11", family: "product" },
  { caseId: "product-12", family: "product" },
  { caseId: "product-13", family: "product" },
  { caseId: "product-14", family: "product" },
  { caseId: "product-15", family: "product" },
];

const MIGRATION_CASES: CaseSeed[] = [
  { caseId: "public-marketing-migration", family: "migration" },
  { caseId: "migration-2", family: "migration" },
  { caseId: "migration-3", family: "migration" },
  { caseId: "migration-4", family: "migration" },
  { caseId: "migration-5", family: "migration" },
];

const SAFETY_CASES: CaseSeed[] = [
  { caseId: "named-inspiration-safety", family: "safety" },
  { caseId: "safety-conflicting-evidence", family: "safety" },
  { caseId: "safety-3", family: "safety" },
  { caseId: "safety-4", family: "safety" },
  { caseId: "safety-5", family: "safety" },
];

const REQUIRED_INDEPENDENT_IDS = [
  "stablecoin-home",
  "finance-news-story-detail",
  "public-marketing-migration",
  "safety-conflicting-evidence",
  "named-inspiration-safety",
];

function caseRef(seed: CaseSeed) {
  return {
    schemaVersion: "1.0" as const,
    artifactType: "c2-case-package" as const,
    artifactId: `c2-package-${seed.caseId}-v1`,
    caseId: seed.caseId,
    caseVersion: 1,
    family: seed.family,
    brief: fileRef(`c2-brief-${seed.caseId}-v1`, `eval/c2/cases/${seed.caseId}/brief.json`),
    label: fileRef(`c2-label-${seed.caseId}-v1`, `eval/c2/cases/${seed.caseId}/label.json`),
    sourceSnapshot: seed.family === "migration"
      ? fileRef(`design-source-snapshot-${seed.caseId}-v1`, `eval/c2/cases/${seed.caseId}/snapshot.json`)
      : null,
    goldEvidenceDescriptor: fileRef(
      `c2-gold-evidence-${seed.caseId}-v1`,
      `eval/c2/cases/${seed.caseId}/evidence.json`,
    ),
  };
}

interface BuildOpts {
  cases?: ReturnType<typeof caseRef>[];
  independentCaseIds?: string[];
  totalPlannedRuns?: number;
  frozenRef?: ReturnType<typeof fileRef>;
}

function buildManifest(opts: BuildOpts = {}) {
  const cases = opts.cases ?? [
    ...PRODUCT_CASES.map(caseRef),
    ...MIGRATION_CASES.map(caseRef),
    ...SAFETY_CASES.map(caseRef),
  ];
  const manifest: Record<string, unknown> = {
    schemaVersion: "1.0",
    artifactType: "c2-baseline-manifest",
    artifactId: "c2-baseline-v1",
    caseCount: 25,
    familyCounts: { product: 15, migration: 5, safety: 5 },
    cases,
    executionMatrix: {
      primaryConditions: ["brief-only", "current-grounded", "gold-evidence"],
      primaryCaseCount: 25,
      independentConditions: ["current-grounded"],
      independentCaseIds: opts.independentCaseIds ?? [...REQUIRED_INDEPENDENT_IDS],
      totalPlannedRuns: opts.totalPlannedRuns ?? 80,
    },
    frozenCalibrationRef: opts.frozenRef ?? fileRef(
      "c2-calibration-frozen-v1",
      "eval/c2/calibration/frozen.json",
    ),
    manifestSha256: "", // filled below
  };
  manifest.manifestSha256 = computeManifestSha256(manifest as Parameters<typeof computeManifestSha256>[0]);
  return manifest;
}

const SCAN_CONFIG: BoundaryScanConfig = { secretValues: [], secretEnvNames: [] };

describe("C2BaselineManifestSchema", () => {
  it("parses a valid 25-case manifest (15 product + 5 migration + 5 safety)", () => {
    const manifest = buildManifest();
    const result = C2BaselineManifestSchema.safeParse(manifest);
    expect(result.success, result.success ? "" : JSON.stringify(result.error.issues, null, 2)).toBe(true);
  });

  it("rejects a manifest with the wrong case count (24)", () => {
    const cases = [
      ...PRODUCT_CASES.slice(0, 14).map(caseRef),
      ...MIGRATION_CASES.map(caseRef),
      ...SAFETY_CASES.map(caseRef),
    ];
    // Rebuild familyCounts so the inner familyCounts object doesn't trip the
    // top-level literal check first — we want the count failure to surface.
    const manifest = buildManifest({ cases });
    // Override caseCount + cases length to 24 while keeping familyCounts at the
    // declared 15/5/5 so the superRefine family-count check (which counts the
    // cases array) is the actual failure.
    const malformed = {
      ...manifest,
      caseCount: 24,
      cases,
      familyCounts: { product: 14, migration: 5, safety: 5 },
      manifestSha256: "", // recomputed below
    };
    // Re-hashing against the malformed familyCounts is unnecessary for this
    // test (the parse fails before any hash check); empty placeholder is fine.
    void malformed.manifestSha256;
    const result = C2BaselineManifestSchema.safeParse(malformed);
    expect(result.success).toBe(false);
  });

  it("rejects wrong family counts (14 product)", () => {
    // 25 cases but familyCounts.product = 15 while only 14 product cases are
    // present — the superRefine family-count check must fail.
    const cases = [
      ...PRODUCT_CASES.slice(0, 14).map(caseRef),
      ...MIGRATION_CASES.map(caseRef),
      ...SAFETY_CASES.map(caseRef),
    ];
    const manifest = buildManifest({ cases });
    const result = C2BaselineManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /product/i.test(i.message))).toBe(true);
    }
  });

  it("rejects duplicate case IDs", () => {
    const cases = [
      ...PRODUCT_CASES.map(caseRef),
      ...MIGRATION_CASES.map(caseRef),
      ...SAFETY_CASES.map(caseRef),
    ];
    // Duplicate the first case's ID on the last entry.
    cases[cases.length - 1] = { ...cases[cases.length - 1]!, caseId: cases[0]!.caseId };
    const manifest = buildManifest({ cases });
    const result = C2BaselineManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /unique/i.test(i.message))).toBe(true);
    }
  });

  it("rejects wrong independent case IDs", () => {
    const wrongIds = [...REQUIRED_INDEPENDENT_IDS];
    wrongIds[0] = "not-a-real-case-id";
    const manifest = buildManifest({ independentCaseIds: wrongIds });
    const result = C2BaselineManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /independent/i.test(i.message))).toBe(true);
    }
  });

  it("rejects wrong totalPlannedRuns (79)", () => {
    const manifest = buildManifest({ totalPlannedRuns: 79 });
    const result = C2BaselineManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
    if (!result.success) {
      // The literal(80) check fires first; the issue surfaces on the
      // totalPlannedRuns path (and the superRefine math check is the
      // belt-and-suspenders backstop for the case where literals drift).
      const mentionsTotal = result.error.issues.some(
        (i) => /totalPlannedRuns/i.test(i.message)
          || i.path.some((p) => p === "totalPlannedRuns"),
      );
      expect(mentionsTotal).toBe(true);
    }
  });

  it("computeManifestSha256 is reproducible for identical content", () => {
    const manifest = buildManifest();
    const { manifestSha256, ...rest } = manifest;
    void manifestSha256;
    const hashA = computeManifestSha256(rest as Parameters<typeof computeManifestSha256>[0]);
    const hashB = computeManifestSha256(rest as Parameters<typeof computeManifestSha256>[0]);
    expect(hashA).toBe(hashB);
    expect(hashA).toMatch(/^[0-9a-f]{64}$/);
  });

  it("computeManifestSha256 changes when a case ID changes", () => {
    const manifest = buildManifest();
    const { manifestSha256, ...rest } = manifest;
    void manifestSha256;
    const base = rest as Parameters<typeof computeManifestSha256>[0];
    const hashA = computeManifestSha256(base);
    const modified = {
      ...base,
      cases: base.cases.map((c, i) => i === 0 ? { ...c, caseId: "changed-case-id" } : c),
    };
    const hashB = computeManifestSha256(modified);
    expect(hashA).not.toBe(hashB);
  });

  it("rejects a migration case whose sourceSnapshot is null", () => {
    const cases = [
      ...PRODUCT_CASES.map(caseRef),
      ...MIGRATION_CASES.map(caseRef),
      ...SAFETY_CASES.map(caseRef),
    ];
    // Null out the first migration case's source snapshot.
    const migrationIdx = cases.findIndex((c) => c.family === "migration");
    cases[migrationIdx] = { ...cases[migrationIdx]!, sourceSnapshot: null };
    const manifest = buildManifest({ cases });
    const result = C2BaselineManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /source snapshot/i.test(i.message))).toBe(true);
    }
  });

  it("the canonical JSON of a valid manifest passes scanDurableArtifact (no secrets/content/private paths)", () => {
    const manifest = buildManifest();
    const valid = C2BaselineManifestSchema.safeParse(manifest);
    expect(valid.success).toBe(true);
    const json = JSON.stringify(manifest);
    // A manifest with real secret env values would still fail; here we just
    // assert it carries no forbidden content-field shapes or private paths.
    expect(() => scanDurableArtifact(json, {
      secretValues: ["sk-not-present", "voyage-not-present"],
      secretEnvNames: ["OPENAI_API_KEY", "VOYAGE_API_KEY"],
    })).not.toThrow();
    // And the base config with no secrets must trivially pass too.
    expect(() => scanDurableArtifact(json, SCAN_CONFIG)).not.toThrow();
    // Sanity: the manifest carries only hashes + refs, no prompt content fields.
    expect(json).not.toContain(".c2-private/");
    expect(json).not.toContain('"prompt":');
    expect(json).not.toContain('"rawResponse":');
  });
});
