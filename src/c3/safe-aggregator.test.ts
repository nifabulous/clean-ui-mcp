/**
 * safe-aggregator.test.ts — TDD for the deterministic, sanitized-only
 * aggregator that backs the c3-fallback-v1 producer.
 *
 * The safe aggregator accepts ONLY branded `SanitizedEvidence[]` (+ the parsed
 * request + the checked-in recipe). It must NEVER receive raw `CorpusEntryT`
 * prose — the type boundary is the safety guarantee. This suite covers the
 * helpers the producer actually consumes:
 *  - recipe-owned summaries (echo productContext, fixed-empty arrays, corpus-
 *    observation summary template),
 *  - a raw-corpus type-boundary test (`@ts-expect-error` proves the boundary).
 *
 * NOTE: aggregatePatternHistogram and buildRationale were removed as dead code
 * (YAGNI) — they had zero production call sites and were exercised only by
 * their own unit tests.
 */
import { describe, expect, it } from "vitest";
import type { CreateUiSpecRequest } from "../create-ui-spec-contracts.js";
import type { SanitizedEvidence } from "../create-ui-spec-contracts.js";
import type { CorpusEntryT } from "../schema.js";
import recipe from "./fallback-recipe-v1.json" with { type: "json" };
import {
  buildCorpusObservationSummary,
  buildDesignDirectionSummary,
  buildFixedEmptyArrays,
} from "./safe-aggregator.js";

function evidence(over: Partial<SanitizedEvidence> = {}, id = "evidence-1"): SanitizedEvidence {
  return {
    id,
    kind: "corpus-observation",
    basis: "visible",
    summary: "Sanitized summary.",
    structuredFacts: { pattern: "dashboard" },
    ...over,
  } as SanitizedEvidence;
}

function request(over: Partial<CreateUiSpecRequest> = {}): CreateUiSpecRequest {
  return {
    productContext: "A calm analytics dashboard for a fintech",
    referenceIds: [],
    constraints: [],
    motionIntents: [],
    ...over,
  };
}

describe("buildCorpusObservationSummary", () => {
  it("builds a pattern + region-count summary when both facts are present", () => {
    const summary = buildCorpusObservationSummary(
      evidence({ structuredFacts: { pattern: "dashboard", regionCount: 3 } }),
    );
    expect(summary).toBe("dashboard reference with 3 regions");
  });

  it("builds a pattern-only summary when regionCount is absent", () => {
    const summary = buildCorpusObservationSummary(
      evidence({ structuredFacts: { pattern: "pricing" } }),
    );
    expect(summary).toBe("pricing reference");
  });

  it("falls back to a generic, pattern-free summary when no pattern is set", () => {
    const summary = buildCorpusObservationSummary(evidence({ structuredFacts: {} }));
    expect(summary).toBe("Corpus observation reference");
  });

  it("never reads raw corpus prose (type boundary)", () => {
    // @ts-expect-error — CorpusEntryT is NOT assignable to SanitizedEvidence.
    // The function signature enforces the branded-evidence type boundary; raw
    // corpus entries must not be passed (sanitizing after raw-corpus synthesis
    // is explicitly out of bounds).
    const rawCorpus: CorpusEntryT = {} as unknown as CorpusEntryT;
    buildCorpusObservationSummary(rawCorpus);
    expect(true).toBe(true);
  });
});

describe("buildDesignDirectionSummary", () => {
  it("echoes the requester's productContext (echo-product-context strategy)", () => {
    const dir = buildDesignDirectionSummary(request({ productContext: "A calm analytics dashboard for a fintech" }), recipe);
    expect(dir).toBe("A calm analytics dashboard for a fintech");
  });

  it("truncates an over-long productContext to the bounded-text limit", () => {
    const long = "x".repeat(3_000);
    const dir = buildDesignDirectionSummary(request({ productContext: long }), recipe);
    // BoundedTextValue max is 2_000; the producer's candidate builder enforces
    // it, but the aggregator truncates defensively so the candidate always
    // parses.
    expect(dir.length).toBeLessThanOrEqual(2_000);
    expect(dir.startsWith("x")).toBe(true);
  });
});

describe("buildFixedEmptyArrays", () => {
  it("returns empty arrays for the fixed-empty strategy fields", () => {
    const arrays = buildFixedEmptyArrays(recipe);
    // Every fixed-empty/empty/unavailable strategy field yields an empty array
    // (or omitted). The producer maps these into the candidate.
    expect(Array.isArray(arrays.rejectedDefaults)).toBe(true);
    expect(arrays.rejectedDefaults).toEqual([]);
    expect(arrays.layoutRegions).toEqual([]);
    expect(arrays.responsiveBehavior).toEqual([]);
    expect(arrays.componentInventory).toEqual([]);
    expect(arrays.interactions).toEqual([]);
    expect(arrays.accessibilityConstraints).toEqual([]);
    expect(arrays.techniques).toEqual([]);
    expect(arrays.antiPatterns).toEqual([]);
    expect(arrays.citedDecisions).toEqual([]);
    expect(arrays.citedReferences).toEqual([]);
  });
});
