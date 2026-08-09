import { describe, expect, it } from "vitest";
import { Corpus, type CorpusEntryT } from "../schema.js";
import { carryMigrationVerification, priorEntriesFromRaw } from "./migration-carry.js";

const record = (field: string) => ({
  method: "image-confirmed",
  verifiedAt: "2026-08-09",
  verifierVersion: "test",
  imageSha256: `${field}`.padEnd(64, "0"),
});

function entry(overrides: Partial<CorpusEntryT> = {}): CorpusEntryT {
  return {
    id: "sample",
    title: "Sample",
    patternType: "dashboard",
    categories: ["dashboard"],
    styleTags: ["minimal"],
    components: [],
    source: { productName: "Sample", url: null, capturedAt: "2026-08-09", capturedBy: "self" },
    image: { visibility: "private", path: "images-private/sample.png", width: 100, height: 100 },
    platform: "web",
    visual: {
      dominantColors: ["#ffffff"],
      accentColor: null,
      typePairing: { display: null, body: null, notes: "" },
      spacingDensity: "moderate",
      cornerStyle: "slight-round",
      usesShadows: null,
      usesBorders: true,
    },
    critique: "A sufficiently long critique that describes the visible design decisions in this sample.",
    whatToSteal: ["Use the sample's visible grouping to reduce scanning effort."],
    antiPatterns: { antiPatterns: ["Avoid mixing unrelated actions in one control group."], whereThisFails: [], accessibilityRisks: [] },
    provenance: {
      taggedBy: "auto",
      verification: {
        critique: record("critique"),
        layout: record("layout"),
        platform: record("platform"),
        antiPatterns: record("antiPatterns"),
        "antiPatterns.accessibilityRisks": record("risks"),
      },
    },
    ...overrides,
  };
}

describe("carryMigrationVerification", () => {
  it("drops verification for a newly populated layout while retaining unchanged claims", () => {
    const prior = entry();
    const next = entry({ layout: { form: "single-column", regions: [{ role: "main-canvas" }] } });
    const [out] = carryMigrationVerification([next], [prior]);

    expect(out.provenance?.verification).toMatchObject({ critique: record("critique"), antiPatterns: record("antiPatterns") });
    expect(out.provenance?.verification).not.toHaveProperty("layout");
  });

  it("drops verification when a deterministic platform migration changes the claim", () => {
    const prior = entry({ platform: "tablet" });
    const next = entry({ platform: "mobile" });
    const [out] = carryMigrationVerification([next], [prior]);

    expect(out.provenance?.verification).not.toHaveProperty("platform");
    expect(out.provenance?.verification).toHaveProperty("critique");
  });

  it("drops only the changed accessibility-risk claim when WCAG normalization leaves prose intact", () => {
    const prior = entry({
      antiPatterns: {
        antiPatterns: ["Avoid mixing unrelated actions in one control group."],
        whereThisFails: [],
        accessibilityRisks: [{ element: "button", risk: "The button has weak contrast.", evidence: "Visible button label", confidence: "visible", wcag: ["1.4.3"] }],
      },
    });
    const next = entry({
      antiPatterns: {
        antiPatterns: ["Avoid mixing unrelated actions in one control group."],
        whereThisFails: [],
        accessibilityRisks: [],
      },
    });
    const [out] = carryMigrationVerification([next], [prior]);

    expect(out.provenance?.verification).toHaveProperty("antiPatterns");
    expect(out.provenance?.verification).not.toHaveProperty("antiPatterns.accessibilityRisks");
  });
});

// ── The wiring defect the pure-function tests could not see ──────────────────
//
// migrate-wcag-ids.ts derived its prior entries as
//   Corpus.safeParse(raw).success ? parsed.entries : []
// but that script exists to migrate a LEGACY shape, and says so at :191 ("this
// migration may begin with a legacy shape that the current schema cannot parse").
// On exactly that input safeParse fails, prior becomes [], and carryVerification
// with no prior drops EVERY record on EVERY entry — ~447 records across 50
// entries, silently. Fail-closed, so nothing false is served, but it destroys the
// evidence Task 3 was written to protect.
//
// The prior side must come from the raw array, which is what the script already
// uses for its own work (`const entries = raw.entries`).
describe("priorEntriesFromRaw survives an unparseable corpus", () => {
  const legacyRisk = { note: "colour-only status", severity: "medium" };
  const rawCorpus = (over: Record<string, unknown> = {}) => ({
    version: 2,
    entries: [{
      id: "legacy-1",
      // Deliberately NOT schema-valid: a legacy accessibilityRisks shape plus a
      // missing required block. This is the input the migration is for.
      antiPatterns: { antiPatterns: ["x"], whereThisFails: [], accessibilityRisks: [legacyRisk] },
      provenance: {
        taggedBy: "auto",
        verification: {
          critique: { method: "image-confirmed", verifiedAt: "t", verifierVersion: "v", imageSha256: "a".repeat(64) },
          // A record for the field the migration CHANGES. Without this the
          // "drops the changed record" assertion below passes vacuously — there
          // would be nothing to drop.
          antiPatterns: { method: "image-confirmed", verifiedAt: "t", verifierVersion: "v", imageSha256: "b".repeat(64) },
        },
      },
      ...over,
    }],
  });

  it("returns the raw entries when the corpus does not parse", () => {
    const raw = rawCorpus();
    expect(Corpus.safeParse(raw).success).toBe(false); // the premise
    const prior = priorEntriesFromRaw(raw);
    expect(prior).toHaveLength(1);
    expect(prior[0].id).toBe("legacy-1");
  });

  it("keeps the verification map reachable, so the carry has something to carry", () => {
    const prior = priorEntriesFromRaw(rawCorpus());
    expect(prior[0].provenance?.verification?.critique).toBeDefined();
  });

  it("a legacy migration that leaves a field alone KEEPS its record", () => {
    // The regression test for the defect: previously prior was [] here, so this
    // record was dropped.
    const raw = rawCorpus();
    const prior = priorEntriesFromRaw(raw);
    const migrated = structuredClone(raw.entries) as never as CorpusEntryT[];
    const out = carryMigrationVerification(migrated, prior);
    expect(out[0].provenance?.verification?.critique).toBeDefined();
  });

  it("and still drops the record for a field the migration changed", () => {
    const raw = rawCorpus();
    const prior = priorEntriesFromRaw(raw);
    // The premise: there IS a record to lose. Asserted so this cannot pass
    // vacuously if the fixture ever stops carrying one.
    expect(prior[0].provenance?.verification?.antiPatterns).toBeDefined();
    const migrated = structuredClone(raw.entries) as never as Array<Record<string, unknown>>;
    (migrated[0].antiPatterns as { antiPatterns: string[] }).antiPatterns = ["rewritten"];
    const out = carryMigrationVerification(migrated as never, prior);
    expect(out[0].provenance?.verification?.critique).toBeDefined(); // untouched
    expect(out[0].provenance?.verification?.antiPatterns).toBeUndefined();
  });

  // Root-array corpora: `[].entries` is Array.prototype.entries, a function, so a
  // naive `.entries` read returns [] and drops every record.
  it("handles a corpus stored as a root array, not an envelope", () => {
    const rootArray = rawCorpus().entries;
    const prior = priorEntriesFromRaw(rootArray);
    expect(prior).toHaveLength(1);
    expect(prior[0].provenance?.verification?.critique).toBeDefined();
  });

  it("carries records through a root-array corpus unchanged", () => {
    const rootArray = rawCorpus().entries;
    const out = carryMigrationVerification(
      structuredClone(rootArray) as never,
      priorEntriesFromRaw(rootArray),
    );
    expect(out[0].provenance?.verification?.critique).toBeDefined();
  });

  it("returns an empty list for a corpus with no entries array at all", () => {
    expect(priorEntriesFromRaw({})).toEqual([]);
    expect(priorEntriesFromRaw({ entries: null })).toEqual([]);
  });

  it("does not alias the input — mutating the result cannot change the raw corpus", () => {
    const raw = rawCorpus();
    const prior = priorEntriesFromRaw(raw);
    (prior[0] as Record<string, unknown>).id = "mutated";
    expect((raw.entries[0] as { id: string }).id).toBe("legacy-1");
  });
});
