import { describe, expect, it } from "vitest";
import { createUiSpecDeterministic } from "./create-ui-spec-deterministic.js";
import type { CorpusEntryT } from "./schema.js";

function observation(id: string, facts: Record<string, unknown>): never {
  return { id, kind: "corpus-observation", basis: "visible", summary: "derived", structuredFacts: facts } as never;
}

const REQUEST = { productContext: "Internal analytics workspace for finance operators", constraints: [], motionIntents: [] } as never;

function matched(evidenceId: string, entry: Record<string, unknown>): { evidenceId: string; entry: CorpusEntryT } {
  return { evidenceId, entry: entry as unknown as CorpusEntryT };
}

function entriesOf(matches: readonly { entry: CorpusEntryT }[]): CorpusEntryT[] {
  return matches.map((m) => m.entry);
}

function proseEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "fixture-entry",
    title: "FixtureCo — workspace",
    source: { productName: "FixtureCo" },
    whatToSteal: ["Group metrics by row", "Right-side callout anchored to chart regions"],
    antiPatterns: {
      antiPatterns: ["Avoids heavy chart chrome"],
      whereThisFails: [],
      accessibilityRisks: [{ element: "Secondary text", risk: "Low contrast on secondary text", evidence: "visible", confidence: "visible", wcag: ["1.4.3"] }],
    },
    components: ["kpi-card", "sidebar-nav"],
    responsiveBehavior: "responsive",
    voice: {
      tone: "Restrained, confident",
      examples: ["Confidence intervals plotted as soft bands"],
      avoid: ["No exclamation enthusiasm on financial data"],
    },
    styleTags: ["minimal", "data-dense"],
    categories: ["dashboard", "data-table"],
    mood: "calm and authoritative",
    colorScheme: "light",
    visual: {
      typePairing: {
        display: "Inter",
        body: "Inter",
        notes: "tight letter-spacing on all-caps labels",
      },
    },
    critique: "A fixture critique long enough to satisfy the corpus schema minimum length requirement.",
    ...over,
  };
}

describe("createUiSpecDeterministic", () => {
  it("synthesizes direction, token plurality, and layout regions from matched facts", () => {
    const evidence = [
      observation("evidence-2", {
        pattern: "dashboard", spacingDensity: "compact", cornerStyle: "slight-round",
        usesShadows: false, usesBorders: true, accentColor: "#2563eb",
        colorRoles: { canvas: "#ffffff", surface: "#ffffff", ink: "#111827", muted: "#6b7280", accent: "#2563eb" },
        layoutForm: "three-column", layoutRoles: ["primary-nav", "main-canvas", "detail-rail"],
      }),
      observation("evidence-3", {
        pattern: "dashboard", spacingDensity: "compact", cornerStyle: "sharp",
        usesShadows: false, usesBorders: true,
        colorRoles: { canvas: "#f8fafc", surface: "#ffffff", ink: "#0f172a", muted: "#64748b", accent: "#1d4ed8" },
      }),
      observation("evidence-4", {
        pattern: "data-table", spacingDensity: "compact", cornerStyle: "slight-round",
        usesShadows: false, usesBorders: true,
        colorRoles: { canvas: "#f8fafc", surface: "#ffffff", ink: "#111827", muted: "#6b7280", accent: "#2563eb" },
      }),
    ] as never;

    const out = createUiSpecDeterministic(evidence, [], [], REQUEST);

    expect(out.designDirection).toContain("evidence-2");
    expect(out.designDirection).toContain("compact");
    // UiSpec primary and accent both resolve to the corpus accent plurality
    // (the corpus records ONE interactive color; the vocabulary split is a
    // documented mapping, not an invention).
    expect(out.colorTokens).toEqual({
      primary: "#2563eb", surface: "#ffffff", ink: "#111827", muted: "#6b7280", accent: "#2563eb",
    });
    expect(out.layoutRegions.map((r) => r.name)).toEqual(["primary-nav", "main-canvas", "detail-rail"]);
    expect(out.responsiveBehavior).toContain("form: three-column");
  });

  it("returns nulls and empty arrays when no corpus observation matched", () => {
    const out = createUiSpecDeterministic([], [], [], REQUEST);
    expect(out.designDirection).toBeNull();
    expect(out.colorTokens).toBeNull();
    expect(out.layoutRegions).toEqual([]);
  });

  it("never populates tokens from fewer than three contributing entries", () => {
    const evidence = [
      observation("evidence-2", { pattern: "dashboard", colorRoles: { canvas: "#fff", surface: "#fff", ink: "#111", muted: "#666", accent: "#2563eb" } }),
      observation("evidence-3", { pattern: "dashboard" }),
    ] as never;
    expect(createUiSpecDeterministic(evidence, [], [], REQUEST).colorTokens).toBeNull();
  });

  it("never fabricates default tokens when no entry has colorRoles", () => {
    const evidence = [
      observation("evidence-2", { pattern: "dashboard", spacingDensity: "compact" }),
      observation("evidence-3", { pattern: "dashboard", spacingDensity: "compact" }),
      observation("evidence-4", { pattern: "dashboard", spacingDensity: "compact" }),
    ] as never;
    expect(createUiSpecDeterministic(evidence, [], [], REQUEST).colorTokens).toBeNull();
  });

  it("never fabricates muted when every matched entry has a null muted role", () => {
    // `muted` is the ONLY nullable role in the corpus shape (schema.ts), so it
    // is the one field the `withRoles.length >= 3` guard cannot protect: the
    // null-filter can empty the array while three entries still contribute
    // colorRoles, and a `?? "#888888"` default would invent a token nothing
    // derived. Measured base rate: 20 of 688 entries with colorRoles carry a
    // null muted, and retrieval returns SIMILAR entries, so the three matches
    // are not independent draws.
    const roles = (accent: string) => ({
      canvas: "#ffffff", surface: "#ffffff", ink: "#111827", muted: null, accent,
    });
    const evidence = [
      observation("evidence-2", { pattern: "dashboard", colorRoles: roles("#2563eb") }),
      observation("evidence-3", { pattern: "data-table", colorRoles: roles("#2563eb") }),
      observation("evidence-4", { pattern: "forms", colorRoles: roles("#2563eb") }),
    ] as never;
    expect(createUiSpecDeterministic(evidence, [], [], REQUEST).colorTokens).toBeNull();
  });

  it("still populates tokens when at least three entries carry a non-null muted", () => {
    const withMuted = (accent: string) => ({
      canvas: "#ffffff", surface: "#ffffff", ink: "#111827", muted: "#6b7280", accent,
    });
    const evidence = [
      observation("evidence-2", { pattern: "dashboard", colorRoles: withMuted("#2563eb") }),
      observation("evidence-3", { pattern: "data-table", colorRoles: withMuted("#2563eb") }),
      observation("evidence-4", { pattern: "forms", colorRoles: { ...withMuted("#2563eb"), muted: null } }),
      observation("evidence-5", { pattern: "modal", colorRoles: withMuted("#2563eb") }),
    ] as never;
    expect(createUiSpecDeterministic(evidence, [], [], REQUEST).colorTokens).toEqual({
      primary: "#2563eb", surface: "#ffffff", ink: "#111827", muted: "#6b7280", accent: "#2563eb",
    });
  });

  it("populates regions but not a form claim when layoutForm is absent", () => {
    const evidence = [
      observation("evidence-2", {
        pattern: "dashboard",
        layoutRoles: ["primary-nav", "main-canvas"],
      }),
    ] as never;
    const out = createUiSpecDeterministic(evidence, [], [], REQUEST);
    expect(out.layoutRegions.map((r) => r.name)).toEqual(["primary-nav", "main-canvas"]);
    // No form string may be fabricated when the corpus entry carries none.
    expect(out.responsiveBehavior).toEqual([]);
  });

  it("populates the six corpus fields from matched entries, citing each row's evidence id", () => {
    const evidence = [
      observation("evidence-2", { pattern: "dashboard" }),
    ];
    const matches = [matched("evidence-2", proseEntry())];
    const out = createUiSpecDeterministic(
      evidence as never,
      matches,
      entriesOf(matches),
      REQUEST,
    );

    expect(out.techniques).toEqual([
      { text: "Group metrics by row", sourceIds: ["evidence-2"] },
      { text: "Right-side callout anchored to chart regions", sourceIds: ["evidence-2"] },
    ]);
    expect(out.antiPatterns).toEqual([
      { text: "Avoids heavy chart chrome", sourceIds: ["evidence-2"] },
    ]);
    expect(out.contentVoiceGuidance).toBe(
      "Restrained, confident. Avoid: No exclamation enthusiasm on financial data. "
      + "Examples: Confidence intervals plotted as soft bands.",
    );
    expect(out.contentVoiceEvidenceIds).toEqual(["evidence-2"]);
    expect(out.accessibilityConstraints).toEqual(["Low contrast on secondary text"]);
    expect(out.accessibilityEvidenceIds).toEqual(["evidence-2"]);
    expect(out.componentInventory).toEqual([
      { name: "kpi-card", pattern: "kpi-card" },
      { name: "sidebar-nav", pattern: "sidebar-nav" },
    ]);
    expect(out.componentInventoryEvidenceIds).toEqual(["evidence-2"]);
    expect(out.responsiveBehaviorEvidenceIds).toEqual(["evidence-2"]);
    expect(out.responsiveBehavior).toContain("mode: responsive");
  });

  it("drops a screened prose row that names a different corpus product", () => {
    const evidence = [
      observation("evidence-2", { pattern: "dashboard" }),
      observation("evidence-3", { pattern: "dashboard" }),
    ];
    const matches = [
      matched("evidence-2", proseEntry()),
      matched("evidence-3", proseEntry({
        source: { productName: "Superhuman" },
        title: "Superhuman — mail",
        whatToSteal: ["Superhuman triage is the hook", "Plain stealable row"],
      })),
    ];
    const out = createUiSpecDeterministic(
      evidence as never,
      matches,
      entriesOf(matches),
      REQUEST,
    );
    // "Superhuman" is a corpus product name, so the row naming it is dropped
    // WHOLE; the clean row from the same entry survives.
    expect(out.techniques).toEqual([
      { text: "Group metrics by row", sourceIds: ["evidence-2"] },
      { text: "Right-side callout anchored to chart regions", sourceIds: ["evidence-2"] },
      { text: "Plain stealable row", sourceIds: ["evidence-3"] },
    ]);
  });

  it("drops prose naming a corpus product that is NOT among the matched entries", () => {
    // The denied-name set is CORPUS-WIDE (design spec §3), not just the
    // matched entries: a matched row naming "Mobbin" must be dropped even
    // though Mobbin is not one of the entries matched for this request.
    const evidence = [observation("evidence-2", { pattern: "dashboard" })];
    const matches = [matched("evidence-2", proseEntry({
      whatToSteal: ["Mobbin triage is the hook", "Clean stealable row"],
    }))];
    const corpusEntries: CorpusEntryT[] = [
      ...entriesOf(matches),
      { ...proseEntry(), id: "mobbin-entry", source: { productName: "Mobbin" } } as unknown as CorpusEntryT,
    ];
    const out = createUiSpecDeterministic(evidence as never, matches, corpusEntries, REQUEST);
    expect(out.techniques.map((t) => t.text)).not.toContain("Mobbin triage is the hook");
    expect(out.techniques.map((t) => t.text)).toContain("Clean stealable row");
  });

  it("caps techniques and antiPatterns at five and voice examples at three", () => {
    const many = (prefix: string): Record<string, unknown> => proseEntry({
      id: `${prefix}-id`,
      whatToSteal: [`${prefix} one`, `${prefix} two`, `${prefix} three`],
      antiPatterns: {
        antiPatterns: [`${prefix} avoid one`, `${prefix} avoid two`, `${prefix} avoid three`],
        whereThisFails: [],
        accessibilityRisks: [],
      },
      voice: {
        tone: `${prefix} tone`,
        examples: [`${prefix} example one long enough`, `${prefix} example two long enough`, `${prefix} example three long enough`],
        avoid: [],
      },
    });
    const evidence = [observation("evidence-2", { pattern: "dashboard" })];
    const matches = [
      matched("evidence-2", many("A")),
      matched("evidence-3", many("B")),
      matched("evidence-4", many("C")),
    ];
    const out = createUiSpecDeterministic(
      evidence as never,
      matches,
      entriesOf(matches),
      REQUEST,
    );
    expect(out.techniques).toHaveLength(5);
    expect(out.antiPatterns).toHaveLength(5);
    expect(out.contentVoiceGuidance!.match(/Examples: ([^.]*)/)![1]!.split(" · ")).toHaveLength(3);
  });

  it("windows voice examples to 20-140 chars and rejects data-only strings", () => {
    const entry = proseEntry({
      voice: {
        tone: "Terse",
        examples: [
          "52,420",
          "short",
          "x".repeat(141),
          "A real functional label long enough to survive",
        ],
        avoid: [],
      },
    });
    const matches = [matched("evidence-2", entry)];
    const out = createUiSpecDeterministic(
      [observation("evidence-2", { pattern: "dashboard" })] as never,
      matches,
      entriesOf(matches),
      REQUEST,
    );
    expect(out.contentVoiceGuidance).toBe("Terse. Examples: A real functional label long enough to survive.");
  });

  it("composes contentVoiceGuidance per segment presence (each combination pinned)", () => {
    const base = proseEntry();
    const run = (voice: Record<string, unknown> | undefined): string | null => {
      const matches = [matched("evidence-2", { ...base, voice })];
      return createUiSpecDeterministic(
        [observation("evidence-2", { pattern: "dashboard" })] as never,
        matches,
        entriesOf(matches),
        REQUEST,
      ).contentVoiceGuidance;
    };

    const toneOnly = { tone: "Terse", examples: [], avoid: [] };
    const avoidOnly = { examples: [], avoid: ["No hype"] };
    const examplesOnly = { examples: ["A real functional label long enough to survive"], avoid: [] };
    const toneAvoid = { tone: "Terse", examples: [], avoid: ["No hype"] };
    const toneExamples = { tone: "Terse", examples: ["A real functional label long enough to survive"], avoid: [] };
    const avoidExamples = { examples: ["A real functional label long enough to survive"], avoid: ["No hype"] };
    const all = { tone: "Terse", examples: ["A real functional label long enough to survive"], avoid: ["No hype"] };

    expect(run(toneOnly)).toBe("Terse.");
    expect(run(avoidOnly)).toBe("Avoid: No hype.");
    expect(run(examplesOnly)).toBe("Examples: A real functional label long enough to survive.");
    expect(run(toneAvoid)).toBe("Terse. Avoid: No hype.");
    expect(run(toneExamples)).toBe("Terse. Examples: A real functional label long enough to survive.");
    expect(run(avoidExamples)).toBe("Avoid: No hype. Examples: A real functional label long enough to survive.");
    expect(run(all)).toBe("Terse. Avoid: No hype. Examples: A real functional label long enough to survive.");
    expect(run(undefined)).toBeNull();
  });

  it("dedupes component rows and folds layout-form into responsiveBehavior", () => {
    const evidence = [
      observation("evidence-2", { pattern: "dashboard", layoutForm: "three-column" }),
    ];
    const matches = [
      matched("evidence-2", proseEntry()),
      matched("evidence-3", proseEntry({ id: "other", components: ["kpi-card", "action-list"] })),
    ];
    const out = createUiSpecDeterministic(
      evidence as never,
      matches,
      entriesOf(matches),
      REQUEST,
    );
    expect(out.componentInventory).toEqual([
      { name: "kpi-card", pattern: "kpi-card" },
      { name: "sidebar-nav", pattern: "sidebar-nav" },
      { name: "action-list", pattern: "action-list" },
    ]);
    expect(out.componentInventoryEvidenceIds).toEqual(["evidence-2", "evidence-3"]);
    expect(out.responsiveBehaviorEvidenceIds).toEqual(["evidence-2", "evidence-3"]);
    expect(out.responsiveBehavior).toContain("mode: responsive");
    expect(out.responsiveBehavior).toContain("form: three-column");
  });

  it("folds group-B signals into the direction as cited signals", () => {
    const matches = [matched("evidence-2", proseEntry())];
    const out = createUiSpecDeterministic(
      [observation("evidence-2", { pattern: "dashboard", spacingDensity: "compact" })] as never,
      matches,
      entriesOf(matches),
      REQUEST,
    );
    expect(out.designDirection).toContain(
      `For the brief "${REQUEST.productContext}", the matched corpus references (evidence-2) point to`,
    );
    expect(out.designDirection).toContain("style tags: minimal, data-dense");
    expect(out.designDirection).toContain("categories: dashboard, data-table");
    expect(out.designDirection).toContain("a light color scheme");
    expect(out.designDirection).toContain("mood: calm and authoritative");
    expect(out.designDirection).toContain("type notes: tight letter-spacing on all-caps labels");
    expect(out.designDirection).toContain("critique: A fixture critique");
  });

  it("drops only the screened segment, not the whole direction, when a folded signal names a corpus product", () => {
    const matches = [
      matched("evidence-2", proseEntry()),
      matched("evidence-3", proseEntry({
        source: { productName: "Superhuman" },
        title: "Superhuman — mail",
        critique: "A critique long enough to satisfy the schema minimum that mentions Superhuman triage as the hook.",
      })),
    ];
    const out = createUiSpecDeterministic(
      [observation("evidence-2", { pattern: "dashboard" })] as never,
      matches,
      entriesOf(matches),
      REQUEST,
    );
    // The second entry's critique names a corpus product and is dropped WHOLE;
    // the direction survives with the first entry's signals. (Whole-direction
    // screening measured 26.1% direction loss on production-shaped windows —
    // review finding #2 — so prose segments are screened before composing.)
    expect(out.designDirection).not.toBeNull();
    expect(out.designDirection).toContain("critique: A fixture critique");
    expect(out.designDirection).not.toContain("Superhuman");
  });

  it("drops a critique naming its own entry's product but keeps sibling signals", () => {
    const matches = [
      matched("evidence-2", proseEntry()),
      matched("evidence-3", proseEntry({
        source: { productName: "Superhuman" },
        title: "Superhuman — mail",
        critique: "Superhuman's own triage critique is long enough to satisfy the schema minimum length.",
      })),
    ];
    const out = createUiSpecDeterministic(
      [observation("evidence-2", { pattern: "dashboard" })] as never,
      matches,
      entriesOf(matches),
      REQUEST,
    );
    expect(out.designDirection).not.toBeNull();
    expect(out.designDirection).not.toContain("Superhuman");
    expect(out.designDirection).toContain("mood: calm and authoritative");
  });

  it("never splices a multi-sentence brief mid-sentence", () => {
    const matches = [matched("evidence-2", proseEntry())];
    const out = createUiSpecDeterministic(
      [observation("evidence-2", { pattern: "dashboard", spacingDensity: "compact" })] as never,
      matches,
      entriesOf(matches),
      { ...REQUEST, productContext: "A login screen. Keep it calm." } as never,
    );
    expect(out.designDirection).toContain(
      'For the brief "A login screen. Keep it calm.", the matched corpus references (evidence-2) point to',
    );
    expect(out.designDirection).not.toContain("A login screen. in");
    expect(out.designDirection).not.toContain("Ground this");
  });
});

// ---------------------------------------------------------------------------
// Direction size guard (PR review round 2)
// ---------------------------------------------------------------------------
//
// Serving every matched entry's critique and type notes verbatim made the
// direction a 3,783-char mean / 5,642-char max run-on paragraph on
// production-shaped 5-entry windows (base was 358). A populated field whose
// value nobody can read is the presence-not-usability failure CLAUDE.md
// forbids, so the corpus-signal section carries a CHARACTER BUDGET and drops
// whole clauses that do not fit — never truncating one.

/** Realistic corpus prose sizes: critique p50 947, typePairing.notes p50 319. */
function longProseEntry(index: number): Record<string, unknown> {
  return proseEntry({
    id: `budget-entry-${index}`,
    title: `BudgetCo${index} — workspace`,
    source: { productName: `BudgetCo${index}` },
    mood: `mood-${index} calm and measured`,
    visual: {
      typePairing: {
        display: "Inter",
        body: "Inter",
        notes: `type-note-${index} ` + "a".repeat(310),
      },
    },
    critique: `critique-${index} ` + "b".repeat(930),
  });
}

describe("createUiSpecDeterministic — direction size guard", () => {
  const facts = {
    pattern: "dashboard", spacingDensity: "compact", cornerStyle: "sharp",
    usesShadows: false, usesBorders: true, layoutForm: "two-column",
  };
  const evidence = [2, 3, 4, 5, 6].map((n) => observation(`evidence-${n}`, facts));
  const matches = [2, 3, 4, 5, 6].map((n) => matched(`evidence-${n}`, longProseEntry(n)));

  it("bounds the corpus-signal section of the direction", () => {
    const out = createUiSpecDeterministic(evidence, matches, entriesOf(matches), REQUEST);
    const direction = out.designDirection ?? "";
    expect(direction).not.toBe("");
    // The caller's own brief and the fixed template are not corpus growth, so
    // the budget covers the signal section only. Five entries' unbudgeted
    // critique alone is ~4,650 chars.
    const signals = /The shared signals include (.*?)\. Let those signals lead/s.exec(direction);
    expect(signals, "direction must still carry a signal section").not.toBeNull();
    expect((signals as RegExpExecArray)[1].length).toBeLessThanOrEqual(1200);
  });

  it("drops an over-budget clause WHOLE — never truncates one", () => {
    const out = createUiSpecDeterministic(evidence, matches, entriesOf(matches), REQUEST);
    const direction = out.designDirection ?? "";
    // Every critique/type-note fragment present must be a COMPLETE source
    // string: a truncated one would leave the marker without its full body.
    for (const n of [2, 3, 4, 5, 6]) {
      if (direction.includes(`critique-${n} `))
        expect(direction).toContain(`critique-${n} ` + "b".repeat(930));
      if (direction.includes(`type-note-${n} `))
        expect(direction).toContain(`type-note-${n} ` + "a".repeat(310));
    }
    expect(direction).not.toContain("…");
    expect(direction).not.toContain("...");
  });

  it("keeps the higher-priority closed-token signals when prose is dropped", () => {
    const out = createUiSpecDeterministic(evidence, matches, entriesOf(matches), REQUEST);
    const direction = out.designDirection ?? "";
    // Priority order: closed tokens (cheap, high signal) before long prose.
    expect(direction).toContain("style tags:");
    expect(direction).toContain("categories:");
    expect(direction).toContain("mood:");
  });

  it("keeps critique over type notes when the budget binds", () => {
    // critique IS the corpus's design judgment and the reason group-B signals
    // fold into the direction; typePairing notes restate the typography clause
    // the structural sentence already carries, so they lose first.
    const out = createUiSpecDeterministic(evidence, matches, entriesOf(matches), REQUEST);
    const direction = out.designDirection ?? "";
    expect(direction).toContain("critique:");
    expect(direction).not.toContain("type notes:");
  });

  it("composes without a doubled sentence period at any clause join", () => {
    // "…without mixing typefaces.. Let those signals lead" — corpus prose ends
    // in a period and the template appends one. Real corpus values, not a short
    // fixture (CLAUDE.md: render templates with real inputs).
    const withPeriods = [2, 3].map((n) => matched(`evidence-${n}`, proseEntry({
      id: `period-${n}`,
      title: `PeriodCo${n} — workspace`,
      source: { productName: `PeriodCo${n}` },
      mood: "calm and measured.",
      critique: `A critique that ends in a period and is long enough for the schema minimum, ${n}.`,
      visual: { typePairing: { display: "Inter", body: "Inter", notes: "Tight tracking on caps." } },
    })));
    const out = createUiSpecDeterministic(
      [observation("evidence-2", facts), observation("evidence-3", facts)],
      withPeriods,
      entriesOf(withPeriods),
      REQUEST,
    );
    const direction = out.designDirection ?? "";
    expect(direction).not.toMatch(/\.\./);
    // A value ending in an ellipsis must not collide with the appended period
    // either — one stripped period is not enough.
    const ellipsis = [2].map((n) => matched(`evidence-${n}`, proseEntry({
      id: `ellipsis-${n}`,
      title: `EllipsisCo${n} — workspace`,
      source: { productName: `EllipsisCo${n}` },
      mood: "unhurried...",
      critique: "A critique long enough for the schema minimum that trails off...",
    })));
    const trailing = createUiSpecDeterministic(
      [observation("evidence-2", facts)],
      ellipsis,
      entriesOf(ellipsis),
      REQUEST,
    ).designDirection ?? "";
    expect(trailing).not.toMatch(/\.\./);
    // The mood list separator must not collide with the clause separator, or
    // the reader cannot tell where the list ends (corpus moods carry commas).
    expect(direction).toContain("mood: calm and measured");
    expect(direction).toMatch(/mood: [^;]*; critique:/);
  });
});
