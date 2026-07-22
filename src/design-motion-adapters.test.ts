/**
 * design-motion-adapters.test.ts — TDD for semantic motion mappings.
 *
 * Task 4 of the web design adapters plan. Motion intents are EXPLICIT structured
 * input (never parsed from free-form UiSpec motion notes). validateMotionIntents
 * enforces the schema; renderWebMotionGuidance emits implementation-specific
 * guidance that varies by profile (Vue Transition, CSS/View Transitions
 * distinction, neutral CSS with data-state selectors); motionSourceRefs returns
 * SourceRefs that are URLs only and must NEVER become install dependencies.
 */
import { describe, expect, it } from "vitest";
import {
  validateMotionIntents,
  renderWebMotionGuidance,
  motionSourceRefs,
} from "./design-motion-adapters.js";
import {
  MotionIntentSchema,
  type MotionIntent,
  type WebTargetProfile,
  type SourceRef,
} from "./design-target-contracts.js";
import { buildDependencyManifest } from "./design-adapter-registry.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function neutralWeb(profile?: Partial<WebTargetProfile>): WebTargetProfile {
  return {
    id: "neutral-web",
    platform: "web",
    siteFramework: "none",
    runtime: "none",
    styling: "vanilla-css",
    componentSource: "native-html",
    motion: "css",
    islandStrategy: null,
    ...profile,
  };
}

function astroVue(profile?: Partial<WebTargetProfile>): WebTargetProfile {
  return {
    id: "astro-vue",
    platform: "web",
    siteFramework: "astro",
    runtime: "vue",
    styling: "vanilla-css",
    componentSource: "custom",
    motion: "vue-transition",
    islandStrategy: "client:load",
    ...profile,
  };
}

function astroReact(profile?: Partial<WebTargetProfile>): WebTargetProfile {
  return {
    id: "astro-react",
    platform: "web",
    siteFramework: "astro",
    runtime: "react",
    styling: "tailwind",
    componentSource: "shadcn",
    motion: "motion",
    islandStrategy: "client:load",
    ...profile,
  };
}

/** A single valid MotionIntent object (untrusted input shape). */
function validIntent(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "fade-in",
    trigger: "mount",
    properties: ["opacity"],
    durationToken: "duration-short",
    easingToken: "ease-out",
    interruptible: true,
    reducedMotion: "render final state immediately",
    ...over,
  };
}

/** A small list of valid intent objects. */
function validIntents(): Record<string, unknown>[] {
  return [
    validIntent({ id: "fade-in", trigger: "mount", properties: ["opacity"] }),
    validIntent({
      id: "slide-list",
      trigger: "list-change",
      properties: ["transform"],
      reducedMotion: "skip transform, show final position",
    }),
  ];
}

// ---------------------------------------------------------------------------
// validateMotionIntents
// ---------------------------------------------------------------------------

describe("validateMotionIntents", () => {
  it("returns the validated intents for a valid list", () => {
    const validated = validateMotionIntents(validIntents());
    expect(validated).toHaveLength(2);
    expect(validated[0].id).toBe("fade-in");
    expect(validated[1].id).toBe("slide-list");
  });

  it("each returned item satisfies MotionIntentSchema", () => {
    const validated = validateMotionIntents(validIntents());
    for (const intent of validated) {
      expect(MotionIntentSchema.safeParse(intent).success).toBe(true);
    }
  });

  it("accepts an empty list", () => {
    expect(validateMotionIntents([])).toEqual([]);
  });

  it("throws on an intent missing required reducedMotion", () => {
    const bad = validIntent();
    delete (bad as Record<string, unknown>).reducedMotion;
    expect(() => validateMotionIntents([bad])).toThrow();
  });

  it("throws on an intent with empty reducedMotion", () => {
    expect(() =>
      validateMotionIntents([validIntent({ reducedMotion: "" })]),
    ).toThrow();
  });

  it("throws on an intent with an unknown extra field (strict)", () => {
    expect(() =>
      validateMotionIntents([validIntent({ extra: "no" })]),
    ).toThrow();
  });

  it("throws on a non-array input", () => {
    expect(() => validateMotionIntents("not an array" as unknown as MotionIntent[])).toThrow();
    expect(() => validateMotionIntents({ id: "x" } as unknown as MotionIntent[])).toThrow();
  });

  it("throws on an intent whose properties is not an array of strings", () => {
    expect(() =>
      validateMotionIntents([validIntent({ properties: "opacity" })]),
    ).toThrow();
  });

  it("is pure: identical input yields identical output", () => {
    const a = validateMotionIntents(validIntents());
    const b = validateMotionIntents(validIntents());
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// renderWebMotionGuidance — Vue
// ---------------------------------------------------------------------------

describe("renderWebMotionGuidance (astro-vue)", () => {
  const profile = astroVue();

  it("mentions Vue <Transition> for enter/exit", () => {
    const md = renderWebMotionGuidance(profile, validateMotionIntents(validIntents()));
    expect(md.toLowerCase()).toContain("transition");
    expect(md).toMatch(/enter\/exit|enter and exit|enter-exit|enter|exit/i);
  });

  it("mentions <TransitionGroup> for list changes", () => {
    const md = renderWebMotionGuidance(profile, validateMotionIntents(validIntents()));
    expect(md.toLowerCase()).toContain("transitiongroup");
    expect(md).toMatch(/list/i);
  });

  it("includes prefers-reduced-motion fallback guidance", () => {
    const md = renderWebMotionGuidance(profile, validateMotionIntents(validIntents()));
    expect(md.toLowerCase()).toContain("prefers-reduced-motion");
  });

  it("references the supplied intents by id", () => {
    const intents = validateMotionIntents(validIntents());
    const md = renderWebMotionGuidance(profile, intents);
    expect(md).toContain("fade-in");
    expect(md).toContain("slide-list");
  });

  it("is deterministic: identical inputs produce byte-identical output", () => {
    const intents = validateMotionIntents(validIntents());
    const a = renderWebMotionGuidance(profile, intents);
    const b = renderWebMotionGuidance(profile, intents);
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// renderWebMotionGuidance — neutral-web with view-transitions
// ---------------------------------------------------------------------------

describe("renderWebMotionGuidance (neutral-web + view-transitions)", () => {
  const profile = neutralWeb({ motion: "view-transitions" });

  it("distinguishes local state changes (CSS) from route/layout (View Transitions)", () => {
    const md = renderWebMotionGuidance(profile, validateMotionIntents(validIntents()));
    // Local state -> CSS
    expect(md.toLowerCase()).toContain("css");
    // Route/layout -> View Transitions
    expect(md.toLowerCase()).toContain("view transition");
    // Both scope words present
    expect(md.toLowerCase()).toMatch(/local.*state|state.*change/);
    expect(md.toLowerCase()).toMatch(/route|layout/);
  });

  it("includes prefers-reduced-motion fallback guidance", () => {
    const md = renderWebMotionGuidance(profile, validateMotionIntents(validIntents()));
    expect(md.toLowerCase()).toContain("prefers-reduced-motion");
  });

  it("is deterministic", () => {
    const intents = validateMotionIntents(validIntents());
    expect(renderWebMotionGuidance(profile, intents)).toBe(
      renderWebMotionGuidance(profile, intents),
    );
  });
});

// ---------------------------------------------------------------------------
// renderWebMotionGuidance — neutral-web with css-view-transitions
// ---------------------------------------------------------------------------

describe("renderWebMotionGuidance (neutral-web + css-view-transitions)", () => {
  const profile = neutralWeb({ motion: "css-view-transitions" });

  it("covers both CSS local transitions and View Transitions for layout", () => {
    const md = renderWebMotionGuidance(profile, validateMotionIntents(validIntents()));
    expect(md.toLowerCase()).toContain("css");
    expect(md.toLowerCase()).toContain("view transition");
  });

  it("includes prefers-reduced-motion fallback guidance", () => {
    const md = renderWebMotionGuidance(profile, validateMotionIntents(validIntents()));
    expect(md.toLowerCase()).toContain("prefers-reduced-motion");
  });
});

// ---------------------------------------------------------------------------
// renderWebMotionGuidance — neutral-web with css only (no view transitions)
// ---------------------------------------------------------------------------

describe("renderWebMotionGuidance (neutral-web + css)", () => {
  const profile = neutralWeb();

  it("recommends CSS transitions and data-state attribute selectors", () => {
    const md = renderWebMotionGuidance(profile, validateMotionIntents(validIntents()));
    expect(md.toLowerCase()).toContain("css transition");
    expect(md.toLowerCase()).toContain("data-state");
  });

  it("does NOT recommend View Transitions for the css-only profile", () => {
    const md = renderWebMotionGuidance(profile, validateMotionIntents(validIntents()));
    expect(md.toLowerCase()).not.toContain("view transition");
  });

  it("includes prefers-reduced-motion fallback guidance", () => {
    const md = renderWebMotionGuidance(profile, validateMotionIntents(validIntents()));
    expect(md.toLowerCase()).toContain("prefers-reduced-motion");
  });
});

// ---------------------------------------------------------------------------
// renderWebMotionGuidance — markdown shape
// ---------------------------------------------------------------------------

describe("renderWebMotionGuidance (markdown shape)", () => {
  it("emits a markdown section header", () => {
    const md = renderWebMotionGuidance(
      neutralWeb(),
      validateMotionIntents(validIntents()),
    );
    expect(md).toMatch(/^#{1,6}\s+.+/m);
  });

  it("every profile produces non-empty guidance", () => {
    const intents = validateMotionIntents(validIntents());
    for (const profile of [
      neutralWeb(),
      neutralWeb({ motion: "view-transitions" }),
      neutralWeb({ motion: "css-view-transitions" }),
      astroVue(),
      astroReact(),
    ]) {
      const md = renderWebMotionGuidance(profile, intents);
      expect(md.trim().length).toBeGreaterThan(0);
      // Every profile must carry the reduced-motion fallback.
      expect(md.toLowerCase()).toContain("prefers-reduced-motion");
    }
  });

  it("does not embed private corpus material (no .c2-private paths)", () => {
    const md = renderWebMotionGuidance(
      astroVue(),
      validateMotionIntents(validIntents()),
    );
    expect(md).not.toContain(".c2-private");
  });
});

// ---------------------------------------------------------------------------
// motionSourceRefs — URLs only, never install dependencies
// ---------------------------------------------------------------------------

describe("motionSourceRefs", () => {
  it("returns Vue documentation for astro-vue motion", () => {
    const refs = motionSourceRefs(astroVue());
    expect(refs.length).toBeGreaterThan(0);
    const vueRef = refs.find((r) => r.sourceId === "vue-official");
    expect(vueRef).toBeDefined();
    expect(vueRef!.url).toBe("https://vuejs.org/guide/built-ins/transition.html");
  });

  it("returns SourceRefs that all satisfy SourceRefSchema", async () => {
    const { SourceRefSchema } = await import("./design-target-contracts.js");
    for (const profile of [
      neutralWeb(),
      neutralWeb({ motion: "view-transitions" }),
      neutralWeb({ motion: "css-view-transitions" }),
      astroVue(),
      astroReact(),
    ]) {
      const refs = motionSourceRefs(profile);
      for (const ref of refs) {
        expect(SourceRefSchema.safeParse(ref).success).toBe(true);
      }
    }
  });

  it("preserves not-captured provenance (no fabricated hashes)", () => {
    const refs = motionSourceRefs(astroVue());
    for (const ref of refs) {
      expect(ref.snapshotStatus).toBe("not-captured");
      expect(ref.snapshotSha256).toBeNull();
    }
  });

  it("returns deterministic, registry-ordered refs", () => {
    const a = motionSourceRefs(astroVue());
    const b = motionSourceRefs(astroVue());
    expect(a).toEqual(b);
  });

  it("is empty (or docs-only) for neutral-web css — no JS motion runtime source", () => {
    // css-only neutral-web has no per-profile motion docs in this slice.
    const refs = motionSourceRefs(neutralWeb());
    for (const ref of refs) {
      // Should only ever be public docs URLs, never installable packages.
      expect(ref.url).toMatch(/^https?:\/\//);
    }
  });

  // ---------------------------------------------------------------------------
  // CRITICAL: motionSourceRefs must never become install dependencies
  // ---------------------------------------------------------------------------

  it("motionSourceRefs output NEVER appears in buildDependencyManifest (URLs, not packages)", () => {
    // For every supported profile, the set of motionSourceRef URLs must be
    // disjoint from the dependency manifest's packageNames. Source references
    // are documentation URLs, NOT install dependencies.
    for (const profile of [
      neutralWeb(),
      neutralWeb({ motion: "view-transitions" }),
      neutralWeb({ motion: "css-view-transitions" }),
      astroVue(),
      astroReact(),
    ]) {
      const motionRefs: SourceRef[] = motionSourceRefs(profile);
      const deps = buildDependencyManifest(profile);
      const depPackageNames = new Set(deps.map((d) => d.packageName));

      for (const ref of motionRefs) {
        // The URL must never be a packageName.
        expect(depPackageNames.has(ref.url)).toBe(false);
        // And the sourceId must never masquerade as a packageName either.
        expect(depPackageNames.has(ref.sourceId)).toBe(false);
        // URLs are web links, not npm package specifiers.
        expect(ref.url).toMatch(/^https?:\/\//);
      }
    }
  });
});
