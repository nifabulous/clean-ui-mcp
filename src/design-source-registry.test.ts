/**
 * design-source-registry.test.ts — TDD for the checked-in source registry.
 *
 * Task 2 of the web design adapters plan. Every source entry starts as
 * not-captured with the fixed reason "source bytes are not vendored". No hash
 * may be fabricated. URLs are pinned to the spec.
 */
import { describe, expect, it } from "vitest";
import {
  DESIGN_SOURCE_REGISTRY,
  buildSourceManifest,
} from "./design-source-registry.js";
import type { WebTargetProfile } from "./design-target-contracts.js";
import { SourceRefSchema } from "./design-target-contracts.js";

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

// ---------------------------------------------------------------------------
// Registry provenance guarantees
// ---------------------------------------------------------------------------

describe("DESIGN_SOURCE_REGISTRY provenance", () => {
  it("every entry starts as not-captured with a non-empty reason", () => {
    for (const entry of DESIGN_SOURCE_REGISTRY) {
      expect(entry.snapshotStatus).toBe("not-captured");
      expect(entry.snapshotReason).toBeTruthy();
      expect(typeof entry.snapshotReason).toBe("string");
      expect((entry.snapshotReason ?? "").length).toBeGreaterThan(0);
    }
  });

  it("no entry has a fabricated snapshotSha256 (all null)", () => {
    for (const entry of DESIGN_SOURCE_REGISTRY) {
      expect(entry.snapshotSha256).toBeNull();
    }
  });

  it("every entry uses the fixed reason 'source bytes are not vendored'", () => {
    for (const entry of DESIGN_SOURCE_REGISTRY) {
      expect(entry.snapshotReason).toBe("source bytes are not vendored");
    }
  });

  it("every entry validates against SourceRefSchema", () => {
    for (const entry of DESIGN_SOURCE_REGISTRY) {
      const result = SourceRefSchema.safeParse(entry);
      expect(result.success).toBe(true);
    }
  });

  it("every entry has a kind, licenseStatus, and attribution", () => {
    for (const entry of DESIGN_SOURCE_REGISTRY) {
      expect(entry.kind.length).toBeGreaterThan(0);
      expect(entry.licenseStatus.length).toBeGreaterThan(0);
      expect(entry.attribution.length).toBeGreaterThan(0);
    }
  });

  it("contains the 7 spec-mandated source IDs", () => {
    const ids = new Set(DESIGN_SOURCE_REGISTRY.map((e) => e.sourceId));
    expect(ids).toEqual(
      new Set([
        "astro-official",
        "vue-official",
        "tailwind-official",
        "shadcn-official",
        "kumo-official",
        "transitions-dev",
        "21st-community",
      ]),
    );
  });

  it("URLs match the spec exactly", () => {
    const byId = new Map(DESIGN_SOURCE_REGISTRY.map((e) => [e.sourceId, e.url]));
    expect(byId.get("astro-official")).toBe(
      "https://docs.astro.build/pl/guides/framework-components/",
    );
    expect(byId.get("vue-official")).toBe(
      "https://vuejs.org/guide/built-ins/transition.html",
    );
    expect(byId.get("tailwind-official")).toBe(
      "https://tailwindcss.com/docs/functions-and-directives",
    );
    expect(byId.get("shadcn-official")).toBe(
      "https://ui.shadcn.com/docs/installation/manual",
    );
    expect(byId.get("kumo-official")).toBe("https://kumo-ui.com/installation/");
    expect(byId.get("transitions-dev")).toBe("https://transitions.dev/");
    expect(byId.get("21st-community")).toBe("https://21st.dev/");
  });
});

// ---------------------------------------------------------------------------
// buildSourceManifest
// ---------------------------------------------------------------------------

describe("buildSourceManifest", () => {
  it("returns relevant sources for neutral-web with tailwind styling", () => {
    const manifest = buildSourceManifest(neutralWeb({ styling: "tailwind" }));
    const ids = manifest.map((s) => s.sourceId);
    expect(ids).toContain("tailwind-official");
  });

  it("returns relevant sources for astro-react (astro + react sources)", () => {
    const manifest = buildSourceManifest(astroReact());
    const ids = manifest.map((s) => s.sourceId);
    expect(ids).toContain("astro-official");
    // shadcn componentSource pulls in shadcn-official.
    expect(ids).toContain("shadcn-official");
  });

  it("returns astro + vue sources for astro-vue", () => {
    const manifest = buildSourceManifest(astroVue());
    const ids = manifest.map((s) => s.sourceId);
    expect(ids).toContain("astro-official");
    expect(ids).toContain("vue-official");
  });

  it("every manifest entry validates against SourceRefSchema", () => {
    const manifest = buildSourceManifest(astroReact());
    for (const entry of manifest) {
      expect(SourceRefSchema.safeParse(entry).success).toBe(true);
    }
  });

  it("manifest entries preserve not-captured status and reason", () => {
    const manifest = buildSourceManifest(astroReact());
    expect(manifest.length).toBeGreaterThan(0);
    for (const entry of manifest) {
      expect(entry.snapshotStatus).toBe("not-captured");
      expect(entry.snapshotReason).toBe("source bytes are not vendored");
      expect(entry.snapshotSha256).toBeNull();
    }
  });

  it("neutral-web with css motion and vanilla-css styling omits react-only sources", () => {
    const manifest = buildSourceManifest(neutralWeb());
    const ids = new Set(manifest.map((s) => s.sourceId));
    expect(ids.has("shadcn-official")).toBe(false);
    expect(ids.has("kumo-official")).toBe(false);
  });

  it("astro-vue omits react-only sources (shadcn, radix, react-aria, mui)", () => {
    const manifest = buildSourceManifest(astroVue({ componentSource: "custom" }));
    const ids = new Set(manifest.map((s) => s.sourceId));
    expect(ids.has("shadcn-official")).toBe(false);
    expect(ids.has("kumo-official")).toBe(false);
  });

  it("returns kumo-official when componentSource is kumo", () => {
    const manifest = buildSourceManifest(
      astroReact({ componentSource: "kumo" }),
    );
    const ids = manifest.map((s) => s.sourceId);
    expect(ids).toContain("kumo-official");
  });
});
