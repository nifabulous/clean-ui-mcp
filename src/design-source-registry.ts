/**
 * design-source-registry.ts — the checked-in source provenance registry.
 *
 * Task 2 of the web design adapters plan. Every entry is a SourceRef pinned to
 * a public documentation URL. In this offline slice NO source bytes are
 * vendored, so every entry starts as `not-captured` with the fixed reason
 * "source bytes are not vendored". A later source-snapshot task may promote an
 * entry to `captured` ONLY when bytes and a verified SHA-256 are checked in.
 *
 * No hash may be fabricated. The schema in design-target-contracts.ts forbids
 * a hash unless status is `captured`; here we always emit `null`.
 */
import type { SourceRef, WebTargetProfile } from "./design-target-contracts.js";

// ---------------------------------------------------------------------------
// Fixed constants
// ---------------------------------------------------------------------------

/**
 * The single, immutable reason attached to every not-captured entry in this
 * slice. Centralized so no call site can drift into inventing a different one.
 */
export const NOT_CAPTURED_REASON = "source bytes are not vendored" as const;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * The seven checked-in source IDs and their pinned URLs. Order is stable and
 * intentional (framework docs first, then component libraries, then community).
 */
export const DESIGN_SOURCE_REGISTRY: readonly SourceRef[] = [
  {
    sourceId: "astro-official",
    kind: "documentation",
    url: "https://docs.astro.build/pl/guides/framework-components/",
    snapshotStatus: "not-captured",
    snapshotSha256: null,
    snapshotReason: NOT_CAPTURED_REASON,
    licenseStatus: "MIT",
    attribution: "Astro Docs — https://docs.astro.build/",
  },
  {
    sourceId: "vue-official",
    kind: "documentation",
    url: "https://vuejs.org/guide/built-ins/transition.html",
    snapshotStatus: "not-captured",
    snapshotSha256: null,
    snapshotReason: NOT_CAPTURED_REASON,
    licenseStatus: "MIT",
    attribution: "Vue.js Docs — https://vuejs.org/",
  },
  {
    sourceId: "tailwind-official",
    kind: "documentation",
    url: "https://tailwindcss.com/docs/functions-and-directives",
    snapshotStatus: "not-captured",
    snapshotSha256: null,
    snapshotReason: NOT_CAPTURED_REASON,
    licenseStatus: "MIT",
    attribution: "Tailwind CSS Docs — https://tailwindcss.com/",
  },
  {
    sourceId: "shadcn-official",
    kind: "documentation",
    url: "https://ui.shadcn.com/docs/installation/manual",
    snapshotStatus: "not-captured",
    snapshotSha256: null,
    snapshotReason: NOT_CAPTURED_REASON,
    licenseStatus: "MIT",
    attribution: "shadcn/ui Docs — https://ui.shadcn.com/",
  },
  {
    sourceId: "kumo-official",
    kind: "documentation",
    url: "https://kumo-ui.com/installation/",
    snapshotStatus: "not-captured",
    snapshotSha256: null,
    snapshotReason: NOT_CAPTURED_REASON,
    licenseStatus: "MIT",
    attribution: "Kumo UI Docs — https://kumo-ui.com/",
  },
  {
    sourceId: "transitions-dev",
    kind: "community-catalog",
    url: "https://transitions.dev/",
    snapshotStatus: "not-captured",
    snapshotSha256: null,
    snapshotReason: NOT_CAPTURED_REASON,
    licenseStatus: "unknown",
    attribution: "transitions.dev community catalog",
  },
  {
    sourceId: "21st-community",
    kind: "community-catalog",
    url: "https://21st.dev/",
    snapshotStatus: "not-captured",
    snapshotSha256: null,
    snapshotReason: NOT_CAPTURED_REASON,
    licenseStatus: "unknown",
    attribution: "21st.dev community registry",
  },
];

// Lookup by sourceId for internal use. Built once from the registry.
const SOURCE_BY_ID: ReadonlyMap<string, SourceRef> = new Map(
  DESIGN_SOURCE_REGISTRY.map((entry) => [entry.sourceId, entry]),
);

function lookup(sourceId: string): SourceRef | undefined {
  return SOURCE_BY_ID.get(sourceId);
}

// ---------------------------------------------------------------------------
// buildSourceManifest
// ---------------------------------------------------------------------------

/**
 * Return the relevant SourceRefs for a given profile. Sources are selected by:
 *
 * - siteFramework astro  -> astro-official
 * - runtime vue          -> vue-official
 * - styling tailwind     -> tailwind-official
 * - componentSource      -> component-library source when applicable
 * - motion               -> motion-source when applicable
 *
 * Selection only ADDS entries that exist in the registry; it never synthesizes
 * a new source, URL, or hash. Order follows the registry order for determinism.
 */
export function buildSourceManifest(profile: WebTargetProfile): SourceRef[] {
  const wanted = new Set<string>();

  if (profile.siteFramework === "astro") {
    wanted.add("astro-official");
  }

  if (profile.runtime === "vue") {
    wanted.add("vue-official");
  }

  if (profile.styling === "tailwind") {
    wanted.add("tailwind-official");
  }

  switch (profile.componentSource) {
    case "shadcn":
      wanted.add("shadcn-official");
      break;
    case "kumo":
      wanted.add("kumo-official");
      break;
    // native-html, custom, base-ui, radix, react-aria, mui have no checked-in
    // source page in this slice; nothing is added.
    default:
      break;
  }

  switch (profile.motion) {
    case "motion":
      // motion (formerly Framer Motion) is commonly catalogued on transitions.dev.
      wanted.add("transitions-dev");
      break;
    case "gsap":
      // No checked-in GSAP source in this slice.
      break;
    default:
      break;
  }

  // Always include community catalogs as discoverable references when a JS
  // motion runtime or React component library is selected — they catalog the
  // patterns the handoff recommends, not source we vendor.
  if (profile.componentSource !== "native-html" && profile.componentSource !== "custom") {
    wanted.add("21st-community");
  }

  // Emit in registry order for deterministic output.
  const result: SourceRef[] = [];
  for (const entry of DESIGN_SOURCE_REGISTRY) {
    if (wanted.has(entry.sourceId)) {
      // Defensive copy so downstream code cannot mutate the checked-in registry.
      result.push({ ...entry });
    }
  }
  return result;
}
