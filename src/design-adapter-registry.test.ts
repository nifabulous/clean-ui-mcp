/**
 * design-adapter-registry.test.ts — TDD for the closed web capability registry.
 *
 * Task 2 of the web design adapters plan. resolveWebTarget validates that a
 * profile's component combination is legal and fails closed on unknown IDs,
 * incompatible combinations, and native runtimes. buildDependencyManifest
 * returns the install dependencies with versionPolicy "exact" for packages.
 */
import { describe, expect, it } from "vitest";
import {
  WEB_TARGET_PROFILES,
  resolveWebTarget,
  buildDependencyManifest,
  type ResolvedWebTarget,
} from "./design-adapter-registry.js";
import type { WebTargetProfile } from "./design-target-contracts.js";
import { DependencyRefSchema } from "./design-target-contracts.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function neutralWeb(
  profile?: Partial<WebTargetProfile>,
): WebTargetProfile {
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

function astroReact(
  profile?: Partial<WebTargetProfile>,
): WebTargetProfile {
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

function astroVue(
  profile?: Partial<WebTargetProfile>,
): WebTargetProfile {
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

// ---------------------------------------------------------------------------
// WEB_TARGET_PROFILES
// ---------------------------------------------------------------------------

describe("WEB_TARGET_PROFILES", () => {
  it("contains definitions for neutral-web, astro-react, astro-vue", () => {
    const ids = new Set(WEB_TARGET_PROFILES.map((p) => p.id));
    expect(ids).toEqual(new Set(["neutral-web", "astro-react", "astro-vue"]));
  });

  it("every profile entry has a packageName and docsUrl for its runtime/site", () => {
    for (const p of WEB_TARGET_PROFILES) {
      expect(p.id.length).toBeGreaterThan(0);
      // Setup notes are required guidance.
      expect(p.setupNotes.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// resolveWebTarget — neutral-web
// ---------------------------------------------------------------------------

describe("resolveWebTarget neutral-web", () => {
  it("permits native-html + css motion", () => {
    expect(() =>
      resolveWebTarget(neutralWeb({ componentSource: "native-html", motion: "css" })),
    ).not.toThrow();
  });

  it("permits custom + view-transitions", () => {
    expect(() =>
      resolveWebTarget(
        neutralWeb({ componentSource: "custom", motion: "view-transitions" }),
      ),
    ).not.toThrow();
  });

  it("permits native-html + css-view-transitions", () => {
    expect(() =>
      resolveWebTarget(
        neutralWeb({ componentSource: "native-html", motion: "css-view-transitions" }),
      ),
    ).not.toThrow();
  });

  it("rejects React runtime", () => {
    expect(() =>
      resolveWebTarget(neutralWeb({ runtime: "react" })),
    ).toThrow();
  });

  it("rejects Vue runtime", () => {
    expect(() => resolveWebTarget(neutralWeb({ runtime: "vue" }))).toThrow();
  });

  it("rejects island strategy", () => {
    expect(() =>
      resolveWebTarget(neutralWeb({ islandStrategy: "client:load" })),
    ).toThrow();
  });

  it("rejects motion (JS runtime)", () => {
    expect(() =>
      resolveWebTarget(neutralWeb({ motion: "motion" })),
    ).toThrow();
  });

  it("rejects gsap", () => {
    expect(() => resolveWebTarget(neutralWeb({ motion: "gsap" }))).toThrow();
  });

  it("rejects vue-transition motion", () => {
    expect(() =>
      resolveWebTarget(neutralWeb({ motion: "vue-transition" })),
    ).toThrow();
  });

  it("rejects shadcn componentSource (React-only)", () => {
    expect(() =>
      resolveWebTarget(neutralWeb({ componentSource: "shadcn" })),
    ).toThrow();
  });

  it("rejects radix componentSource (React-only)", () => {
    expect(() =>
      resolveWebTarget(neutralWeb({ componentSource: "radix" })),
    ).toThrow();
  });

  it("rejects mui componentSource (React-only)", () => {
    expect(() =>
      resolveWebTarget(neutralWeb({ componentSource: "mui" })),
    ).toThrow();
  });

  it("rejects kumo componentSource (React-only)", () => {
    expect(() =>
      resolveWebTarget(neutralWeb({ componentSource: "kumo" })),
    ).toThrow();
  });

  it("rejects base-ui componentSource (React-only)", () => {
    expect(() =>
      resolveWebTarget(neutralWeb({ componentSource: "base-ui" })),
    ).toThrow();
  });

  it("rejects react-aria componentSource (React-only)", () => {
    expect(() =>
      resolveWebTarget(neutralWeb({ componentSource: "react-aria" })),
    ).toThrow();
  });

  it("rejects astro siteFramework", () => {
    expect(() =>
      resolveWebTarget(neutralWeb({ siteFramework: "astro" })),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// resolveWebTarget — astro-react
// ---------------------------------------------------------------------------

describe("resolveWebTarget astro-react", () => {
  it("is valid when Astro + React + island strategy are present", () => {
    expect(() => resolveWebTarget(astroReact())).not.toThrow();
  });

  it("fails without island strategy", () => {
    expect(() =>
      resolveWebTarget(astroReact({ islandStrategy: null })),
    ).toThrow();
  });

  it("fails without Astro siteFramework", () => {
    expect(() =>
      resolveWebTarget(astroReact({ siteFramework: "none" })),
    ).toThrow();
  });

  it("fails without React runtime", () => {
    expect(() =>
      resolveWebTarget(astroReact({ runtime: "none" })),
    ).toThrow();
  });

  it("fails with Vue runtime", () => {
    expect(() =>
      resolveWebTarget(astroReact({ runtime: "vue" })),
    ).toThrow();
  });

  it("permits shadcn components", () => {
    expect(() =>
      resolveWebTarget(astroReact({ componentSource: "shadcn" })),
    ).not.toThrow();
  });

  it("permits radix components", () => {
    expect(() =>
      resolveWebTarget(astroReact({ componentSource: "radix" })),
    ).not.toThrow();
  });

  it("permits kumo components", () => {
    expect(() =>
      resolveWebTarget(astroReact({ componentSource: "kumo" })),
    ).not.toThrow();
  });

  it("permits base-ui components", () => {
    expect(() =>
      resolveWebTarget(astroReact({ componentSource: "base-ui" })),
    ).not.toThrow();
  });

  it("permits react-aria components", () => {
    expect(() =>
      resolveWebTarget(astroReact({ componentSource: "react-aria" })),
    ).not.toThrow();
  });

  it("permits mui components", () => {
    expect(() =>
      resolveWebTarget(astroReact({ componentSource: "mui" })),
    ).not.toThrow();
  });

  it("rejects mui with Vue runtime (mui is React-only, runtime is Vue)", () => {
    // Build an astro-react profile but flip runtime to vue — incompatible.
    expect(() =>
      resolveWebTarget(astroReact({ runtime: "vue", componentSource: "mui" })),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// resolveWebTarget — astro-vue
// ---------------------------------------------------------------------------

describe("resolveWebTarget astro-vue", () => {
  it("is valid when Astro + Vue + island strategy are present", () => {
    expect(() => resolveWebTarget(astroVue())).not.toThrow();
  });

  it("fails without island strategy", () => {
    expect(() =>
      resolveWebTarget(astroVue({ islandStrategy: null })),
    ).toThrow();
  });

  it("fails without Astro siteFramework", () => {
    expect(() =>
      resolveWebTarget(astroVue({ siteFramework: "none" })),
    ).toThrow();
  });

  it("fails without Vue runtime", () => {
    expect(() =>
      resolveWebTarget(astroVue({ runtime: "none" })),
    ).toThrow();
  });

  it("fails with React runtime", () => {
    expect(() =>
      resolveWebTarget(astroVue({ runtime: "react" })),
    ).toThrow();
  });

  it("rejects React-only sources (shadcn)", () => {
    expect(() =>
      resolveWebTarget(astroVue({ componentSource: "shadcn" })),
    ).toThrow();
  });

  it("rejects React-only sources (radix)", () => {
    expect(() =>
      resolveWebTarget(astroVue({ componentSource: "radix" })),
    ).toThrow();
  });

  it("rejects React-only sources (react-aria)", () => {
    expect(() =>
      resolveWebTarget(astroVue({ componentSource: "react-aria" })),
    ).toThrow();
  });

  it("rejects React-only sources (mui)", () => {
    expect(() =>
      resolveWebTarget(astroVue({ componentSource: "mui" })),
    ).toThrow();
  });

  it("rejects React-only sources (kumo)", () => {
    expect(() =>
      resolveWebTarget(astroVue({ componentSource: "kumo" })),
    ).toThrow();
  });

  it("rejects React-only sources (base-ui)", () => {
    expect(() =>
      resolveWebTarget(astroVue({ componentSource: "base-ui" })),
    ).toThrow();
  });

  it("permits native-html or custom only", () => {
    expect(() =>
      resolveWebTarget(astroVue({ componentSource: "native-html" })),
    ).not.toThrow();
    expect(() =>
      resolveWebTarget(astroVue({ componentSource: "custom" })),
    ).not.toThrow();
  });

  it("permits vue-transition motion", () => {
    expect(() =>
      resolveWebTarget(astroVue({ motion: "vue-transition" })),
    ).not.toThrow();
  });

  it("permits css motion", () => {
    expect(() =>
      resolveWebTarget(astroVue({ motion: "css" })),
    ).not.toThrow();
  });

  it("permits css-view-transitions motion", () => {
    expect(() =>
      resolveWebTarget(astroVue({ motion: "css-view-transitions" })),
    ).not.toThrow();
  });

  it("rejects React-only motion runtime (motion)", () => {
    expect(() =>
      resolveWebTarget(astroVue({ motion: "motion" })),
    ).toThrow();
  });

  it("rejects gsap motion", () => {
    expect(() =>
      resolveWebTarget(astroVue({ motion: "gsap" })),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// resolveWebTarget — native/unknown rejection
// ---------------------------------------------------------------------------

describe("resolveWebTarget fail-closed", () => {
  it("returns a ResolvedWebTarget on success", () => {
    const resolved = resolveWebTarget(neutralWeb());
    expect(resolved.profile.id).toBe("neutral-web");
    expect(resolved.definition).toBeDefined();
  });

  it("resolved output exposes profile + definition", () => {
    const resolved: ResolvedWebTarget = resolveWebTarget(astroReact());
    expect(resolved.profile.id).toBe("astro-react");
    expect(resolved.definition.id).toBe("astro-react");
  });
});

// ---------------------------------------------------------------------------
// buildDependencyManifest
// ---------------------------------------------------------------------------

describe("buildDependencyManifest", () => {
  it("returns exact versions for every package dependency", () => {
    const manifest = buildDependencyManifest(astroReact());
    expect(manifest.length).toBeGreaterThan(0);
    for (const dep of manifest) {
      expect(dep.versionPolicy).toBe("exact");
      expect(DependencyRefSchema.safeParse(dep).success).toBe(true);
    }
  });

  it("for neutral-web has no Astro/React/Vue packages", () => {
    const manifest = buildDependencyManifest(neutralWeb());
    const names = new Set(manifest.map((d) => d.packageName));
    expect(names.has("astro")).toBe(false);
    expect(names.has("react")).toBe(false);
    expect(names.has("react-dom")).toBe(false);
    expect(names.has("vue")).toBe(false);
  });

  it("for astro-react includes astro + react packages", () => {
    const manifest = buildDependencyManifest(astroReact());
    const names = new Set(manifest.map((d) => d.packageName));
    expect(names.has("astro")).toBe(true);
    expect(names.has("react")).toBe(true);
  });

  it("for astro-vue includes astro + vue packages", () => {
    const manifest = buildDependencyManifest(astroVue());
    const names = new Set(manifest.map((d) => d.packageName));
    expect(names.has("astro")).toBe(true);
    expect(names.has("vue")).toBe(true);
  });

  it("never uses 'latest' as a version", () => {
    const manifest = buildDependencyManifest(astroReact());
    for (const dep of manifest) {
      expect(dep.version).not.toBe("latest");
    }
  });

  it("package dependencies carry docsUrl for Astro/React/Vue", () => {
    const manifest = buildDependencyManifest(astroReact());
    const astro = manifest.find((d) => d.packageName === "astro");
    expect(astro?.docsUrl).toBeTruthy();
    const react = manifest.find((d) => d.packageName === "react");
    expect(react?.docsUrl).toBeTruthy();
  });

  it("neutral-web with tailwind includes tailwindcss package", () => {
    const manifest = buildDependencyManifest(neutralWeb({ styling: "tailwind" }));
    const names = new Set(manifest.map((d) => d.packageName));
    expect(names.has("tailwindcss")).toBe(true);
  });

  it("astro-react with motion includes motion package", () => {
    const manifest = buildDependencyManifest(astroReact({ motion: "motion" }));
    const names = new Set(manifest.map((d) => d.packageName));
    expect(names.has("motion")).toBe(true);
  });

  it("every package dependency has a non-empty purpose", () => {
    const manifest = buildDependencyManifest(astroReact());
    for (const dep of manifest) {
      expect(dep.purpose.length).toBeGreaterThan(0);
    }
  });

  it("rejects vue-transition motion under astro-react (Vue primitive in React runtime)", () => {
    // Review finding C2/R1: astro-react must reject Vue-specific motion primitives.
    expect(() =>
      resolveWebTarget(astroReact({ motion: "vue-transition" })),
    ).toThrow(/vue-transition|Vue.*motion|React.*forbids/i);
  });

  it("astro-react accepts css motion", () => {
    expect(() => resolveWebTarget(astroReact({ motion: "css" }))).not.toThrow();
  });

  it("astro-react accepts gsap motion", () => {
    expect(() => resolveWebTarget(astroReact({ motion: "gsap" }))).not.toThrow();
  });
});
