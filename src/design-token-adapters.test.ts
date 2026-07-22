/**
 * design-token-adapters.test.ts — TDD for semantic token projections.
 *
 * Task 3 of the web design adapters plan. normalizeSemanticTokens projects
 * UiSpec 1.0 color/typography tokens into stable semantic names. The CSS and
 * Tailwind renderers are pure, deterministic, offline, and escape injection
 * attempts. Nullable token groups render as an explicit "unavailable" decision
 * — no value is ever inferred from corpus data.
 */
import { describe, expect, it } from "vitest";
import {
  normalizeSemanticTokens,
  renderCssTokens,
  renderTailwindTheme,
  type SemanticTokens,
} from "./design-token-adapters.js";
import type { UiSpecT } from "./tool-contracts.js";

// ---------------------------------------------------------------------------
// Fixtures — built as already-parsed UiSpecT instances. We do not re-parse;
// the contract parser (Task 1) owns validation. These fixtures mirror the
// canonical minimal shape used in design-target-contracts.test.ts.
// ---------------------------------------------------------------------------

/** A minimal valid UiSpec 1.0 instance with full color + typography tokens. */
function fullTokenSpec(): UiSpecT {
  return {
    specVersion: "1.0",
    context: { productContext: "A fintech dashboard" },
    designDirection: "Calm layout",
    rejectedDefaults: [],
    layoutRegions: [],
    responsiveBehavior: [],
    componentInventory: [],
    colorTokens: {
      primary: "#ffffff",
      surface: "#f5f5f5",
      ink: "#1a1a1a",
      muted: "#6b6b6b",
      accent: "#3b82f6",
    },
    colorTokenAuthority: "corpus-evidence",
    typographyTokens: {
      heading: '"Inter", sans-serif',
      body: '"Inter", sans-serif',
      mono: '"JetBrains Mono", monospace',
    },
    typographyTokenAuthority: "corpus-evidence",
    interactions: [],
    motionGuidance: { notes: [], evidenceUnavailable: true },
    accessibilityConstraints: [],
    techniques: [],
    antiPatterns: [],
    unavailableDecisions: [{ field: "motion", reason: "no DOM evidence" }],
    acceptanceCriteria: [
      {
        id: "ac1",
        subject: "contrast",
        assertion: "meets-contrast",
        expectedOutcome: "4.5:1",
        verifier: "axe",
        priority: "must",
        evidenceIds: [],
      },
    ],
    citedReferences: [],
    citedDecisions: [],
    authorityLanes: { corpusEvidence: [], machineRules: [], editorialGuidance: [] },
    provenance: {
      generatedAt: "2026-07-15T00:00:00Z",
      toolVersion: "0.2.0",
      sourceReferences: [],
      evidenceIds: [],
    },
  };
}

/** A spec whose colorTokens and typographyTokens are both null (editorial authority). */
function nullTokenSpec(): UiSpecT {
  return {
    ...fullTokenSpec(),
    colorTokens: null,
    colorTokenAuthority: "editorial",
    typographyTokens: null,
    typographyTokenAuthority: "editorial",
    unavailableDecisions: [
      { field: "motion", reason: "no DOM evidence" },
      { field: "colorTokens", reason: "no DOM evidence" },
      { field: "typographyTokens", reason: "no DOM evidence" },
    ],
  };
}

// ---------------------------------------------------------------------------
// normalizeSemanticTokens
// ---------------------------------------------------------------------------

describe("normalizeSemanticTokens", () => {
  it("projects colorTokens.primary -> bg.canvas (current compatibility mapping)", () => {
    const tokens = normalizeSemanticTokens(fullTokenSpec());
    expect(tokens.bg.canvas).toBe("#ffffff");
  });

  it("projects colorTokens.surface -> bg.surface", () => {
    const tokens = normalizeSemanticTokens(fullTokenSpec());
    expect(tokens.bg.surface).toBe("#f5f5f5");
  });

  it("projects colorTokens.ink -> text.primary", () => {
    const tokens = normalizeSemanticTokens(fullTokenSpec());
    expect(tokens.text.primary).toBe("#1a1a1a");
  });

  it("projects colorTokens.muted -> text.muted", () => {
    const tokens = normalizeSemanticTokens(fullTokenSpec());
    expect(tokens.text.muted).toBe("#6b6b6b");
  });

  it("projects colorTokens.accent -> action.accent", () => {
    const tokens = normalizeSemanticTokens(fullTokenSpec());
    expect(tokens.action.accent).toBe("#3b82f6");
  });

  it("projects typographyTokens.heading -> font.heading", () => {
    const tokens = normalizeSemanticTokens(fullTokenSpec());
    expect(tokens.font.heading).toBe('"Inter", sans-serif');
  });

  it("projects typographyTokens.body -> font.body", () => {
    const tokens = normalizeSemanticTokens(fullTokenSpec());
    expect(tokens.font.body).toBe('"Inter", sans-serif');
  });

  it("projects typographyTokens.mono -> font.mono", () => {
    const tokens = normalizeSemanticTokens(fullTokenSpec());
    expect(tokens.font.mono).toBe('"JetBrains Mono", monospace');
  });

  it("renders null colorTokens as 'unavailable' for every bg/text/action field", () => {
    const spec = fullTokenSpec();
    spec.colorTokens = null;
    spec.colorTokenAuthority = "editorial";
    spec.unavailableDecisions = [
      { field: "motion", reason: "no DOM evidence" },
      { field: "colorTokens", reason: "no DOM evidence" },
    ];
    const tokens = normalizeSemanticTokens(spec);
    expect(tokens.bg.canvas).toBe("unavailable");
    expect(tokens.bg.surface).toBe("unavailable");
    expect(tokens.text.primary).toBe("unavailable");
    expect(tokens.text.muted).toBe("unavailable");
    expect(tokens.action.accent).toBe("unavailable");
    // Typography tokens are still present.
    expect(tokens.font.heading).toBe('"Inter", sans-serif');
  });

  it("renders null typographyTokens as 'unavailable' for every font field", () => {
    const spec = fullTokenSpec();
    spec.typographyTokens = null;
    spec.typographyTokenAuthority = "editorial";
    spec.unavailableDecisions = [
      { field: "motion", reason: "no DOM evidence" },
      { field: "typographyTokens", reason: "no DOM evidence" },
    ];
    const tokens = normalizeSemanticTokens(spec);
    expect(tokens.font.heading).toBe("unavailable");
    expect(tokens.font.body).toBe("unavailable");
    expect(tokens.font.mono).toBe("unavailable");
    // Color tokens are still present.
    expect(tokens.bg.canvas).toBe("#ffffff");
  });

  it("renders the fully-null spec as all 'unavailable'", () => {
    const tokens = normalizeSemanticTokens(nullTokenSpec());
    expect(tokens.bg.canvas).toBe("unavailable");
    expect(tokens.bg.surface).toBe("unavailable");
    expect(tokens.text.primary).toBe("unavailable");
    expect(tokens.text.muted).toBe("unavailable");
    expect(tokens.action.accent).toBe("unavailable");
    expect(tokens.font.heading).toBe("unavailable");
    expect(tokens.font.body).toBe("unavailable");
    expect(tokens.font.mono).toBe("unavailable");
  });

  it("never infers a value from corpus data (no guessed fallbacks)", () => {
    // The fixture has no colorTokens; the output must never contain a guessed hex.
    const tokens = normalizeSemanticTokens(nullTokenSpec());
    const allValues = [
      tokens.bg.canvas,
      tokens.bg.surface,
      tokens.text.primary,
      tokens.text.muted,
      tokens.action.accent,
      tokens.font.heading,
      tokens.font.body,
      tokens.font.mono,
    ];
    expect(allValues.every((v) => v === "unavailable")).toBe(true);
  });

  it("produces a stable shape with the exact SemanticTokens keys", () => {
    const tokens = normalizeSemanticTokens(fullTokenSpec());
    expect(tokens).toEqual({
      bg: { canvas: "#ffffff", surface: "#f5f5f5" },
      text: { primary: "#1a1a1a", muted: "#6b6b6b" },
      action: { accent: "#3b82f6" },
      font: {
        heading: '"Inter", sans-serif',
        body: '"Inter", sans-serif',
        mono: '"JetBrains Mono", monospace',
      },
    } satisfies SemanticTokens);
  });
});

// ---------------------------------------------------------------------------
// renderCssTokens
// ---------------------------------------------------------------------------

describe("renderCssTokens", () => {
  it("emits stable custom properties under :root", () => {
    const tokens = normalizeSemanticTokens(fullTokenSpec());
    const css = renderCssTokens(tokens);
    expect(css).toContain(":root {");
    expect(css).toContain("--bg-canvas: #ffffff;");
    expect(css).toContain("--bg-surface: #f5f5f5;");
    expect(css).toContain("--text-primary: #1a1a1a;");
    expect(css).toContain("--text-muted: #6b6b6b;");
    expect(css).toContain("--action-accent: #3b82f6;");
    expect(css).toContain('--font-heading: "Inter", sans-serif;');
    expect(css).toContain('--font-body: "Inter", sans-serif;');
    expect(css).toContain('--font-mono: "JetBrains Mono", monospace;');
    expect(css.trim().endsWith("}")).toBe(true);
  });

  it("matches the spec example byte-for-byte", () => {
    const tokens: SemanticTokens = {
      bg: { canvas: "#ffffff", surface: "#f5f5f5" },
      text: { primary: "#1a1a1a", muted: "#6b6b6b" },
      action: { accent: "#3b82f6" },
      font: {
        heading: '"Inter", sans-serif',
        body: '"Inter", sans-serif',
        mono: '"JetBrains Mono", monospace',
      },
    };
    const expected = `:root {
  --bg-canvas: #ffffff;
  --bg-surface: #f5f5f5;
  --text-primary: #1a1a1a;
  --text-muted: #6b6b6b;
  --action-accent: #3b82f6;
  --font-heading: "Inter", sans-serif;
  --font-body: "Inter", sans-serif;
  --font-mono: "JetBrains Mono", monospace;
}`;
    expect(renderCssTokens(tokens)).toBe(expected);
  });

  it("produces byte-identical output on repeated renders", () => {
    const tokens = normalizeSemanticTokens(fullTokenSpec());
    const a = renderCssTokens(tokens);
    const b = renderCssTokens(tokens);
    expect(a).toBe(b);
  });

  it("emits 'unavailable' for null tokens without crashing", () => {
    const tokens = normalizeSemanticTokens(nullTokenSpec());
    const css = renderCssTokens(tokens);
    expect(css).toContain("--bg-canvas: unavailable;");
    expect(css).toContain("--font-mono: unavailable;");
  });
});

// ---------------------------------------------------------------------------
// renderTailwindTheme
// ---------------------------------------------------------------------------

describe("renderTailwindTheme", () => {
  it("emits theme variables under @theme, prefixed for color tokens", () => {
    const tokens = normalizeSemanticTokens(fullTokenSpec());
    const css = renderTailwindTheme(tokens);
    expect(css).toContain("@theme {");
    expect(css).toContain("--color-bg-canvas: #ffffff;");
    expect(css).toContain("--color-bg-surface: #f5f5f5;");
    expect(css).toContain("--color-text-primary: #1a1a1a;");
    expect(css).toContain("--color-text-muted: #6b6b6b;");
    expect(css).toContain("--color-action-accent: #3b82f6;");
  });

  it("emits font variables WITHOUT the color- prefix", () => {
    const tokens = normalizeSemanticTokens(fullTokenSpec());
    const css = renderTailwindTheme(tokens);
    expect(css).toContain('--font-heading: "Inter", sans-serif;');
    expect(css).toContain('--font-body: "Inter", sans-serif;');
    expect(css).toContain('--font-mono: "JetBrains Mono", monospace;');
    // No color utility class synthesis.
    expect(css).not.toMatch(/text-\[/);
    expect(css).not.toMatch(/bg-\[/);
  });

  it("does not emit Tailwind utility classes (theme variables only)", () => {
    const tokens = normalizeSemanticTokens(fullTokenSpec());
    const css = renderTailwindTheme(tokens);
    expect(css).not.toContain("@layer");
    expect(css).not.toContain("@utility");
    // Theme variables only.
    expect(css.trim().startsWith("@theme")).toBe(true);
  });

  it("matches the spec example byte-for-byte", () => {
    const tokens: SemanticTokens = {
      bg: { canvas: "#ffffff", surface: "#f5f5f5" },
      text: { primary: "#1a1a1a", muted: "#6b6b6b" },
      action: { accent: "#3b82f6" },
      font: {
        heading: '"Inter", sans-serif',
        body: '"Inter", sans-serif',
        mono: '"JetBrains Mono", monospace',
      },
    };
    const expected = `@theme {
  --color-bg-canvas: #ffffff;
  --color-bg-surface: #f5f5f5;
  --color-text-primary: #1a1a1a;
  --color-text-muted: #6b6b6b;
  --color-action-accent: #3b82f6;
  --font-heading: "Inter", sans-serif;
  --font-body: "Inter", sans-serif;
  --font-mono: "JetBrains Mono", monospace;
}`;
    expect(renderTailwindTheme(tokens)).toBe(expected);
  });

  it("produces byte-identical output on repeated renders", () => {
    const tokens = normalizeSemanticTokens(fullTokenSpec());
    const a = renderTailwindTheme(tokens);
    const b = renderTailwindTheme(tokens);
    expect(a).toBe(b);
  });

  it("emits 'unavailable' for null tokens without crashing", () => {
    const tokens = normalizeSemanticTokens(nullTokenSpec());
    const css = renderTailwindTheme(tokens);
    expect(css).toContain("--color-bg-canvas: unavailable;");
    expect(css).toContain("--font-mono: unavailable;");
  });
});

// ---------------------------------------------------------------------------
// Injection hardening — newline, backtick, declaration terminator
// ---------------------------------------------------------------------------

describe("injection hardening", () => {
  /** Build a SemanticTokens with a dangerous value in a target field. */
  function tokensWith(over: Partial<{
    canvas: string;
    surface: string;
    primary: string;
    muted: string;
    accent: string;
    heading: string;
    body: string;
    mono: string;
  }>): SemanticTokens {
    return {
      bg: {
        canvas: over.canvas ?? "#ffffff",
        surface: over.surface ?? "#f5f5f5",
      },
      text: {
        primary: over.primary ?? "#1a1a1a",
        muted: over.muted ?? "#6b6b6b",
      },
      action: { accent: over.accent ?? "#3b82f6" },
      font: {
        heading: over.heading ?? '"Inter", sans-serif',
        body: over.body ?? '"Inter", sans-serif',
        mono: over.mono ?? '"JetBrains Mono", monospace',
      },
    };
  }

  it("rejects a newline in a token value", () => {
    const tokens = tokensWith({ canvas: "#fff\n--injected: red" });
    expect(() => renderCssTokens(tokens)).toThrow();
    expect(() => renderTailwindTheme(tokens)).toThrow();
  });

  it("rejects a backtick in a token value", () => {
    const tokens = tokensWith({ accent: "#3b82f6`" });
    expect(() => renderCssTokens(tokens)).toThrow();
    expect(() => renderTailwindTheme(tokens)).toThrow();
  });

  it("rejects a declaration terminator that would break out of the property", () => {
    // A raw ';' followed by a new declaration is the classic CSS injection vector.
    const tokens = tokensWith({ mono: '"; body { color: red }' });
    expect(() => renderCssTokens(tokens)).toThrow();
    expect(() => renderTailwindTheme(tokens)).toThrow();
  });

  it("rejects a carriage return in a token value", () => {
    const tokens = tokensWith({ surface: "#fff\r\n--evil: 1" });
    expect(() => renderCssTokens(tokens)).toThrow();
    expect(() => renderTailwindTheme(tokens)).toThrow();
  });

  it("accepts ordinary safe values (commas, quotes, spaces, parens)", () => {
    const tokens = tokensWith({
      heading: '"GT America", "Helvetica Neue", sans-serif',
      accent: "color(display-p3 0.4 0.5 0.9)",
    });
    expect(() => renderCssTokens(tokens)).not.toThrow();
    expect(() => renderTailwindTheme(tokens)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Determinism / purity
// ---------------------------------------------------------------------------

describe("determinism and purity", () => {
  it("two normalize calls on the same spec yield deep-equal tokens", () => {
    const a = normalizeSemanticTokens(fullTokenSpec());
    const b = normalizeSemanticTokens(fullTokenSpec());
    expect(a).toEqual(b);
  });

  it("renderCssTokens is a pure function of its input (no I/O, no globals)", () => {
    const tokens = normalizeSemanticTokens(fullTokenSpec());
    const out1 = renderCssTokens(tokens);
    // Mutate a copy; original output must not change.
    const copy: SemanticTokens = {
      ...tokens,
      bg: { ...tokens.bg, canvas: "#000000" },
    };
    const out2 = renderCssTokens(tokens);
    expect(out1).toBe(out2);
    // And the mutated copy produces its own distinct output.
    expect(renderCssTokens(copy)).toContain("--bg-canvas: #000000;");
  });

  it("renderTailwindTheme is a pure function of its input", () => {
    const tokens = normalizeSemanticTokens(fullTokenSpec());
    const out1 = renderTailwindTheme(tokens);
    const copy: SemanticTokens = {
      ...tokens,
      action: { ...tokens.action, accent: "#ff0000" },
    };
    const out2 = renderTailwindTheme(tokens);
    expect(out1).toBe(out2);
    expect(renderTailwindTheme(copy)).toContain("--color-action-accent: #ff0000;");
  });
});
