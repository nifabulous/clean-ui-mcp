/**
 * design-adapter-registry.ts — the closed web target capability registry.
 *
 * Task 2 of the web design adapters plan. resolveWebTarget validates that a
 * profile's component combination is legal and FAILS CLOSED on unknown IDs,
 * incompatible combinations, and native runtimes. buildDependencyManifest
 * returns install dependencies with `versionPolicy: "exact"` for packages.
 *
 * The registry is closed: only neutral-web, astro-react, and astro-vue are
 * supported. An omitted target is the caller's concern; this module never
 * silently substitutes React for a missing target.
 */
import type {
  DependencyRef,
  WebComponentSourceT,
  WebMotionT,
  WebTargetIdT,
  WebTargetProfile,
} from "./design-target-contracts.js";

// ===========================================================================
// 1. Closed enums (mirrors of the contract enums, local for readability)
// ===========================================================================

/** Component sources that require a React runtime. */
const REACT_ONLY_SOURCES: ReadonlySet<WebComponentSourceT> = new Set([
  "shadcn",
  "kumo",
  "base-ui",
  "radix",
  "react-aria",
  "mui",
]);

/** Motion adapters that ship a JavaScript runtime (not CSS/Vue). */
const JS_MOTION_RUNTIMES: ReadonlySet<WebMotionT> = new Set([
  "motion",
  "gsap",
]);

/** Motion adapters permitted under neutral-web (no JS runtime). */
const NEUTRAL_ALLOWED_MOTION: ReadonlySet<WebMotionT> = new Set([
  "css",
  "view-transitions",
  "css-view-transitions",
]);

/** Motion adapters permitted under astro-vue. */
const VUE_ALLOWED_MOTION: ReadonlySet<WebMotionT> = new Set([
  "css",
  "css-view-transitions",
  "vue-transition",
]);

// ===========================================================================
// 2. WEB_TARGET_PROFILES — checked-in profile definitions
// ===========================================================================

/**
 * Static metadata for each supported target ID: human-readable setup notes,
 * package names, documentation URLs, and the source IDs this profile tends to
 * reference. Versions here describe target COMPATIBILITY (range policy); exact
 * install pins live in buildDependencyManifest.
 */
export interface WebTargetProfileDefinition {
  readonly id: WebTargetIdT;
  /** Short label for renderer display. */
  readonly label: string;
  /** Site framework package name (null for neutral-web). */
  readonly siteFrameworkPackage: string | null;
  /** Site framework compatibility range. */
  readonly siteFrameworkRange: string | null;
  /** UI runtime package name (null when no runtime). */
  readonly runtimePackage: string | null;
  /** UI runtime compatibility range. */
  readonly runtimeRange: string | null;
  /** Documentation URL for the site framework or runtime. */
  readonly docsUrl: string | null;
  /** Setup guidance for the renderer's implementation section. */
  readonly setupNotes: string;
  /** Source IDs typically referenced by this profile. */
  readonly sourceIds: readonly string[];
}

export const WEB_TARGET_PROFILES: readonly WebTargetProfileDefinition[] = [
  {
    id: "neutral-web",
    label: "Neutral web (no framework, no runtime)",
    siteFrameworkPackage: null,
    siteFrameworkRange: null,
    runtimePackage: null,
    runtimeRange: null,
    docsUrl: null,
    setupNotes:
      "Emit semantic HTML and CSS custom properties. No site framework, no UI runtime, no island strategy. Use CSS transitions, View Transitions API, or data-state selectors for motion. prefers-reduced-motion must fall back to the final state.",
    sourceIds: [],
  },
  {
    id: "astro-react",
    label: "Astro host with React islands",
    siteFrameworkPackage: "astro",
    siteFrameworkRange: "5.x",
    runtimePackage: "react",
    runtimeRange: "19.x",
    docsUrl: "https://docs.astro.build/pl/guides/framework-components/",
    setupNotes:
      "Install Astro and the React integration. Hydrate React islands with an explicit client directive (client:load, client:idle, client:visible). React-compatible component libraries (shadcn/ui, Radix, Kumo, Base UI, React Aria, MUI) are permitted. Motion must be the `motion` package or CSS; prefers-reduced-motion must fall back to the final state.",
    sourceIds: ["astro-official", "shadcn-official", "kumo-official"],
  },
  {
    id: "astro-vue",
    label: "Astro host with Vue islands",
    siteFrameworkPackage: "astro",
    siteFrameworkRange: "5.x",
    runtimePackage: "vue",
    runtimeRange: "3.x",
    docsUrl: "https://docs.astro.build/pl/guides/framework-components/",
    setupNotes:
      "Install Astro and the Vue integration (@astrojs/vue). Hydrate Vue islands with an explicit client directive. Use native HTML or custom components only — React-only component libraries are not permitted. Use Vue <Transition>/<TransitionGroup>, CSS, or View Transitions for motion; prefers-reduced-motion must fall back to the final state.",
    sourceIds: ["astro-official", "vue-official"],
  },
];

const PROFILE_BY_ID: ReadonlyMap<WebTargetIdT, WebTargetProfileDefinition> =
  new Map(WEB_TARGET_PROFILES.map((p) => [p.id, p]));

// ===========================================================================
// 3. ResolvedWebTarget + resolveWebTarget
// ===========================================================================

/** The result of a successful capability resolution. */
export interface ResolvedWebTarget {
  readonly profile: WebTargetProfile;
  readonly definition: WebTargetProfileDefinition;
}

/**
 * Validate that a profile's combination of id + siteFramework + runtime +
 * styling + componentSource + motion + islandStrategy is legal. Throws on any
 * illegal combination (fail-closed). Returns the profile paired with its
 * checked-in definition on success.
 *
 * Rules (from the plan):
 *  1. neutral-web requires no site framework and no runtime.
 *  2. astro-react requires Astro plus React.
 *  3. astro-vue requires Astro plus Vue.
 *  4. shadcn, kumo, base-ui, radix, react-aria, mui are React-only.
 *  5. neutral-web cannot select a JS motion runtime (motion, gsap) or an island strategy.
 *  6. Astro targets require a non-none island strategy when runtime is React or Vue.
 *  7. Native runtimes and unknown IDs are rejected.
 */
export function resolveWebTarget(profile: WebTargetProfile): ResolvedWebTarget {
  const definition = PROFILE_BY_ID.get(profile.id);
  if (!definition) {
    throw new Error(
      `resolveWebTarget: unknown web target id "${profile.id}" — only neutral-web, astro-react, astro-vue are supported`,
    );
  }

  // Native platforms / unknown platforms are rejected up front. The schema
  // already constrains platform to "web", but guard anyway in case this is
  // called with a hand-built object.
  if (profile.platform !== "web") {
    throw new Error(
      `resolveWebTarget: platform "${profile.platform}" is not supported (native runtimes are rejected)`,
    );
  }

  switch (profile.id) {
    case "neutral-web":
      assertNeutralWeb(profile);
      break;
    case "astro-react":
      assertAstroReact(profile);
      break;
    case "astro-vue":
      assertAstroVue(profile);
      break;
    // No default: PROFILE_BY_ID check above covers unknown ids.
  }

  return { profile, definition };
}

// ---------------------------------------------------------------------------
// Rule helpers
// ---------------------------------------------------------------------------

function assertNeutralWeb(profile: WebTargetProfile): void {
  if (profile.siteFramework !== "none") {
    throw new Error(
      `resolveWebTarget: neutral-web requires siteFramework "none" (got "${profile.siteFramework}")`,
    );
  }
  if (profile.runtime !== "none") {
    throw new Error(
      `resolveWebTarget: neutral-web requires runtime "none" (got "${profile.runtime}") — native/JS runtimes are rejected`,
    );
  }
  if (profile.islandStrategy !== null) {
    throw new Error(
      `resolveWebTarget: neutral-web cannot select an island strategy (got "${profile.islandStrategy}")`,
    );
  }
  if (REACT_ONLY_SOURCES.has(profile.componentSource)) {
    throw new Error(
      `resolveWebTarget: neutral-web cannot use React-only componentSource "${profile.componentSource}"`,
    );
  }
  if (JS_MOTION_RUNTIMES.has(profile.motion) || profile.motion === "vue-transition") {
    throw new Error(
      `resolveWebTarget: neutral-web cannot select motion runtime "${profile.motion}" (only css, view-transitions, css-view-transitions allowed)`,
    );
  }
  if (!NEUTRAL_ALLOWED_MOTION.has(profile.motion)) {
    throw new Error(
      `resolveWebTarget: neutral-web motion "${profile.motion}" is not in the allowed set`,
    );
  }
}

function assertAstroReact(profile: WebTargetProfile): void {
  if (profile.siteFramework !== "astro") {
    throw new Error(
      `resolveWebTarget: astro-react requires siteFramework "astro" (got "${profile.siteFramework}")`,
    );
  }
  if (profile.runtime !== "react") {
    throw new Error(
      `resolveWebTarget: astro-react requires runtime "react" (got "${profile.runtime}")`,
    );
  }
  assertAstroIsland(profile);
  // React targets may use any componentSource enum value; React-only sources
  // are permitted here. No additional source restriction.
}

function assertAstroVue(profile: WebTargetProfile): void {
  if (profile.siteFramework !== "astro") {
    throw new Error(
      `resolveWebTarget: astro-vue requires siteFramework "astro" (got "${profile.siteFramework}")`,
    );
  }
  if (profile.runtime !== "vue") {
    throw new Error(
      `resolveWebTarget: astro-vue requires runtime "vue" (got "${profile.runtime}")`,
    );
  }
  assertAstroIsland(profile);
  // Vue targets CANNOT use React-only sources.
  if (REACT_ONLY_SOURCES.has(profile.componentSource)) {
    throw new Error(
      `resolveWebTarget: astro-vue cannot use React-only componentSource "${profile.componentSource}" — use native-html or custom`,
    );
  }
  // Vue motion: allow CSS-family + vue-transition; reject JS runtimes.
  if (JS_MOTION_RUNTIMES.has(profile.motion)) {
    throw new Error(
      `resolveWebTarget: astro-vue cannot select JS motion runtime "${profile.motion}"`,
    );
  }
  if (!VUE_ALLOWED_MOTION.has(profile.motion)) {
    throw new Error(
      `resolveWebTarget: astro-vue motion "${profile.motion}" is not in the allowed set (css, css-view-transitions, vue-transition)`,
    );
  }
}

function assertAstroIsland(profile: WebTargetProfile): void {
  if (profile.islandStrategy === null || profile.islandStrategy.trim() === "") {
    throw new Error(
      `resolveWebTarget: ${profile.id} requires a non-none island strategy when runtime is "${profile.runtime}"`,
    );
  }
}

// ===========================================================================
// 4. Dependency pins + buildDependencyManifest
// ===========================================================================

/**
 * Exact version pins for installable packages. Never "latest". These are
 * concrete published versions; a future refresh task may bump them in lockstep.
 */
const EXACT_VERSIONS = {
  astro: "5.7.10",
  react: "19.2.0",
  "react-dom": "19.2.0",
  vue: "3.5.13",
  "@astrojs/react": "4.2.1",
  "@astrojs/vue": "5.0.0",
  tailwindcss: "4.0.0",
  motion: "12.4.7",
  gsap: "3.12.5",
} as const;

/**
 * Documentation URLs paired with packages that have a canonical docs page.
 */
const DOCS_URLS: Record<string, string> = {
  astro: "https://docs.astro.build/",
  react: "https://react.dev/",
  "react-dom": "https://react.dev/",
  vue: "https://vuejs.org/",
  "@astrojs/react": "https://docs.astro.build/pl/guides/framework-components/",
  "@astrojs/vue": "https://docs.astro.build/pl/guides/framework-components/",
  tailwindcss: "https://tailwindcss.com/docs/installation/",
  motion: "https://motion.dev/docs",
  gsap: "https://gsap.com/docs/",
};

interface PackagePin {
  readonly packageName: string;
  readonly version: string;
  readonly purpose: string;
  readonly required: boolean;
}

function depFromPin(pin: PackagePin): DependencyRef {
  return {
    packageName: pin.packageName,
    version: pin.version,
    // Rule: package dependencies always use exact versions.
    versionPolicy: "exact",
    required: pin.required,
    purpose: pin.purpose,
    docsUrl: DOCS_URLS[pin.packageName] ?? null,
  };
}

/**
 * Return the install dependencies for a profile. Package dependencies use
 * `versionPolicy: "exact"` and concrete published versions — never "latest".
 * Neutral-web omits Astro, React, and Vue entirely.
 */
export function buildDependencyManifest(profile: WebTargetProfile): DependencyRef[] {
  const pins: PackagePin[] = [];

  if (profile.siteFramework === "astro") {
    pins.push({
      packageName: "astro",
      version: EXACT_VERSIONS.astro,
      purpose: "Astro site framework (host)",
      required: true,
    });
  }

  if (profile.runtime === "react") {
    pins.push({
      packageName: "react",
      version: EXACT_VERSIONS.react,
      purpose: "React UI runtime",
      required: true,
    });
    pins.push({
      packageName: "react-dom",
      version: EXACT_VERSIONS["react-dom"],
      purpose: "React DOM renderer",
      required: true,
    });
    if (profile.siteFramework === "astro") {
      pins.push({
        packageName: "@astrojs/react",
        version: EXACT_VERSIONS["@astrojs/react"],
        purpose: "Astro React integration",
        required: true,
      });
    }
  }

  if (profile.runtime === "vue") {
    pins.push({
      packageName: "vue",
      version: EXACT_VERSIONS.vue,
      purpose: "Vue UI runtime",
      required: true,
    });
    if (profile.siteFramework === "astro") {
      pins.push({
        packageName: "@astrojs/vue",
        version: EXACT_VERSIONS["@astrojs/vue"],
        purpose: "Astro Vue integration",
        required: true,
      });
    }
  }

  if (profile.styling === "tailwind") {
    pins.push({
      packageName: "tailwindcss",
      version: EXACT_VERSIONS.tailwindcss,
      purpose: "Tailwind CSS utility framework",
      required: true,
    });
  }

  if (profile.motion === "motion") {
    pins.push({
      packageName: "motion",
      version: EXACT_VERSIONS.motion,
      purpose: "Motion animation runtime (formerly Framer Motion)",
      required: true,
    });
  }

  if (profile.motion === "gsap") {
    pins.push({
      packageName: "gsap",
      version: EXACT_VERSIONS.gsap,
      purpose: "GSAP animation runtime",
      required: true,
    });
  }

  // Deterministic order: alphabetical by packageName. Neutral-web with
  // vanilla-css + native-html + css motion produces an empty manifest, which
  // correctly reflects "no install dependencies".
  pins.sort((a, b) => (a.packageName < b.packageName ? -1 : a.packageName > b.packageName ? 1 : 0));
  return pins.map(depFromPin);
}
