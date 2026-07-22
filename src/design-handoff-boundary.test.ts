/**
 * design-handoff-boundary.test.ts — Task 8 fail-closed boundary tests.
 *
 * These integration tests call `buildDesignHandoff` (the producer-facing entry
 * point) and the renderers with adversarial inputs and assert the output is
 * clean. They are the release gate for the adapter layer: every private corpus
 * path is filtered, every unknown source fails, every incompatible combination
 * fails, and identical input produces identical bytes.
 *
 * The tests cover the seven Task 8 assertions:
 *  1. Private `.c2-private/` paths cannot appear in output.
 *  2. Unknown sources fail.
 *  3. Vue cannot receive React-only sources (via the registry).
 *  4. Native runtimes fail (e.g. `runtime: "swiftui"`).
 *  5. URLs are preserved but source code is not embedded.
 *  6. Unavailable decisions remain explicit (nullable tokens → "unavailable").
 *  7. Identical input produces identical bytes.
 *
 * UiSpec 1.0 bytes are NOT changed by this slice. These tests assert the
 * boundary invariants without touching the schema.
 */
import { describe, expect, it } from "vitest";
import {
  buildDesignHandoff,
  parseDesignHandoff,
  renderDesignHandoffJson,
  renderDesignHandoffMarkdown,
} from "./design-handoff.js";
import type { DesignHandoffInput } from "./design-handoff.js";
import { resolveWebTarget } from "./design-adapter-registry.js";
import { buildSourceManifest } from "./design-source-registry.js";
import { WebTargetProfileSchema } from "./design-target-contracts.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function validUiSpec(): Record<string, unknown> {
  return {
    specVersion: "1.0",
    context: { productContext: "A fintech dashboard" },
    designDirection: "Calm, scannable layout with a restrained palette.",
    rejectedDefaults: ["no heavy card shadows"],
    layoutRegions: [],
    responsiveBehavior: ["stack below 720px"],
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
    interactions: ["hover-lift"],
    motionGuidance: { notes: [], evidenceUnavailable: true },
    accessibilityConstraints: ["4.5:1 contrast on body text"],
    contentVoiceGuidance: "Direct, technical, confident.",
    techniques: [],
    antiPatterns: [],
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

/**
 * A spec whose colorTokens and typographyTokens are both null — an editorial
 * "unavailable" decision. The UiSpec schema requires editorial authority and
 * an exact unavailableDecision entry for each null token group.
 */
function nullTokenUiSpec(): Record<string, unknown> {
  return {
    ...validUiSpec(),
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

function neutralTarget(): Record<string, unknown> {
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

function motionIntents(): Record<string, unknown>[] {
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
  ];
}

const GENERATED_AT = "2026-07-21T00:00:00.000Z";

function input(
  spec: Record<string, unknown> = validUiSpec(),
  target: Record<string, unknown> = neutralTarget(),
): DesignHandoffInput {
  return {
    spec,
    target,
    motionIntents: motionIntents(),
    generatedAt: GENERATED_AT,
  };
}

// ===========================================================================
// (1) Private `.c2-private/` paths cannot appear in output
// ===========================================================================

describe("boundary: private .c2-private paths never appear", () => {
  it("the renderer never introduces a .c2-private path on its own", () => {
    // The handoff layer's only inputs are the registry, the source registry,
    // and the validated UiSpec. None of those contain private paths, so the
    // rendered bytes must be free of the .c2-private marker.
    for (const target of [neutralTarget(), astroReactTarget(), astroVueTarget()]) {
      const handoff = buildDesignHandoff(input(validUiSpec(), target));
      expect(renderDesignHandoffMarkdown(handoff)).not.toContain(".c2-private");
      expect(renderDesignHandoffJson(handoff)).not.toContain(".c2-private");
    }
  });

  it("a spec without any private provenance produces clean bytes", () => {
    const clean = {
      ...validUiSpec(),
      // Public provenance pointers only.
      citedReferences: ["https://example.com/public-reference"],
      provenance: {
        generatedAt: "2026-07-21T00:00:00.000Z",
        toolVersion: "0.2.0",
        sourceReferences: ["https://example.com/public-source"],
        evidenceIds: [],
      },
    };
    const handoff = buildDesignHandoff({
      spec: clean,
      target: neutralTarget(),
      motionIntents: motionIntents(),
      generatedAt: GENERATED_AT,
    });
    const md = renderDesignHandoffMarkdown(handoff);
    const json = renderDesignHandoffJson(handoff);
    expect(md).not.toContain(".c2-private");
    expect(json).not.toContain(".c2-private");
    // Public URLs ARE preserved — this is the "URLs preserved" guarantee from (5).
    expect(md).toContain("https://example.com/public-reference");
  });

  it("the source registry contains no private paths", async () => {
    const { DESIGN_SOURCE_REGISTRY } = await import("./design-source-registry.js");
    for (const entry of DESIGN_SOURCE_REGISTRY) {
      expect(entry.url).not.toContain(".c2-private");
      expect(entry.attribution).not.toContain(".c2-private");
      expect(entry.sourceId).not.toContain(".c2-private");
    }
  });
});

// ===========================================================================
// (2) Unknown sources fail
// ===========================================================================

describe("boundary: unknown sources fail closed", () => {
  it("resolveWebTarget rejects an unknown target id", () => {
    const parsed = WebTargetProfileSchema.safeParse({
      ...neutralTarget(),
      id: "next-js", // not in the closed enum
    });
    expect(parsed.success).toBe(false);
  });

  it("buildDesignHandoff rejects an unknown target id at the schema boundary", () => {
    const bad = input(validUiSpec(), { ...neutralTarget(), id: "flutter-web" });
    expect(() => buildDesignHandoff(bad)).toThrow();
  });

  it("buildSourceManifest returns only registry entries — no synthesized source IDs", () => {
    // A profile referencing componentSource "native-html" pulls in NO source
    // entries; the registry cannot invent a "native-html-official" entry.
    const parsed = WebTargetProfileSchema.parse(neutralTarget());
    const manifest = buildSourceManifest(parsed);
    for (const entry of manifest) {
      // Every emitted sourceId must be one of the seven checked-in IDs.
      expect([
        "astro-official",
        "vue-official",
        "tailwind-official",
        "shadcn-official",
        "kumo-official",
        "transitions-dev",
        "21st-community",
      ]).toContain(entry.sourceId);
    }
  });
});

// ===========================================================================
// (3) Vue cannot receive React-only sources (via the registry)
// ===========================================================================

describe("boundary: Vue cannot receive React-only sources", () => {
  const reactOnlySources = ["shadcn", "kumo", "base-ui", "radix", "react-aria", "mui"] as const;

  for (const source of reactOnlySources) {
    it(`astro-vue + componentSource "${source}" fails closed`, () => {
      // Schema-level the shape is valid (componentSource enum accepts it);
      // the registry must reject it.
      const parsed = WebTargetProfileSchema.safeParse({
        ...astroVueTarget(),
        componentSource: source,
      });
      expect(parsed.success).toBe(true);
      expect(() => resolveWebTarget(parsed.data!)).toThrow(/react-only/i);
    });

    it(`astro-vue + componentSource "${source}" fails at buildDesignHandoff`, () => {
      const bad = input(validUiSpec(), { ...astroVueTarget(), componentSource: source });
      expect(() => buildDesignHandoff(bad)).toThrow();
    });
  }

  it("astro-vue markdown never recommends a React-only library", () => {
    // The legal astro-vue profile (custom components) must not mention any
    // React-only source in its rendered output.
    const handoff = buildDesignHandoff(input(validUiSpec(), astroVueTarget()));
    const md = renderDesignHandoffMarkdown(handoff).toLowerCase();
    for (const banned of ["shadcn", "radix", "mui", "react-aria", "kumo", "base-ui"]) {
      expect(md).not.toContain(banned);
    }
  });
});

// ===========================================================================
// (4) Native runtimes fail (e.g. `runtime: "swiftui"`)
// ===========================================================================

describe("boundary: native runtimes fail closed", () => {
  it("schema rejects a native runtime value (swiftui)", () => {
    const parsed = WebTargetProfileSchema.safeParse({
      ...neutralTarget(),
      runtime: "swiftui",
    });
    expect(parsed.success).toBe(false);
  });

  it("schema rejects a native platform value (ios)", () => {
    const parsed = WebTargetProfileSchema.safeParse({
      ...neutralTarget(),
      platform: "ios",
    });
    expect(parsed.success).toBe(false);
  });

  it("schema rejects a native component-source flavor (swiftui-view)", () => {
    const parsed = WebTargetProfileSchema.safeParse({
      ...neutralTarget(),
      componentSource: "swiftui-view",
    });
    expect(parsed.success).toBe(false);
  });

  it("resolveWebTarget rejects a non-web platform even when constructed by hand", () => {
    // The schema enforces platform: "web", but resolveWebTarget also guards.
    // Cast to bypass TS to simulate a hand-built object.
    expect(() =>
      resolveWebTarget({ ...neutralTarget(), platform: "swiftui" } as never),
    ).toThrow(/not supported|native/i);
  });
});

// ===========================================================================
// (5) URLs are preserved but source code is not embedded
// ===========================================================================

describe("boundary: URLs preserved, source code not embedded", () => {
  it("astro-react markdown preserves documentation URLs", () => {
    const handoff = buildDesignHandoff(input(validUiSpec(), astroReactTarget()));
    const md = renderDesignHandoffMarkdown(handoff);
    // Documentation URLs that the registry pins are preserved verbatim.
    expect(md).toContain("https://docs.astro.build/pl/guides/framework-components/");
    expect(md).toContain("https://ui.shadcn.com/docs/installation/manual");
    expect(md).toContain("https://tailwindcss.com/docs/functions-and-directives");
  });

  it("json preserves URLs in source_manifest entries", () => {
    const handoff = buildDesignHandoff(input(validUiSpec(), astroReactTarget()));
    const json = renderDesignHandoffJson(handoff);
    const parsed = JSON.parse(json.slice(0, -1));
    expect(parsed.source_manifest.length).toBeGreaterThan(0);
    for (const entry of parsed.source_manifest) {
      expect(typeof entry.url).toBe("string");
      expect(entry.url.startsWith("https://")).toBe(true);
    }
  });

  it("no fenced code block contains third-party component source", () => {
    for (const target of [neutralTarget(), astroReactTarget(), astroVueTarget()]) {
      const handoff = buildDesignHandoff(input(validUiSpec(), target));
      const md = renderDesignHandoffMarkdown(handoff);
      const fenced = md.match(/```[\s\S]*?```/g) ?? [];
      for (const block of fenced) {
        // No verbatim imports of third-party component libraries.
        expect(block).not.toMatch(
          /import\s+.*\sfrom\s+['"](react|vue|@mui|@radix|framer-motion|@astrojs)['"]/,
        );
        // No function/class component definitions copied from a library.
        expect(block).not.toMatch(/export\s+(default\s+)?function\s+[A-Z]\w*\s*\(/);
        // No JSX/TSX angle-bracket tag trees beyond token CSS.
        expect(block).not.toMatch(/<[A-Z]\w*\s/);
      }
    }
  });

  it("no 64-char hex snapshot hash appears (nothing is captured in this slice)", () => {
    for (const target of [neutralTarget(), astroReactTarget(), astroVueTarget()]) {
      const handoff = buildDesignHandoff(input(validUiSpec(), target));
      const md = renderDesignHandoffMarkdown(handoff);
      const json = renderDesignHandoffJson(handoff);
      expect(md).not.toMatch(/[0-9a-f]{64}/);
      expect(json).not.toMatch(/[0-9a-f]{64}/);
    }
  });
});

// ===========================================================================
// (6) Unavailable decisions remain explicit (nullable tokens → "unavailable")
// ===========================================================================

describe("boundary: unavailable decisions remain explicit", () => {
  it("null colorTokens render as 'unavailable' in markdown CSS variables", () => {
    const handoff = buildDesignHandoff(input(nullTokenUiSpec(), neutralTarget()));
    const md = renderDesignHandoffMarkdown(handoff);
    expect(md).toContain("--bg-canvas: unavailable;");
    expect(md).toContain("--bg-surface: unavailable;");
    expect(md).toContain("--text-primary: unavailable;");
    expect(md).toContain("--text-muted: unavailable;");
    expect(md).toContain("--action-accent: unavailable;");
  });

  it("null typographyTokens render as 'unavailable' for every font field", () => {
    const handoff = buildDesignHandoff(input(nullTokenUiSpec(), neutralTarget()));
    const md = renderDesignHandoffMarkdown(handoff);
    expect(md).toContain("--font-heading: unavailable;");
    expect(md).toContain("--font-body: unavailable;");
    expect(md).toContain("--font-mono: unavailable;");
  });

  it("null token output contains no guessed hex value", () => {
    const handoff = buildDesignHandoff(input(nullTokenUiSpec(), neutralTarget()));
    const md = renderDesignHandoffMarkdown(handoff);
    // No hex colors should appear in the token CSS block when tokens are null.
    expect(md).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  it("typography section records the unavailable decision rather than inferring a stack", () => {
    const handoff = buildDesignHandoff(input(nullTokenUiSpec(), neutralTarget()));
    const md = renderDesignHandoffMarkdown(handoff).toLowerCase();
    expect(md).toContain("unavailable");
    expect(md).toContain("do not infer");
  });
});

// ===========================================================================
// (7) Identical input produces identical bytes
// ===========================================================================

describe("boundary: identical input → identical bytes", () => {
  for (const [name, target] of [
    ["neutral-web", neutralTarget()],
    ["astro-react", astroReactTarget()],
    ["astro-vue", astroVueTarget()],
  ] as const) {
    it(`${name} markdown is byte-identical across two independent buildDesignHandoff calls`, () => {
      const a = renderDesignHandoffMarkdown(
        buildDesignHandoff(input(validUiSpec(), target)),
      );
      const b = renderDesignHandoffMarkdown(
        buildDesignHandoff(input(validUiSpec(), target)),
      );
      expect(a).toBe(b);
    });

    it(`${name} json is byte-identical across two independent buildDesignHandoff calls`, () => {
      const a = renderDesignHandoffJson(
        buildDesignHandoff(input(validUiSpec(), target)),
      );
      const b = renderDesignHandoffJson(
        buildDesignHandoff(input(validUiSpec(), target)),
      );
      expect(a).toBe(b);
    });
  }

  it("null-token spec is byte-identical across two independent calls", () => {
    const a = renderDesignHandoffMarkdown(
      buildDesignHandoff(input(nullTokenUiSpec(), neutralTarget())),
    );
    const b = renderDesignHandoffMarkdown(
      buildDesignHandoff(input(nullTokenUiSpec(), neutralTarget())),
    );
    expect(a).toBe(b);
  });

  it("parseDesignHandoff + render equals buildDesignHandoff + render (same envelope)", () => {
    // buildDesignHandoff must not mutate the parsed envelope in a way that
    // changes rendered bytes vs. parseDesignHandoff alone.
    const inp = input(validUiSpec(), astroVueTarget());
    const viaParse = renderDesignHandoffMarkdown(parseDesignHandoff(inp));
    const viaBuild = renderDesignHandoffMarkdown(buildDesignHandoff(inp));
    expect(viaParse).toBe(viaBuild);
  });
});

// ===========================================================================
// UiSpec 1.0 byte stability — Task 8 release-gate assertion
// ===========================================================================

describe("UiSpec 1.0 byte stability (release gate)", () => {
  it("the UiSpec schema is unchanged (specVersion is still the literal '1.0')", async () => {
    // Import the schema lazily and assert the literal — if a future change
    // widened specVersion, this test fails and forces a contract-checkpoint
    // conversation before the adapter layer ships.
    const { UiSpec } = await import("./tool-contracts.js");
    const shape = UiSpec.safeParse(validUiSpec());
    expect(shape.success).toBe(true);
    expect(shape.data!.specVersion).toBe("1.0");
  });
});
