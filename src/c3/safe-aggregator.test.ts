/**
 * safe-aggregator.test.ts — TDD for the deterministic, sanitized-only
 * aggregator that backs the c3-fallback-v1 producer.
 *
 * The safe aggregator accepts ONLY branded `SanitizedEvidence[]` (+ the parsed
 * request + the checked-in recipe). It must NEVER receive raw `CorpusEntryT`
 * prose — the type boundary is the safety guarantee. This suite covers:
 *  - closed-vocabulary aggregation (pattern-type histogram),
 *  - deterministic ordering (pattern, then evidence id),
 *  - recipe-owned summaries (echo productContext, fixed-empty arrays),
 *  - a raw-corpus type-boundary test (`@ts-expect-error` proves the boundary).
 */
import { describe, expect, it } from "vitest";
import type { CreateUiSpecRequest } from "../create-ui-spec-contracts.js";
import type { SanitizedEvidence } from "../create-ui-spec-contracts.js";
import type { CorpusEntryT } from "../schema.js";
import recipe from "./fallback-recipe-v1.json" with { type: "json" };
import {
  aggregatePatternHistogram,
  buildDesignDirectionSummary,
  buildRationale,
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

describe("aggregatePatternHistogram", () => {
  it("returns an empty histogram for no evidence", () => {
    const h = aggregatePatternHistogram([]);
    expect(h).toEqual([]);
  });

  it("counts only the closed structuredFacts.pattern key", () => {
    const h = aggregatePatternHistogram([
      evidence({ structuredFacts: { pattern: "dashboard" } }, "evidence-1"),
      evidence({ structuredFacts: { pattern: "dashboard" } }, "evidence-2"),
      evidence({ structuredFacts: { pattern: "pricing" } }, "evidence-3"),
      evidence({ structuredFacts: {} }, "evidence-4"),
    ]);
    // Sorted by pattern ascending; entries without a pattern are omitted.
    expect(h).toEqual([
      { pattern: "dashboard", count: 2 },
      { pattern: "pricing", count: 1 },
    ]);
  });

  it("orders deterministically (pattern ascending, ties broken by count then id)", () => {
    const h = aggregatePatternHistogram([
      evidence({ structuredFacts: { pattern: "pricing" } }, "evidence-1"),
      evidence({ structuredFacts: { pattern: "dashboard" } }, "evidence-2"),
      evidence({ structuredFacts: { pattern: "dashboard" } }, "evidence-3"),
    ]);
    expect(h.map((r) => r.pattern)).toEqual(["dashboard", "pricing"]);
  });

  it("never reads raw corpus prose (type boundary)", () => {
    // @ts-expect-error — CorpusEntryT[] is NOT assignable to SanitizedEvidence[].
    // The function signature enforces the branded-evidence type boundary; raw
    // corpus entries must not be passed (sanitizing after raw-corpus synthesis
    // is explicitly out of bounds).
    const rawCorpus: CorpusEntryT[] = [] as unknown as CorpusEntryT[];
    aggregatePatternHistogram(rawCorpus);
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

describe("buildRationale", () => {
  it("produces a bounded recipe-owned rationale string", () => {
    const r = buildRationale("designDirection", recipe);
    expect(typeof r).toBe("string");
    expect(r.length).toBeGreaterThanOrEqual(1);
    expect(r.length).toBeLessThanOrEqual(1_000);
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
