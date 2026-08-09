import { describe, expect, it } from "vitest";
import { buildDisposition, DISPOSITION_FIELDS, validateDisposition } from "./retag-disposition.js";
import type { CorpusEntryT } from "./schema.js";

function entry(id: string): CorpusEntryT {
  return { id, visual: { typePairing: { display: null, body: null }, dominantColors: [], usesShadows: null, usesBorders: null }, categories: [], styleTags: [], components: [], source: { productName: id }, antiPatterns: { antiPatterns: [] } } as unknown as CorpusEntryT;
}

describe("retag disposition", () => {
  it("covers every corpus ID and every disposition field", () => {
    const artifact = buildDisposition([entry("b"), entry("a")], "a".repeat(64), "2026-08-09T00:00:00.000Z");
    expect(artifact.entryIds).toEqual(["a", "b"]);
    expect(Object.keys(artifact.fields).sort()).toEqual(DISPOSITION_FIELDS);
    expect(artifact.fields.colorScheme.status).toBe("defer-fill");
    expect(artifact.fields["visual.usesBorders"].status).toBe("defer-replacement");
    expect(artifact.fields["visual.typePairing"].status).toBe("structurally-unfillable");
  });

  it("rejects stale or partial artifacts", () => {
    const entries = [entry("a")];
    const artifact = buildDisposition(entries, "a".repeat(64), "2026-08-09T00:00:00.000Z");
    expect(() => validateDisposition(artifact, entries, "b".repeat(64))).toThrow(/different corpus/);
    const partial = { ...artifact, entryIds: [] };
    expect(() => validateDisposition(partial, entries, "a".repeat(64))).toThrow();
  });
});
