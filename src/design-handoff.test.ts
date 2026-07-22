/**
 * design-handoff.test.ts — TDD for the deterministic DESIGN.md handoff renderer.
 *
 * Task 5 of the web design adapters plan. This is the integration hub that ties
 * Tasks 1–4 together and produces the final DESIGN.md and JSON output. The
 * renderers are pure, deterministic, offline, and free of private corpus
 * material or copied third-party source.
 *
 * Tests cover the 10 required assertion areas:
 *  1.  19-section outline
 *  2.  Frontmatter fields present with correct values
 *  3.  neutral-web output: CSS variables, no React/Astro/Tailwind setup
 *  4.  astro-react output: island strategy + React setup
 *  5.  astro-vue output: island strategy + Vue motion guidance, no React-only rec
 *  6.  Byte-identical repeated rendering
 *  7.  JSON output: stable key order + final newline
 *  8.  renderDesignHandoff dispatch: only "markdown" | "json"
 *  9.  Not-captured sources generate explicit warnings
 *  10. No corpus records or third-party source in output
 */
import { describe, expect, it } from "vitest";
import {
  buildDesignHandoff,
  parseDesignHandoff,
  renderDesignHandoff,
  renderDesignHandoffJson,
  renderDesignHandoffMarkdown,
} from "./design-handoff.js";
import type { DesignHandoffInput, DesignHandoffT } from "./design-handoff.js";
import { resolveWebTarget } from "./design-adapter-registry.js";
import { UiSpec } from "./tool-contracts.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal valid UiSpec 1.0 object (mirrors the canonical fixture). */
function validUiSpec(): Record<string, unknown> {
  return {
    specVersion: "1.0",
    context: { productContext: "A fintech dashboard" },
    designDirection: "Calm, scannable layout with a restrained palette.",
    rejectedDefaults: ["no heavy card shadows", "no neon accent"],
    layoutRegions: [
      {
        name: "main",
        type: "content",
        components: ["dashboard-summary"],
        responsive: ["stack below 720px"],
      },
    ],
    responsiveBehavior: ["stack below 720px"],
    componentInventory: [
      { name: "dashboard-summary", pattern: "summary-card" },
    ],
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
    interactions: ["hover-lift"],
    motionGuidance: { notes: [], evidenceUnavailable: true },
    accessibilityConstraints: ["4.5:1 contrast on body text"],
    contentVoiceGuidance: "Direct, technical, confident.",
    techniques: [
      { text: "Use quiet grouping for scanability.", sourceIds: [] },
    ],
    antiPatterns: [
      { text: "Avoid heavy card shadows.", sourceIds: [] },
    ],
    frameworkNotes: "Astro + Vue islands",
    unavailableDecisions: [{ field: "motion", reason: "no DOM evidence" }],
    acceptanceCriteria: [
      {
        id: "ac1",
        subject: "contrast",
        assertion: "meets-contrast",
        expectedOutcome: "4.5:1 on body text",
        verifier: "axe",
        priority: "must",
        evidenceIds: [],
      },
    ],
    citedReferences: [],
    citedDecisions: [],
    authorityLanes: { corpusEvidence: [], machineRules: [], editorialGuidance: [] },
    provenance: {
      generatedAt: "2026-07-21T00:00:00.000Z",
      toolVersion: "0.2.0",
      sourceReferences: [],
      evidenceIds: [],
    },
  };
}

function neutralWebTarget(): Record<string, unknown> {
  return {
    id: "neutral-web",
    platform: "web",
    siteFramework: "none",
    runtime: "none",
    styling: "vanilla-css",
    componentSource: "native-html",
    motion: "css",
    islandStrategy: null,
  };
}

function astroReactTarget(): Record<string, unknown> {
  return {
    id: "astro-react",
    platform: "web",
    siteFramework: "astro",
    runtime: "react",
    styling: "tailwind",
    componentSource: "shadcn",
    motion: "motion",
    islandStrategy: "client:load",
  };
}

function astroVueTarget(): Record<string, unknown> {
  // Matches the frontmatter example in the plan exactly:
  // astro@5.x, vue@3.x, tailwind@4.x, custom@unversioned, vue-transition@unversioned
  return {
    id: "astro-vue",
    platform: "web",
    siteFramework: "astro",
    runtime: "vue",
    styling: "tailwind",
    componentSource: "custom",
    motion: "vue-transition",
    islandStrategy: "client:load",
  };
}

function validMotionIntents(): Record<string, unknown>[] {
  return [
    {
      id: "fade-in",
      trigger: "mount",
      properties: ["opacity"],
      durationToken: "duration-short",
      easingToken: "ease-out",
      interruptible: true,
      reducedMotion: "render final state immediately",
    },
    {
      id: "slide-list",
      trigger: "list-change",
      properties: ["transform"],
      durationToken: "duration-medium",
      easingToken: "ease-in-out",
      interruptible: false,
      reducedMotion: "skip transform, show final position",
    },
  ];
}

const GENERATED_AT = "2026-07-21T00:00:00.000Z";

function neutralInput(): DesignHandoffInput {
  return {
    spec: validUiSpec(),
    target: neutralWebTarget(),
    motionIntents: validMotionIntents(),
    generatedAt: GENERATED_AT,
  };
}

function reactInput(): DesignHandoffInput {
  return {
    spec: validUiSpec(),
    target: astroReactTarget(),
    motionIntents: validMotionIntents(),
    generatedAt: GENERATED_AT,
  };
}

function vueInput(): DesignHandoffInput {
  return {
    spec: validUiSpec(),
    target: astroVueTarget(),
    motionIntents: validMotionIntents(),
    generatedAt: GENERATED_AT,
  };
}

// ---------------------------------------------------------------------------
// parseDesignHandoff re-export
// ---------------------------------------------------------------------------

describe("parseDesignHandoff (re-exported)", () => {
  it("is exported from design-handoff and validates input", () => {
    const handoff = parseDesignHandoff(neutralInput());
    expect(handoff.target.id).toBe("neutral-web");
    expect(UiSpec.safeParse(handoff.spec).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildDesignHandoff
// ---------------------------------------------------------------------------

describe("buildDesignHandoff", () => {
  it("returns a trusted DesignHandoffT for a valid neutral-web input", () => {
    const handoff = buildDesignHandoff(neutralInput());
    expect(handoff.target.id).toBe("neutral-web");
    expect(UiSpec.safeParse(handoff.spec).success).toBe(true);
    expect(handoff.motionIntents).toHaveLength(2);
    expect(handoff.generatedAt).toBe(GENERATED_AT);
  });

  it("is the fail-closed integration boundary: rejects incompatible combos", () => {
    // astro-vue cannot use a React-only component source. parseDesignHandoff
    // alone accepts the shape; buildDesignHandoff must reject it via the
    // registry resolution step.
    const bad: DesignHandoffInput = {
      spec: validUiSpec(),
      target: { ...astroVueTarget(), componentSource: "shadcn" },
      motionIntents: validMotionIntents(),
      generatedAt: GENERATED_AT,
    };
    expect(() => buildDesignHandoff(bad)).toThrow();
  });

  it("rejects an invalid UiSpec (fail-closed at the parse boundary)", () => {
    const bad: DesignHandoffInput = {
      spec: { garbage: true },
      target: neutralWebTarget(),
      motionIntents: [],
      generatedAt: GENERATED_AT,
    };
    expect(() => buildDesignHandoff(bad)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Helpers for asserting on rendered markdown
// ---------------------------------------------------------------------------

/** Extract every `## ` section header from the rendered markdown, in order. */
function sectionHeaders(md: string): string[] {
  return md
    .split("\n")
    .filter((line) => line.startsWith("## "))
    .map((line) => line.slice(3).trim());
}

/** Parse the YAML frontmatter block (between --- fences) into a string map. */
function frontmatter(md: string): Record<string, string> {
  const lines = md.split("\n");
  if (lines[0] !== "---") throw new Error("expected frontmatter to start with ---");
  const end = lines.indexOf("---", 1);
  if (end === -1) throw new Error("frontmatter never closes");
  const out: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    out[key] = value;
  }
  return out;
}

// ===========================================================================
// (1) 19-section outline
// ===========================================================================

describe("renderDesignHandoffMarkdown: 19-section outline", () => {
  const md = renderDesignHandoffMarkdown(parseDesignHandoff(neutralInput()));
  const headers = sectionHeaders(md);

  it("emits exactly 19 ## sections", () => {
    expect(headers.length).toBe(19);
  });

  it("places Implementation guidance at section 14", () => {
    expect(headers[13]).toMatch(/implementation/i);
  });

  it("includes all required content sections", () => {
    // Join once for substring checks (case-insensitive).
    const joined = headers.join("\n").toLowerCase();
    for (const required of [
      "direction",
      "context",
      "sources",
      "color",
      "typography",
      "layout",
      "voice",
      "technique",
      "anti-pattern",
      "accessibility",
      "motion",
      "implementation",
      "acceptance",
    ]) {
      expect(joined).toContain(required);
    }
  });
});

// ===========================================================================
// (2) Frontmatter fields
// ===========================================================================

describe("renderDesignHandoffMarkdown: frontmatter", () => {
  it("emits all required frontmatter fields for astro-vue (matches the plan example)", () => {
    const fm = frontmatter(
      renderDesignHandoffMarkdown(parseDesignHandoff(vueInput())),
    );
    expect(fm["spec_version"]).toBe('"1.0"');
    expect(fm["handoff_version"]).toBe('"web-1.0"');
    expect(fm["target_profile"]).toBe('"astro-vue"');
    expect(fm["platform"]).toBe('"web"');
    expect(fm["site_framework"]).toBe('"astro@5.x"');
    expect(fm["site_framework_version_policy"]).toBe('"range"');
    expect(fm["ui_runtime"]).toBe('"vue@3.x"');
    expect(fm["ui_runtime_version_policy"]).toBe('"range"');
    expect(fm["styling"]).toBe('"tailwind@4.x"');
    expect(fm["styling_version_policy"]).toBe('"range"');
    expect(fm["component_source"]).toBe('"custom@unversioned"');
    expect(fm["motion"]).toBe('"vue-transition@unversioned"');
  });

  it("neutral-web frontmatter carries none for framework and runtime", () => {
    const fm = frontmatter(
      renderDesignHandoffMarkdown(parseDesignHandoff(neutralInput())),
    );
    expect(fm["target_profile"]).toBe('"neutral-web"');
    expect(fm["site_framework"]).toBe('"none"');
    expect(fm["ui_runtime"]).toBe('"none"');
    expect(fm["styling"]).toBe('"vanilla-css@unversioned"');
    expect(fm["component_source"]).toBe('"native-html@unversioned"');
    expect(fm["motion"]).toBe('"css@unversioned"');
  });

  it("astro-react frontmatter carries astro + react ranges", () => {
    const fm = frontmatter(
      renderDesignHandoffMarkdown(parseDesignHandoff(reactInput())),
    );
    expect(fm["target_profile"]).toBe('"astro-react"');
    expect(fm["site_framework"]).toBe('"astro@5.x"');
    expect(fm["ui_runtime"]).toBe('"react@19.x"');
    expect(fm["ui_runtime_version_policy"]).toBe('"range"');
    expect(fm["component_source"]).toBe('"shadcn@unversioned"');
    expect(fm["motion"]).toBe('"motion@unversioned"');
  });
});

// ===========================================================================
// (3) neutral-web: CSS variables, no React/Astro/Tailwind setup
// ===========================================================================

describe("renderDesignHandoffMarkdown: neutral-web", () => {
  const md = renderDesignHandoffMarkdown(parseDesignHandoff(neutralInput()));

  it("emits CSS custom properties (:root block)", () => {
    expect(md).toContain(":root {");
    expect(md).toContain("--bg-canvas:");
    expect(md).toContain("--text-primary:");
  });

  it("does NOT emit a Tailwind @theme block", () => {
    expect(md).not.toContain("@theme");
  });

  it("does NOT emit an island strategy subsection or React/Astro install guidance", () => {
    // neutral-web has no host framework and no UI runtime. The renderer must
    // NOT emit an Island strategy subsection, must NOT carry a client directive,
    // and must NOT include React/Astro install instructions.
    expect(md).not.toContain("### Island strategy");
    expect(md).not.toContain("client:load");
    expect(md).not.toContain("npm install react");
    expect(md).not.toContain("@astrojs/react");
    expect(md).not.toContain("@astrojs/vue");
    expect(md).not.toContain("react-dom");
  });

  it("does NOT recommend a JS motion runtime", () => {
    expect(md.toLowerCase()).not.toContain("framer motion");
    expect(md.toLowerCase()).not.toContain("gsap");
  });
});

// ===========================================================================
// (4) astro-react: island strategy + React setup
// ===========================================================================

describe("renderDesignHandoffMarkdown: astro-react", () => {
  const md = renderDesignHandoffMarkdown(parseDesignHandoff(reactInput()));

  it("mentions the island strategy (client directive)", () => {
    expect(md.toLowerCase()).toContain("island");
    expect(md).toContain("client:load");
  });

  it("includes React setup guidance (react + react-dom install)", () => {
    expect(md).toContain("react");
    expect(md).toContain("react-dom");
    expect(md).toContain("@astrojs/react");
  });

  it("emits a Tailwind @theme block (styling tailwind)", () => {
    expect(md).toContain("@theme");
  });
});

// ===========================================================================
// (5) astro-vue: island + Vue motion guidance, NO React-only recommendation
// ===========================================================================

describe("renderDesignHandoffMarkdown: astro-vue", () => {
  const md = renderDesignHandoffMarkdown(parseDesignHandoff(vueInput()));

  it("mentions the island strategy", () => {
    expect(md.toLowerCase()).toContain("island");
    expect(md).toContain("client:load");
  });

  it("includes Vue setup guidance (@astrojs/vue + vue)", () => {
    expect(md).toContain("vue");
    expect(md).toContain("@astrojs/vue");
  });

  it("references Vue <Transition>/<TransitionGroup> motion primitives", () => {
    const lower = md.toLowerCase();
    expect(lower).toContain("transition");
    expect(lower).toContain("transitiongroup");
  });

  it("does NOT recommend React-only component libraries", () => {
    // shadcn, radix, mui, react-aria, kumo, base-ui are React-only and must
    // not appear as a recommendation for an astro-vue target.
    const lower = md.toLowerCase();
    expect(lower).not.toContain("shadcn");
    expect(lower).not.toContain("radix");
    expect(lower).not.toContain("mui");
    expect(lower).not.toContain("react-aria");
    expect(lower).not.toContain("kumo");
    expect(lower).not.toContain("base-ui");
  });

  it("does NOT include @astrojs/react or react-dom install guidance", () => {
    expect(md).not.toContain("@astrojs/react");
    expect(md).not.toContain("react-dom");
  });
});

// ===========================================================================
// (6) Byte-identical repeated rendering
// ===========================================================================

describe("renderDesignHandoffMarkdown: determinism", () => {
  for (const [name, input] of [
    ["neutral-web", neutralInput()],
    ["astro-react", reactInput()],
    ["astro-vue", vueInput()],
  ] as const) {
    it(`${name} produces byte-identical output on repeated renders`, () => {
      const handoff = parseDesignHandoff(input);
      const a = renderDesignHandoffMarkdown(handoff);
      const b = renderDesignHandoffMarkdown(handoff);
      expect(a).toBe(b);
      // Two independently-parsed handoffs from the same input also match.
      const c = renderDesignHandoffMarkdown(parseDesignHandoff(input));
      expect(a).toBe(c);
    });
  }
});

// ===========================================================================
// (7) JSON output: stable key order + final newline
// ===========================================================================

describe("renderDesignHandoffJson", () => {
  const handoff = parseDesignHandoff(vueInput());

  it("emits valid JSON ending with a final newline", () => {
    const json = renderDesignHandoffJson(handoff);
    expect(json.endsWith("\n")).toBe(true);
    const body = json.slice(0, -1);
    expect(() => JSON.parse(body)).not.toThrow();
  });

  it("carries the required top-level keys in a stable order", () => {
    const json = renderDesignHandoffJson(handoff);
    const parsed = JSON.parse(json.slice(0, -1));
    const keys = Object.keys(parsed);
    // Required keys are all present.
    expect(parsed).toHaveProperty("spec_version", "1.0");
    expect(parsed).toHaveProperty("handoff_version", "web-1.0");
    expect(parsed).toHaveProperty("target_profile");
    expect(parsed).toHaveProperty("platform");
    expect(parsed).toHaveProperty("dependency_manifest");
    expect(parsed).toHaveProperty("source_manifest");
    expect(parsed).toHaveProperty("motion_intents");
    // Stable key order: spec_version precedes handoff_version precedes target_profile.
    expect(keys.indexOf("spec_version")).toBeLessThan(keys.indexOf("handoff_version"));
    expect(keys.indexOf("handoff_version")).toBeLessThan(keys.indexOf("target_profile"));
  });

  it("produces byte-identical output on repeated renders", () => {
    const a = renderDesignHandoffJson(handoff);
    const b = renderDesignHandoffJson(handoff);
    expect(a).toBe(b);
  });

  it("differs from the markdown output", () => {
    expect(renderDesignHandoffJson(handoff)).not.toBe(
      renderDesignHandoffMarkdown(handoff),
    );
  });
});

// ===========================================================================
// (8) renderDesignHandoff dispatch: only "markdown" | "json"
// ===========================================================================

describe("renderDesignHandoff dispatch", () => {
  const handoff = parseDesignHandoff(neutralInput());

  it("renders markdown when format is 'markdown'", () => {
    expect(renderDesignHandoff(handoff, "markdown")).toBe(
      renderDesignHandoffMarkdown(handoff),
    );
  });

  it("renders json when format is 'json'", () => {
    expect(renderDesignHandoff(handoff, "json")).toBe(
      renderDesignHandoffJson(handoff),
    );
  });

  it("throws on an unknown format", () => {
    expect(() =>
      renderDesignHandoff(handoff, "pdf" as "markdown" | "json"),
    ).toThrow();
    expect(() =>
      renderDesignHandoff(handoff, "yaml" as "markdown" | "json"),
    ).toThrow();
  });
});

// ===========================================================================
// (9) Not-captured sources generate explicit warnings
// ===========================================================================

describe("not-captured source warnings", () => {
  it("astro-vue implementation section warns about every not-captured source", () => {
    const handoff = parseDesignHandoff(vueInput());
    const md = renderDesignHandoffMarkdown(handoff);
    // The vue source manifest includes astro-official, vue-official,
    // tailwind-official — all not-captured in this slice.
    const resolved = resolveWebTarget(handoff.target);
    // Sanity: registry is reachable; the handoff renderer uses the same data.
    expect(resolved.profile.id).toBe("astro-vue");

    // Every not-captured source the renderer knows about must be named in a
    // WARNING line within the implementation section.
    expect(md).toMatch(/warning/i);
    // Concrete source IDs that the vue profile references.
    expect(md).toContain("astro-official");
    expect(md).toContain("vue-official");
    expect(md).toContain("tailwind-official");
    // And the fixed reason text is preserved verbatim.
    expect(md).toContain("source bytes are not vendored");
  });

  it("neutral-web has no sources to warn about (empty source manifest)", () => {
    const md = renderDesignHandoffMarkdown(parseDesignHandoff(neutralInput()));
    // neutral-web references no documentation sources in this slice; no
    // fabricated source IDs should appear.
    expect(md).not.toContain("astro-official");
    expect(md).not.toContain("vue-official");
    expect(md).not.toContain("shadcn-official");
  });

  it("preserves not-captured provenance (never invents a hash)", () => {
    const md = renderDesignHandoffMarkdown(parseDesignHandoff(reactInput()));
    // No 64-char lowercase hex hash should appear — nothing is captured.
    expect(md).not.toMatch(/[0-9a-f]{64}/);
  });
});

// ===========================================================================
// (10) No corpus records or third-party source in output
// ===========================================================================

describe("no corpus records or third-party source", () => {
  for (const [name, input] of [
    ["neutral-web", neutralInput()],
    ["astro-react", reactInput()],
    ["astro-vue", vueInput()],
  ] as const) {
    it(`${name} markdown contains no private corpus paths or third-party source`, () => {
      const md = renderDesignHandoffMarkdown(parseDesignHandoff(input));
      // No private corpus material.
      expect(md).not.toContain(".c2-private");
      // No copied third-party source code blocks beyond the token CSS / theme.
      // (The only fenced code blocks allowed are the token CSS / Tailwind theme
      // and optionally a small motion snippet — never component library source.)
      const fenced = md.match(/```[\s\S]*?```/g) ?? [];
      for (const block of fenced) {
        expect(block).not.toContain(".c2-private");
        // No large verbatim source dumps (heuristic: no import statements from
        // third-party packages inside a fenced block).
        expect(block).not.toMatch(/import\s+.*\sfrom\s+['"](react|vue|@mui|@radix|framer-motion)['"]/);
      }
    });

    it(`${name} json contains no private corpus paths`, () => {
      const json = renderDesignHandoffJson(parseDesignHandoff(input));
      expect(json).not.toContain(".c2-private");
    });
  }
});

// ===========================================================================
// Section 14 implementation guidance content
// ===========================================================================

describe("implementation section (section 14) content", () => {
  function implementationSection(md: string): string {
    const headers = sectionHeaders(md);
    const implIdx = headers.findIndex((h) => /implementation/i.test(h));
    expect(implIdx).toBe(13); // section 14 (0-indexed 13)
    // Slice from this header to the next ## header.
    const start = md.indexOf(`## ${headers[implIdx]}`);
    const rest = md.slice(start + 1);
    const nextIdx = rest.indexOf("\n## ");
    return nextIdx === -1 ? rest : rest.slice(0, nextIdx);
  }

  it("astro-react implementation contains setup, dependencies, island, motion adapter", () => {
    const md = renderDesignHandoffMarkdown(parseDesignHandoff(reactInput()));
    const section = implementationSection(md).toLowerCase();
    expect(section).toContain("setup");
    expect(section).toContain("dependenc");
    expect(section).toContain("island");
    expect(section).toContain("motion");
    expect(section).toContain("source");
  });

  it("astro-vue implementation names the component-role mapping and token filename", () => {
    const md = renderDesignHandoffMarkdown(parseDesignHandoff(vueInput()));
    const section = implementationSection(md).toLowerCase();
    expect(section).toContain("component");
    expect(section).toContain("token");
  });

  it("every profile implementation section carries the source-attribution rule", () => {
    for (const input of [neutralInput(), reactInput(), vueInput()]) {
      const md = renderDesignHandoffMarkdown(parseDesignHandoff(input));
      const section = implementationSection(md).toLowerCase();
      expect(section).toContain("attribution");
    }
  });
});
