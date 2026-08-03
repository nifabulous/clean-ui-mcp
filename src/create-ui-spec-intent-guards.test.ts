/**
 * create-ui-spec-intent-guards.test.ts — durable guards for the positions the
 * design-intent work left otherwise unguarded.
 *
 * Each test below covers a gap that no existing gate catches. They are grouped
 * here rather than scattered through `create-ui-spec.test.ts` because each one
 * asserts a CROSS-MODULE property: producer → spec.context → semantic hash →
 * artifactId, or producer → design-handoff renderer, or producer → the MCP leaf
 * classification map. A guard that lives inside the module it guards tends to be
 * deleted with it.
 *
 * WHY THESE FOUR:
 *
 * 1. IDENTITY. Intent is recorded in `spec.context` precisely so that
 *    `buildSemanticSpecInput` (which hashes the whole spec) carries it into
 *    `semanticSpecSha256`, and from there into `artifactId`. Nothing enforces
 *    that chain — a future refactor could strip `context` from the semantic
 *    input, or record intent somewhere `buildSemanticSpecInput` does not reach,
 *    and every other test would stay green while two different design intents
 *    silently produced the same artifact identity.
 *
 * 2. NO PARALLEL IDENTITY LANE. The opposite failure: adding `colorIntent` to
 *    `ArtifactIdentityInput` or `EnvelopeHandoffSchema` as a SECOND copy would
 *    also make artifactIds differ — while the visible spec forgot to honor the
 *    intent. The guard is that the difference survives a spec-only recomputation.
 *
 * 3. GRAMMAR. `design-handoff.ts` renders acceptance criteria as
 *    "<subject> <assertion> → <expectedOutcome>". Caller constraints became
 *    criteria; if a future change puts a fixed label back in `subject`, the
 *    rendered line reads as a claim about nothing and no schema objects.
 *
 * 4. PROVENANCE TRUTHFULNESS. `classifyCreateUiSpecLeaf` returns immediately for
 *    the `free-text` class, so the ANNOTATION TEXT in
 *    `CREATE_UI_SPEC_FREE_TEXT_LEAVES` is never checked by anything. An
 *    annotation saying "recipe-owned" over a position that now carries caller
 *    prose is an authority upgrade recorded in the product's own machine-readable
 *    provenance map — the honesty invariant's machine-readable half.
 *
 * NO NETWORK, NO PROVIDER, NO CORPUS. Every artifact here is produced by the
 * real producer over an empty in-memory reader.
 */
import { describe, expect, it } from "vitest";

import { createUiSpecForAdapter, type CreateUiSpecDependencies } from "./create-ui-spec.js";
import {
  buildArtifactIdentityInput,
  buildSemanticSpecInput,
  parseDesignArtifactEnvelope,
  sha256Canonical,
} from "./create-ui-spec-contracts.js";
import { parseDesignHandoff, NEUTRAL_WEB_TARGET } from "./design-target-contracts.js";
import { renderDesignHandoffMarkdown } from "./design-handoff.js";
import {
  CREATE_UI_SPEC_FREE_TEXT_LEAVES,
  findUnsafeCreateUiSpecLeaves,
  type UiSpecT,
} from "./tool-contracts.js";
import type { CorpusEntryT } from "./schema.js";
import type { CorpusReader } from "./corpus-reader.js";

/**
 * An empty in-memory reader. Retrieval matches nothing, so every artifact here
 * is the deterministic fallback — which is the point: the only thing that varies
 * between two artifacts in these tests is the caller's own input.
 */
function emptyReader(): CorpusReader {
  return {
    search: async () => [] as CorpusEntryT[],
    searchRanked: async () => [],
    getById: () => undefined,
    findSimilar: () => [],
    listCategories: () => [],
    listStyleTags: () => [],
    listDomainTags: () => [],
    indexStatus: () => ({
      indexed: 0,
      total: 0,
      hasIndex: false,
      missing: 0,
      stale: 0,
      contentStale: 0,
    }),
    entriesForAggregation: () => [] as readonly CorpusEntryT[],
    resolveImagePath: () => null,
  } as unknown as CorpusReader;
}

function deps(): CreateUiSpecDependencies {
  return {
    reader: emptyReader(),
    resolveReferenceToken: () => undefined,
    // A FIXED clock. `semanticSpecSha256` is timestamp-independent by
    // construction, but `artifactId` is derived from it and `specSha256` is not —
    // pinning the clock keeps the only varying input the caller's own request.
    now: () => new Date("2026-08-01T00:00:00.000Z"),
  };
}

const BRIEF = "A settings screen for two-factor setup";

function request(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    productContext: BRIEF,
    referenceIds: [],
    constraints: [],
    motionIntents: [],
    ...over,
  };
}

describe("design intent reaches artifact identity through spec.context", () => {
  it("gives two requests differing only in colorIntent distinct semantic hashes and artifactIds", async () => {
    const a = await createUiSpecForAdapter(
      request({ colorIntent: { accentPreference: "light blue" } }),
      deps(),
    );
    const b = await createUiSpecForAdapter(
      request({ colorIntent: { accentPreference: "warm red" } }),
      deps(),
    );
    expect(a.envelope.semanticSpecSha256).not.toBe(b.envelope.semanticSpecSha256);
    expect(a.envelope.artifactId).not.toBe(b.envelope.artifactId);
  });

  it("gives two requests differing only in typeIntent distinct semantic hashes and artifactIds", async () => {
    const a = await createUiSpecForAdapter(
      request({ typeIntent: { density: "compact" } }),
      deps(),
    );
    const b = await createUiSpecForAdapter(
      request({ typeIntent: { density: "spacious" } }),
      deps(),
    );
    expect(a.envelope.semanticSpecSha256).not.toBe(b.envelope.semanticSpecSha256);
    expect(a.envelope.artifactId).not.toBe(b.envelope.artifactId);
  });

  it("distinguishes intent supplied from intent absent", async () => {
    const withIntent = await createUiSpecForAdapter(
      request({ colorIntent: { mood: "calm" } }),
      deps(),
    );
    const without = await createUiSpecForAdapter(request(), deps());
    expect(withIntent.envelope.semanticSpecSha256).not.toBe(without.envelope.semanticSpecSha256);
    expect(withIntent.envelope.artifactId).not.toBe(without.envelope.artifactId);
  });

  it("derives the identity difference from spec.context alone, not a parallel identity lane", async () => {
    // The load-bearing guard. Recompute BOTH semantic hashes from `spec` only,
    // and BOTH artifactIds from those recomputed hashes plus the stored handoff
    // inputs. If intent were carried by a second, non-spec identity field, the
    // envelopes' artifactIds would differ (test 1 above) while these
    // spec-derived recomputations came out EQUAL — because the spec would have
    // forgotten the intent the identity claims to cover.
    const a = await createUiSpecForAdapter(
      request({ colorIntent: { accentPreference: "light blue" } }),
      deps(),
    );
    const b = await createUiSpecForAdapter(
      request({ colorIntent: { accentPreference: "warm red" } }),
      deps(),
    );

    const semantic = (spec: UiSpecT) => sha256Canonical(buildSemanticSpecInput(spec));
    const semA = semantic(a.envelope.spec);
    const semB = semantic(b.envelope.spec);
    expect(semA).not.toBe(semB);
    // …and the recomputation agrees with what the producer stored.
    expect(semA).toBe(a.envelope.semanticSpecSha256);
    expect(semB).toBe(b.envelope.semanticSpecSha256);

    const identity = (env: typeof a.envelope, semanticSha: string) =>
      `uispec-${sha256Canonical(
        buildArtifactIdentityInput({
          producerVersion: env.producerVersion,
          assemblyRulesSha256: env.assemblyRulesSha256,
          semanticSpecSha256: semanticSha,
          target: env.handoff.target,
          motionIntents: env.handoff.motionIntents,
        }),
      )}`;
    expect(identity(a.envelope, semA)).not.toBe(identity(b.envelope, semB));
    expect(identity(a.envelope, semA)).toBe(a.envelope.artifactId);
    expect(identity(b.envelope, semB)).toBe(b.envelope.artifactId);
  });

  it("keeps the full envelope round-trip green with intent present", async () => {
    const res = await createUiSpecForAdapter(
      request({
        colorIntent: { accentPreference: "muted teal", mood: "calm", contrastFloor: "AA" },
        typeIntent: { voice: "plainspoken", density: "compact" },
      }),
      deps(),
    );
    // Re-renders, re-hashes and re-derives the identity; throws on any mismatch.
    expect(() => parseDesignArtifactEnvelope(res.envelope)).not.toThrow();
  });

  it("records intent without materializing tokens", async () => {
    const res = await createUiSpecForAdapter(
      request({
        colorIntent: { accentPreference: "light blue", contrastFloor: "AAA" },
        typeIntent: { voice: "plainspoken" },
      }),
      deps(),
    );
    const spec = res.envelope.spec;
    // Intent is a STATEMENT OF WANT, not a decision. Synthesizing the five
    // required ColorTokens members from a mood word would be invention.
    expect(spec.colorTokens).toBeNull();
    expect(spec.typographyTokens).toBeNull();
    expect(spec.colorTokenAuthority).toBe("editorial");
    expect(spec.typographyTokenAuthority).toBe("editorial");
    const unavailableFields = spec.unavailableDecisions.map((d) => d.field);
    expect(unavailableFields).toContain("colorTokens");
    expect(unavailableFields).toContain("typographyTokens");
  });
});

describe("design intent and caller constraints are visible in the rendered handoff", () => {
  async function markdownFor(over: Record<string, unknown>): Promise<string> {
    const res = await createUiSpecForAdapter(request(over), deps());
    const handoff = parseDesignHandoff({
      spec: res.envelope.spec,
      target: NEUTRAL_WEB_TARGET,
      motionIntents: [],
      generatedAt: res.envelope.generatedAt,
    });
    return renderDesignHandoffMarkdown(handoff);
  }

  it("renders colour and typography intent, labelled as caller-supplied", async () => {
    const md = await markdownFor({
      colorIntent: { accentPreference: "muted teal", contrastFloor: "AA" },
      typeIntent: { voice: "plainspoken", density: "compact" },
    });
    expect(md).toContain("muted teal");
    expect(md).toContain("plainspoken");
    // The label must not read as though a token decision was made from the intent.
    expect(md).toMatch(/Colour intent \(caller-supplied, not a token decision\)/);
    expect(md).toMatch(/Typography intent \(caller-supplied, not a token decision\)/);
  });

  it("renders every caller-constraint criterion as a grammatical sentence", async () => {
    const constraints = ["AA contrast", "primary action always visible"];
    const res = await createUiSpecForAdapter(request({ constraints }), deps());
    const handoff = parseDesignHandoff({
      spec: res.envelope.spec,
      target: NEUTRAL_WEB_TARGET,
      motionIntents: [],
      generatedAt: res.envelope.generatedAt,
    });
    const md = renderDesignHandoffMarkdown(handoff);

    // The renderer emits "- **<id>** [<priority>] <subject> <assertion> → <expectedOutcome> (verifier: …)".
    // The guard is that <subject> is the caller's own constraint text: with a
    // fixed label like "caller-supplied constraint" the line would read
    // "caller-supplied constraint exists", a claim about nothing.
    for (const [i, text] of constraints.entries()) {
      const line = md
        .split("\n")
        .find((l) => l.includes(`**caller-constraint-${i + 1}**`));
      expect(line, `no rendered line for caller-constraint-${i + 1}`).toBeDefined();
      expect(line!).toContain(`[should] ${text} exists →`);
      expect(line!).toContain(`The delivered UI satisfies this caller-stated constraint: ${text}`);
      expect(line!).toContain("(verifier: manual)");
    }
  });
});

describe("leaf-annotation truthfulness for the caller-owned positions", () => {
  it("classifies every leaf of a constrained, intent-bearing artifact", async () => {
    const res = await createUiSpecForAdapter(
      request({
        constraints: ["AA contrast", "primary action always visible"],
        colorIntent: { accentPreference: "muted teal", mood: "calm", contrastFloor: "AA" },
        typeIntent: { voice: "plainspoken", density: "compact" },
      }),
      deps(),
    );
    // The gate FAILS CLOSED on any string at an unclassified position, so an
    // unannotated new leaf shows up here rather than shipping unnoticed.
    const found = findUnsafeCreateUiSpecLeaves({
      data: res.envelope.spec,
      referenceIds: res.envelope.spec.citedReferences,
      evidence: [],
    });
    expect(found.map((f) => f.position)).toEqual([]);
  });

  it("annotates the intent positions as caller-supplied, never as recipe-owned", () => {
    const intentPositions = [
      "data.context.colorIntent.accentPreference",
      "data.context.colorIntent.mood",
      "data.context.typeIntent.voice",
    ] as const;
    for (const position of intentPositions) {
      const note = (CREATE_UI_SPEC_FREE_TEXT_LEAVES as Record<string, string | undefined>)[
        position
      ];
      expect(note, `${position} has no annotation`).toBeDefined();
      expect(note!).toMatch(/caller-supplied/i);
      expect(note!).not.toMatch(/recipe-owned/i);
    }
  });

  it("annotates the acceptance-criteria prose positions as carrying BOTH lanes", () => {
    // These three positions used to be annotated "recipe-owned" without
    // qualification. Since caller constraints became criteria they carry caller
    // prose too, and the annotation is the product's own machine-readable claim
    // about who authored the value. Naming only the recipe lane is an authority
    // upgrade that no runtime check would object to.
    const dualLane = [
      "data.acceptanceCriteria[].subject",
      "data.acceptanceCriteria[].expectedOutcome",
      "data.acceptanceCriteria[].manualSteps[]",
      "data.acceptanceCriteria[].id",
    ] as const;
    for (const position of dualLane) {
      const note = (CREATE_UI_SPEC_FREE_TEXT_LEAVES as Record<string, string | undefined>)[
        position
      ];
      expect(note, `${position} has no annotation`).toBeDefined();
      expect(note!, `${position} must name the caller lane`).toMatch(/caller/i);
      expect(note!, `${position} must still name the recipe lane`).toMatch(/recipe|caller-constraint/i);
    }
  });

  it("annotates designDirection as carrying the brief echo AND identity-screened corpus prose", () => {
    // Plan 2 gave this position a second author (corpus-fact synthesis)
    // alongside the brief echo; C3 Phase 1 Task 5 added identity-screened
    // corpus PROSE (mood, type notes, critique) to the composed direction.
    // The annotation must name all three sources and must not claim model
    // authorship.
    const note = (CREATE_UI_SPEC_FREE_TEXT_LEAVES as Record<string, string | undefined>)[
      "data.designDirection"
    ];
    expect(note, "data.designDirection has no annotation").toBeDefined();
    expect(note!, "must name the brief-echo source").toMatch(/brief/i);
    expect(note!, "must name the corpus-fact source").toMatch(/structuredFacts|evidence ids/i);
    expect(note!, "must name the identity-screened corpus prose source").toMatch(/critique|mood/i);
    expect(note!, "must explicitly exclude model authorship").toMatch(/never model output/i);
  });

  it("annotates the corpus-judgment prose positions as corpus-derived and identity-screened", () => {
    // Task 4 made these positions carry corpus prose (whatToSteal,
    // antiPatterns.antiPatterns, voice, accessibilityRisks) through the
    // identity screen. An annotation left at "recipe-owned" would be an
    // authority upgrade recorded in the product's own provenance map — the
    // same stale-annotation class that bit designDirection.
    const corpusProsePositions = [
      "data.techniques[].text",
      "data.antiPatterns[].text",
      "data.contentVoiceGuidance",
      "data.accessibilityConstraints[]",
    ] as const;
    for (const position of corpusProsePositions) {
      const note = (CREATE_UI_SPEC_FREE_TEXT_LEAVES as Record<string, string | undefined>)[
        position
      ];
      expect(note, `${position} has no annotation`).toBeDefined();
      expect(note!, `${position} must name the corpus lane`).toMatch(/corpus/i);
      expect(note!, `${position} must be screened`).toMatch(/screen/i);
      expect(note!, `${position} must not claim recipe ownership`).not.toMatch(/^recipe-owned/i);
    }
  });
});
