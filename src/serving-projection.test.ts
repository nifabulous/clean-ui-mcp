import { describe, expect, it } from "vitest";
import { projectForServing, renderOmittedDisclosure } from "./serving-projection.js";
import type { CorpusEntryT } from "./schema.js";

const RECORD = { method: "measured", verifiedAt: "2026-08-04", verifierVersion: "v1" };

function entryWith(verifiedFor: readonly string[]): CorpusEntryT {
  const verification: Record<string, unknown> = {};
  for (const field of verifiedFor) verification[field] = RECORD;
  return {
    id: "e1",
    source: { productName: "P" },
    whatToSteal: ["steal"],
    antiPatterns: { antiPatterns: ["anti"], accessibilityRisks: [] },
    visual: { typePairing: { display: "Inter", body: "Inter" } },
    provenance: { taggedBy: "auto", verification },
  } as unknown as CorpusEntryT;
}

describe("projectForServing", () => {
  it("keeps verified enrichment, lists the rest, and touches nothing else", () => {
    const entry = entryWith(["whatToSteal", "voice"]);
    const p = projectForServing(entry, ["whatToSteal", "voice", "antiPatterns", "visual.colorRoles"]);
    expect(p.served).toEqual(["whatToSteal", "voice"]);
    expect(p.omitted).toEqual(["antiPatterns", "visual.colorRoles"]);
  });

  it("exercises a real split — at least two verified and two unverified", () => {
    const entry = entryWith(["whatToSteal", "antiPatterns"]);
    const p = projectForServing(entry, [
      "whatToSteal", "antiPatterns", "voice", "visual.dominantColors",
    ]);
    expect(p.served).toEqual(["whatToSteal", "antiPatterns"]);
    expect(p.omitted).toEqual(["voice", "visual.dominantColors"]);
  });

  it("projects nested keys per leaf — parent verified, leaf unverified strips the leaf", () => {
    const entry = entryWith(["antiPatterns"]);
    const p = projectForServing(entry, ["antiPatterns", "antiPatterns.accessibilityRisks"]);
    expect(p.served).toEqual(["antiPatterns"]);
    expect(p.omitted).toEqual(["antiPatterns.accessibilityRisks"]);
  });

  it("projects nested keys per leaf — parent unverified drops the child even when the leaf verifies", () => {
    const entry = entryWith(["antiPatterns.accessibilityRisks"]);
    const p = projectForServing(entry, ["antiPatterns", "antiPatterns.accessibilityRisks"]);
    expect(p.served).toEqual(["antiPatterns.accessibilityRisks"]);
    expect(p.omitted).toEqual(["antiPatterns"]);
  });

  it("returns empty lists for a fully verified entry", () => {
    const p = projectForServing(entryWith(["whatToSteal", "voice"]), ["whatToSteal", "voice"]);
    expect(p.served).toEqual(["whatToSteal", "voice"]);
    expect(p.omitted).toEqual([]);
  });

  it("returns empty lists when enrichment is empty", () => {
    const p = projectForServing(entryWith([]), []);
    expect(p.served).toEqual([]);
    expect(p.omitted).toEqual([]);
  });
});

describe("renderOmittedDisclosure", () => {
  it("renders nothing for an empty omitted list", () => {
    expect(renderOmittedDisclosure([])).toBe("");
  });

  it("names the omitted fields for a non-empty list", () => {
    const disclosure = renderOmittedDisclosure(["whatToSteal", "antiPatterns.accessibilityRisks"]);
    expect(disclosure).toContain("Unverified fields omitted");
    expect(disclosure).toContain("whatToSteal");
    expect(disclosure).toContain("antiPatterns.accessibilityRisks");
  });
});