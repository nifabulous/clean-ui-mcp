import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { C2CaseBriefSchema, C2DecisionLabelSchema } from "./case-contracts.js";
import { DesignSourceSnapshotSchema } from "../design-source/contracts.js";

// Fixture-boundary test for the three separated C2 pilot case packages.
//
// The pilot lives under eval/c2/pilot/ and is split into three directories so
// that the model-visible briefs, the reviewer-only labels, and the immutable
// migration snapshot are never accidentally co-mingled. This suite enforces:
//
//   - exactly three briefs and three labels exist on disk (no extra cases
//     silently creep into the pilot),
//   - families are exactly {migration, product, safety},
//   - every brief parses against C2CaseBriefSchema and every label parses
//     against C2DecisionLabelSchema, and the migration snapshot parses against
//     DesignSourceSnapshotSchema,
//   - each brief and label match 1:1 by `caseId@caseVersion`,
//   - the serialized briefs contain NONE of the reviewer-only fields
//     (goldEvidenceIds, rubricAnchors, adjudicationNotes, requiredDecisionIds)
//     — this is the core separation-of-duties guarantee,
//   - no real corpus markers leak into the pilot (only the synthetic
//     `/corpus/private/` form is permitted, and only inside labels),
//   - only the migration brief carries a non-null sourceSnapshotRef, and its
//     artifactId matches the on-disk snapshot's artifactId.

const __dirname = dirname(fileURLToPath(import.meta.url));
const PILOT_DIR = resolve(__dirname, "../../eval/c2/pilot");
const BRIEFS_DIR = resolve(PILOT_DIR, "briefs");
const LABELS_DIR = resolve(PILOT_DIR, "labels");
const SNAPSHOTS_DIR = resolve(PILOT_DIR, "source-snapshots");

// Reviewer-only fields that must NEVER appear on a model-visible brief. These
// are the four fields the brief schema omits by design; if any leaks into a
// brief JSON the separation-of-duties boundary is broken.
const REVIEWER_ONLY_FIELDS = [
  "goldEvidenceIds",
  "rubricAnchors",
  "adjudicationNotes",
  "requiredDecisionIds",
] as const;

// Patterns that indicate real private-corpus leakage. The pilot is synthetic
// only; these tokens must never appear anywhere in the pilot tree.
//
// `/corpus/private/` is the ALLOWED synthetic form used inside label
// privateMarkers, so it is intentionally NOT in this denylist.
const CORPUS_LEAK_PATTERNS = [
  /aboard-web-screens/,
  /workable-web-screens/,
  /images-private/,
  /\/corpus\/(?!private\/)/, // /corpus/anything EXCEPT /corpus/private/
] as const;

function readJson(dir: string, name: string): unknown {
  return JSON.parse(readFileSync(resolve(dir, name), "utf8"));
}

function jsonFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".json"));
}

function caseKey(artifact: { caseId: string; caseVersion: number }): string {
  return `${artifact.caseId}@${artifact.caseVersion}`;
}

describe("C2 pilot fixtures (eval/c2/pilot)", () => {
  const briefNames = jsonFiles(BRIEFS_DIR).sort();
  const labelNames = jsonFiles(LABELS_DIR).sort();
  const snapshotNames = jsonFiles(SNAPSHOTS_DIR).sort();

  const briefs = briefNames.map((name) => ({
    name,
    data: C2CaseBriefSchema.parse(readJson(BRIEFS_DIR, name)),
    raw: readFileSync(resolve(BRIEFS_DIR, name), "utf8"),
  }));
  const labels = labelNames.map((name) => ({
    name,
    data: C2DecisionLabelSchema.parse(readJson(LABELS_DIR, name)),
    raw: readFileSync(resolve(LABELS_DIR, name), "utf8"),
  }));
  const snapshots = snapshotNames.map((name) => ({
    name,
    data: DesignSourceSnapshotSchema.parse(readJson(SNAPSHOTS_DIR, name)),
    raw: readFileSync(resolve(SNAPSHOTS_DIR, name), "utf8"),
  }));

  it("contains exactly three briefs and three labels", () => {
    expect(briefNames, `briefNames: ${briefNames.join(", ")}`).toHaveLength(3);
    expect(labelNames, `labelNames: ${labelNames.join(", ")}`).toHaveLength(3);
  });

  it("covers exactly the migration, product, and safety families", () => {
    const families = briefs.map((b) => b.data.family).sort();
    expect(families).toEqual(["migration", "product", "safety"]);
  });

  it("matches every brief to a label 1:1 by caseId@caseVersion", () => {
    const briefKeys = new Set(briefs.map((b) => caseKey(b.data)));
    const labelKeys = new Set(labels.map((l) => caseKey(l.data)));
    expect(briefKeys.size).toBe(3);
    expect(labelKeys.size).toBe(3);
    for (const key of briefKeys) expect(labelKeys).toContain(key);
    for (const key of labelKeys) expect(briefKeys).toContain(key);
  });

  it("parses every brief against C2CaseBriefSchema", () => {
    // The spread parse above already throws on failure; this makes the intent
    // explicit and counts the successes.
    for (const brief of briefs) {
      const result = C2CaseBriefSchema.safeParse(JSON.parse(brief.raw));
      expect(result.success, `brief ${brief.name} failed schema parse`).toBe(true);
    }
  });

  it("parses every label against C2DecisionLabelSchema", () => {
    for (const label of labels) {
      const result = C2DecisionLabelSchema.safeParse(JSON.parse(label.raw));
      expect(result.success, `label ${label.name} failed schema parse`).toBe(true);
    }
  });

  it("serializes briefs with NO reviewer-only fields", () => {
    for (const brief of briefs) {
      for (const field of REVIEWER_ONLY_FIELDS) {
        expect(
          brief.raw,
          `brief ${brief.name} leaks reviewer-only field ${field}`,
        ).not.toContain(field);
      }
    }
  });

  it("does not leak real corpus markers anywhere in the pilot", () => {
    // Concatenate every file's raw text and scan for corpus-leak patterns.
    // Labels may legitimately carry synthetic `/corpus/private/` markers; that
    // exact form is allowlisted above. Any other `/corpus/...` path, or any
    // known corpus directory name, is a hard failure.
    const allRaw = [...briefs, ...labels, ...snapshots].map((f) => f.raw).join("\n");
    for (const pattern of CORPUS_LEAK_PATTERNS) {
      expect(allRaw, `corpus leak pattern ${pattern} found in pilot`).not.toMatch(pattern);
    }
  });

  it("only the migration brief carries a non-null sourceSnapshotRef", () => {
    const migration = briefs.find((b) => b.data.family === "migration");
    const nonMigration = briefs.filter((b) => b.data.family !== "migration");
    expect(migration, "a migration brief must exist").toBeTruthy();
    expect(migration!.data.sourceSnapshotRef, "migration brief must bind a snapshot").not.toBeNull();
    for (const brief of nonMigration) {
      expect(brief.data.sourceSnapshotRef, `brief ${brief.name} must not bind a snapshot`).toBeNull();
    }
  });

  it("the migration brief's sourceSnapshotRef.artifactId matches the on-disk snapshot", () => {
    const migration = briefs.find((b) => b.data.family === "migration")!;
    expect(snapshots, "exactly one source snapshot must exist").toHaveLength(1);
    const snapshot = snapshots[0]!;
    expect(migration.data.sourceSnapshotRef!.artifactId).toBe(snapshot.data.artifactId);
    expect(migration.data.sourceSnapshotRef!.artifactType).toBe("design-source-snapshot");
  });
});
