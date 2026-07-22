/**
 * design-motion-adapters.ts — semantic motion mappings for web handoffs.
 *
 * Task 4 of the web design adapters plan. Motion intents are EXPLICIT structured
 * input (`MotionIntent[]`); this module NEVER parses free-form UiSpec motion
 * notes. `validateMotionIntents` enforces the schema (fail-closed). The
 * renderer emits implementation-specific guidance that varies by target
 * profile, and `motionSourceRefs` returns documentation SourceRefs ONLY — these
 * are URLs, not install dependencies, and must never appear in the dependency
 * manifest.
 *
 * Profiles handled:
 *  - astro-vue:           Vue <Transition> for enter/exit, <TransitionGroup> for lists.
 *  - neutral-web (css only):           CSS transitions + data-state selectors.
 *  - neutral-web (view-transitions | css-view-transitions): CSS for local state,
 *    View Transitions API for route/layout changes.
 *  - All profiles: prefers-reduced-motion fallback guidance.
 */
import { z } from "zod";
import {
  MotionIntentSchema,
  type MotionIntent,
  type SourceRef,
  type WebTargetProfile,
} from "./design-target-contracts.js";
import { DESIGN_SOURCE_REGISTRY } from "./design-source-registry.js";

// ===========================================================================
// 1. validateMotionIntents — explicit structured input only
// ===========================================================================

/**
 * Validate untrusted motion intent input. Returns the validated intents, or
 * throws on any schema violation (missing/empty `reducedMotion`, unknown
 * fields under strict parsing, non-array input, etc.).
 *
 * This is the fail-closed boundary: free-form UiSpec motion notes are NEVER
 * accepted here — only already-structured `MotionIntent` objects.
 */
export function validateMotionIntents(intents: unknown): MotionIntent[] {
  const parse = z.array(MotionIntentSchema).safeParse(intents);
  if (!parse.success) {
    throw new Error(`validateMotionIntents: invalid motion intents — ${parse.error.message}`);
  }
  // Return a defensive copy so callers cannot mutate the validated array in
  // place and so the output is referentially stable per call.
  return parse.data.map((intent) => ({ ...intent }));
}

// ===========================================================================
// 2. renderWebMotionGuidance — implementation-specific markdown section
// ===========================================================================

/**
 * Render a markdown section describing how to implement the supplied motion
 * intents for the given target profile. The guidance is implementation-specific
 * (Vue vs CSS vs View Transitions) and always includes a prefers-reduced-motion
 * fallback. Output is deterministic and byte-identical on repeated calls.
 *
 * The intents are referenced by id so the renderer ties semantic intent to
 * concrete implementation primitives.
 */
export function renderWebMotionGuidance(
  profile: WebTargetProfile,
  intents: MotionIntent[],
): string {
  const lines: string[] = [];
  lines.push("## Motion guidance");

  // Intent inventory — referenced by id so the reader can map each intent to
  // the implementation primitives below.
  if (intents.length > 0) {
    lines.push("");
    lines.push("Motion intents:");
    for (const intent of intents) {
      lines.push(
        `- \`${intent.id}\` (trigger: ${intent.trigger}; properties: ${intent.properties.join(", ") || "none"}; duration: \`${intent.durationToken}\`; easing: \`${intent.easingToken}\`; interruptible: ${intent.interruptible ? "yes" : "no"})`,
      );
    }
  }

  // Profile-specific implementation primitives.
  lines.push("");
  lines.push("Implementation:");
  lines.push("");

  switch (profile.motion) {
    case "vue-transition":
      appendVueTransitionGuidance(lines);
      break;
    case "view-transitions":
    case "css-view-transitions":
      appendViewTransitionsGuidance(lines);
      break;
    case "css":
      appendCssOnlyGuidance(lines);
      break;
    case "motion":
      appendMotionRuntimeGuidance(lines);
      break;
    case "gsap":
      appendGsapGuidance(lines);
      break;
  }

  // Reduced-motion fallback — required for EVERY profile.
  lines.push("");
  lines.push("Reduced-motion fallback:");
  lines.push(
    "- Honor `@media (prefers-reduced-motion: reduce)`: skip transforms, opacity ramps, and " +
      "route/layout crossfades; render the element in its final state immediately.",
  );
  lines.push(
    "- Each intent declares its own `reducedMotion` behavior; apply that behavior verbatim rather " +
      "than inventing a fallback at the call site.",
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Per-profile implementation guidance
// ---------------------------------------------------------------------------

function appendVueTransitionGuidance(lines: string[]): void {
  lines.push(
    "- Use the built-in `<Transition>` component for enter/exit animations on a single element " +
      "or component (mount/unmount, toggle visibility).",
  );
  lines.push(
    "- Use the built-in `<TransitionGroup>` component for list changes (items added, removed, or " +
      "reordered) — it keeps moved elements in the DOM during the transition.",
  );
  lines.push(
    "- Bind duration/easing tokens (`durationToken`, `easingToken`) to CSS custom properties and " +
      "reference them from the `v-enter-active` / `v-leave-active` class names.",
  );
  lines.push(
    "- Do not introduce a JavaScript motion runtime for vue-transition; the built-ins cover the " +
      "intent set.",
  );
}

function appendViewTransitionsGuidance(lines: string[]): void {
  lines.push(
    "- Use plain CSS transitions for LOCAL state changes (toggle, hover, focus, expand/collapse " +
      "within the same route).",
  );
  lines.push(
    "- Use the View Transitions API (`document.startViewTransition`) for ROUTE/LAYOUT changes — " +
      "full-page navigations, layout swaps, or element morphs across containers.",
  );
  lines.push(
    "- For `css-view-transitions`, scope CSS `@view-transition` rules and `::view-transition-*` " +
      "pseudo-elements to the animated containers; do not apply a global route transition to " +
      "intra-page state changes.",
  );
  lines.push(
    "- Bind duration/easing tokens to CSS custom properties and reference them from both the local " +
      "transition declarations and the `::view-transition-*` keyframes.",
  );
}

function appendCssOnlyGuidance(lines: string[]): void {
  lines.push(
    "- Use CSS transitions for local state changes; do not introduce a JavaScript motion runtime.",
  );
  lines.push(
    "- Drive state with `data-state` attribute selectors (e.g. `[data-state=\"open\"]`) so the " +
      "transition is declarative and testable from markup alone.",
  );
  lines.push(
    "- Bind duration/easing tokens to CSS custom properties and reference them from the transition " +
      "shorthand on the animated elements.",
  );
}

function appendMotionRuntimeGuidance(lines: string[]): void {
  lines.push(
    "- Use the `motion` package (formerly Framer Motion) for animation; bind `durationToken` and " +
      "`easingToken` to the transition config of each animated component.",
  );
}

function appendGsapGuidance(lines: string[]): void {
  lines.push(
    "- Use GSAP timelines for animation; bind `durationToken` and `easingToken` to each tween.",
  );
}

// ===========================================================================
// 3. motionSourceRefs — documentation URLs ONLY, never install dependencies
// ===========================================================================

/** Source IDs in stable registry order; motionSourceRefs selects from this set. */
const MOTION_SOURCE_IDS: readonly string[] = ["vue-official", "transitions-dev"];

/**
 * Return the documentation SourceRefs relevant to the profile's motion approach.
 * These are URLs (provenance pointers to public docs), NOT install dependencies.
 * The returned refs are a subset of the checked-in `DESIGN_SOURCE_REGISTRY` —
 * this function never synthesizes a new source, URL, or hash.
 *
 * Mapping:
 *  - vue-transition -> vue-official (Vue <Transition> docs)
 *  - motion         -> transitions-dev (motion community catalog)
 *  - everything else -> [] (CSS / View Transitions are browser-native; no
 *    checked-in motion source in this slice).
 *
 * Returned SourceRefs MUST NOT appear in `buildDependencyManifest`. That
 * invariant is enforced by test; this function intentionally only ever returns
 * documentation/community-catalog URLs that are not package specifiers.
 */
export function motionSourceRefs(profile: WebTargetProfile): SourceRef[] {
  const wanted = new Set<string>();
  switch (profile.motion) {
    case "vue-transition":
      wanted.add("vue-official");
      break;
    case "motion":
      wanted.add("transitions-dev");
      break;
    default:
      // css, view-transitions, css-view-transitions, gsap: no checked-in motion
      // source in this slice. Returns an empty array — never a fabricated source.
      break;
  }

  const result: SourceRef[] = [];
  // Iterate the registry in its stable order for deterministic output; only the
  // MOTION_SOURCE_IDS can ever be selected, which keeps the output universe closed.
  for (const entry of DESIGN_SOURCE_REGISTRY) {
    if (MOTION_SOURCE_IDS.includes(entry.sourceId) && wanted.has(entry.sourceId)) {
      // Defensive copy so downstream code cannot mutate the checked-in registry.
      result.push({ ...entry });
    }
  }
  return result;
}
