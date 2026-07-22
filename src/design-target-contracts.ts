/**
 * design-target-contracts.ts — the versioned web design handoff contract.
 *
 * Task 1 of the web design adapters plan. This module defines the fail-closed
 * boundary between untrusted producer input (`DesignHandoffInput`) and the
 * trusted output (`DesignHandoffT`). Zod schemas validate every field with
 * `.strict()` discipline; `parseDesignHandoff` is the ONLY constructor for
 * `DesignHandoffT` — no type assertion may bypass it.
 *
 * The UiSpec 1.0 schema (in tool-contracts.ts) is the semantic source of truth
 * and remains untouched. This envelope wraps a validated UiSpec together with a
 * web target profile, structured motion intents, and a generatedAt timestamp.
 */
import { z } from "zod";
import { UiSpec, type UiSpecT } from "./tool-contracts.js";
import { resolveWebTarget } from "./design-adapter-registry.js";

// ===========================================================================
// 1. Closed enum values
// ===========================================================================

/**
 * The only supported web target IDs in this slice. Unknown IDs fail closed.
 * `neutral-web` is the fallback when no target is supplied.
 */
export const WebTargetId = z.enum(["neutral-web", "astro-react", "astro-vue"]);
export type WebTargetIdT = z.infer<typeof WebTargetId>;

/** Host/site framework. Astro is the only supported host; `none` for neutral web. */
export const WebSiteFramework = z.enum(["none", "astro"]);
export type WebSiteFrameworkT = z.infer<typeof WebSiteFramework>;

/** UI runtime, modeled separately from the site framework. React and Vue are the only runtimes. */
export const WebRuntime = z.enum(["none", "react", "vue"]);
export type WebRuntimeT = z.infer<typeof WebRuntime>;

/** Styling strategy for the produced handoff. */
export const WebStyling = z.enum(["vanilla-css", "tailwind", "css-modules"]);
export type WebStylingT = z.infer<typeof WebStyling>;

/** Component source for the produced handoff. */
export const WebComponentSource = z.enum([
  "native-html",
  "custom",
  "shadcn",
  "kumo",
  "base-ui",
  "radix",
  "react-aria",
  "mui",
]);
export type WebComponentSourceT = z.infer<typeof WebComponentSource>;

/** Motion adapter for the produced handoff. */
export const WebMotion = z.enum([
  "css",
  "view-transitions",
  "css-view-transitions",
  "vue-transition",
  "motion",
  "gsap",
]);
export type WebMotionT = z.infer<typeof WebMotion>;

/** Version policy. Package dependencies use `exact`; target profiles may use `range`; browser APIs use `unversioned`. */
export const VersionPolicy = z.enum(["exact", "range", "unversioned"]);
export type VersionPolicyT = z.infer<typeof VersionPolicy>;

// ===========================================================================
// 2. WebTargetProfile
// ===========================================================================

/**
 * A closed description of the web handoff target. `islandStrategy` is null for
 * neutral-web (no host framework) and a non-null directive string for Astro
 * targets. Capability compatibility (e.g. React-only sources under neutral-web)
 * is enforced by the registry in Task 2; this schema only validates the shape.
 */
export const WebTargetProfileSchema = z.object({
  id: WebTargetId,
  platform: z.literal("web"),
  siteFramework: WebSiteFramework,
  runtime: WebRuntime,
  styling: WebStyling,
  componentSource: WebComponentSource,
  motion: WebMotion,
  islandStrategy: z.string().nullable(),
}).strict();
export type WebTargetProfile = z.infer<typeof WebTargetProfileSchema>;

// ===========================================================================
// 3. VersionedRef — references to tools, runtimes, browsers, etc.
// ===========================================================================

/**
 * A reference to a versioned thing (Astro, React, Tailwind, a browser API).
 * The `version` string is required and non-empty; its interpretation depends on
 * `versionPolicy`. Exact pins are for installable packages; ranges describe
 * target compatibility; `unversioned` marks browser/platform APIs.
 */
export const VersionedRefSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  versionPolicy: VersionPolicy,
}).strict();
export type VersionedRef = z.infer<typeof VersionedRefSchema>;

// ===========================================================================
// 4. DependencyRef — installable package reference
// ===========================================================================

/**
 * A concrete installable package. Package dependencies MUST use exact
 * versions — the schema enforces this at the contract level, not just
 * at the registry level. Target profile references (VersionedRef) may
 * use range or unversioned policies.
 */
export const DependencyRefSchema = z.object({
  packageName: z.string().min(1),
  version: z.string().min(1),
  versionPolicy: z.literal("exact"),
  required: z.boolean(),
  purpose: z.string().min(1),
  docsUrl: z.string().nullable(),
}).strict();
export type DependencyRef = z.infer<typeof DependencyRefSchema>;

// ===========================================================================
// 5. SourceRef — provenance for documentation / source snapshots
// ===========================================================================

/**
 * Provenance for a referenced source. A source is either `captured` (bytes
 * vendored with a 64-char lowercase SHA-256) or `not-captured` (with a reason).
 * No hash may be fabricated: the schema forbids a hash unless status is
 * `captured`, and forbids a missing hash when captured.
 */
export const SnapshotStatus = z.enum(["captured", "not-captured"]);
export type SnapshotStatusT = z.infer<typeof SnapshotStatus>;

const LOWER_HEX_64 = /^[0-9a-f]{64}$/;

export const SourceRefSchema = z.object({
  sourceId: z.string().min(1),
  kind: z.string().min(1),
  url: z.string().min(1),
  snapshotStatus: SnapshotStatus,
  snapshotSha256: z.string().regex(LOWER_HEX_64).nullable(),
  snapshotReason: z.string().nullable(),
  licenseStatus: z.string().min(1),
  attribution: z.string().min(1),
}).strict().superRefine((val, ctx) => {
  if (val.snapshotStatus === "captured") {
    if (val.snapshotSha256 === null) {
      ctx.addIssue({
        code: "custom",
        message: "captured source requires a 64-char lowercase hex snapshotSha256",
        path: ["snapshotSha256"],
      });
    }
    if (val.snapshotReason !== null) {
      ctx.addIssue({
        code: "custom",
        message: "captured source must not carry a snapshotReason",
        path: ["snapshotReason"],
      });
    }
  } else {
    // not-captured
    if (val.snapshotReason === null || val.snapshotReason.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "not-captured source requires a non-empty snapshotReason",
        path: ["snapshotReason"],
      });
    }
    if (val.snapshotSha256 !== null) {
      ctx.addIssue({
        code: "custom",
        message: "not-captured source must not carry a snapshotSha256",
        path: ["snapshotSha256"],
      });
    }
  }
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

// ===========================================================================
// 6. MotionIntent — explicit, structured motion input
// ===========================================================================

/**
 * A single structured motion intent. Explicit input only — never parsed from
 * free-form UiSpec motion notes. `reducedMotion` is REQUIRED (non-empty) and
 * describes the prefers-reduced-motion fallback behavior.
 */
export const MotionIntentSchema = z.object({
  id: z.string().min(1),
  trigger: z.string().min(1),
  properties: z.array(z.string()),
  durationToken: z.string().min(1),
  easingToken: z.string().min(1),
  interruptible: z.boolean(),
  reducedMotion: z.string().min(1),
}).strict();
export type MotionIntent = z.infer<typeof MotionIntentSchema>;

// ===========================================================================
// 7. DesignHandoffInput — untrusted producer-facing shape
// ===========================================================================

/**
 * Untrusted input from a producer (e.g. a future create_ui_spec tool). Each
 * field is validated independently against its schema; no field trusts another.
 * `generatedAt` must be an ISO-8601 datetime string.
 *
 * `target` is optional: when omitted, the parser substitutes the canonical
 * neutral-web profile. This implements the documented "no target means
 * neutral-web, never implicit React" contract.
 */
export const NEUTRAL_WEB_TARGET = {
  id: "neutral-web" as const,
  platform: "web" as const,
  siteFramework: "none" as const,
  runtime: "none" as const,
  styling: "vanilla-css" as const,
  componentSource: "native-html" as const,
  motion: "css" as const,
  islandStrategy: null,
};

export const DesignHandoffInputSchema = z.object({
  spec: z.unknown(),
  target: z.unknown().optional(),
  motionIntents: z.unknown(),
  generatedAt: z.string().datetime(),
}).strict();
export type DesignHandoffInput = z.infer<typeof DesignHandoffInputSchema>;

// ===========================================================================
// 8. DesignHandoffT — trusted output (opaque, parser-constructed)
// ===========================================================================

/**
 * The trusted handoff envelope. Constructed ONLY by `parseDesignHandoff`.
 * The `readonly` fields and the unique symbol brand prevent ad-hoc object
 * literals from satisfying this type — the brand is an opaque, non-exported
 * key that only this module can write.
 */
const DesignHandoffBrand: unique symbol = Symbol("DesignHandoffBrand");
export type DesignHandoffBrand = typeof DesignHandoffBrand;

export interface DesignHandoffT {
  readonly [DesignHandoffBrand]: true;
  /** Schema-validated UiSpec 1.0 instance. */
  readonly spec: UiSpecT;
  /** Schema-validated web target profile. */
  readonly target: WebTargetProfile;
  /** Schema-validated structured motion intents. */
  readonly motionIntents: MotionIntent[];
  /** ISO-8601 UTC datetime, validated by the input schema. */
  readonly generatedAt: string;
}

// ===========================================================================
// 9. parseDesignHandoff — the only constructor for DesignHandoffT
// ===========================================================================

/**
 * Validate untrusted input and return a trusted `DesignHandoffT`. Throws on any
 * parse failure (invalid UiSpec, invalid target, invalid motion intent, or
 * malformed generatedAt). Also applies boundary checks: private-path rejection
 * and structural-Markdown rejection run at the parser level so every trusted
 * DesignHandoffT is guaranteed clean, regardless of which entry point
 * constructed it.
 */
export function parseDesignHandoff(input: DesignHandoffInput): DesignHandoffT {
  // Validate the envelope shape first (also enforces generatedAt datetime).
  const inputParse = DesignHandoffInputSchema.safeParse(input);
  if (!inputParse.success) {
    throw new Error(`Invalid DesignHandoffInput: ${inputParse.error.message}`);
  }
  const validInput = inputParse.data;

  const specParse = UiSpec.safeParse(validInput.spec);
  if (!specParse.success) {
    throw new Error(`Invalid UiSpec: ${specParse.error.message}`);
  }

  // Target fallback: when omitted, substitute the canonical neutral-web profile.
  // This implements "no target means neutral-web, never implicit React."
  const targetInput = validInput.target === undefined ? NEUTRAL_WEB_TARGET : validInput.target;
  const targetParse = WebTargetProfileSchema.safeParse(targetInput);
  if (!targetParse.success) {
    throw new Error(`Invalid WebTargetProfile: ${targetParse.error.message}`);
  }

  const motionIntentsParse = z.array(MotionIntentSchema).safeParse(validInput.motionIntents);
  if (!motionIntentsParse.success) {
    throw new Error(`Invalid MotionIntents: ${motionIntentsParse.error.message}`);
  }

  // Boundary checks: scan the entire envelope recursively for private paths
  // and structural Markdown. These run at the parser level so every
  // DesignHandoffT — regardless of which entry point constructed it — is
  // guaranteed clean.
  assertNoPrivatePathsEnvelope(specParse.data, targetParse.data, motionIntentsParse.data);
  assertNoStructuralMarkdownEnvelope(specParse.data, targetParse.data, motionIntentsParse.data);

  // Registry resolution: validate that the target's combination is legal
  // (e.g. astro-vue cannot use React-only sources). This runs at the parser
  // level so a trusted DesignHandoffT is always registry-valid.
  resolveWebTarget(targetParse.data);

  // The ONLY constructor for DesignHandoffT. Cast is contained to this single
  // line; the brand makes the type unconstructable elsewhere.
  return {
    [DesignHandoffBrand]: true,
    spec: specParse.data,
    target: targetParse.data,
    motionIntents: motionIntentsParse.data,
    generatedAt: validInput.generatedAt,
  } as DesignHandoffT;
}

// ---------------------------------------------------------------------------
// Boundary checks — live here (in the contracts module) so parseDesignHandoff
// applies them. buildDesignHandoff also applies them as defense-in-depth.
// ---------------------------------------------------------------------------

const PRIVATE_PATH_PATTERNS = [
  /\.c2-private\//,
  /\/corpus\/private\//,
  /corpus\/images-private\//,
] as const;

/** Recursively collect ALL string values from an arbitrary object. */
function collectAllStrings(value: unknown, path: string = ""): Array<string> {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((v, i) => collectAllStrings(v, `${path}[${i}]`));
  if (value !== null && typeof value === "object") {
    return Object.keys(value).flatMap((k) => collectAllStrings((value as Record<string, unknown>)[k], path ? `${path}.${k}` : k));
  }
  return [];
}

/** Reject any string in the handoff envelope containing a private corpus path. */
function assertNoPrivatePathsEnvelope(spec: unknown, target: unknown, motionIntents: unknown): void {
  const all = [...collectAllStrings(spec), ...collectAllStrings(target), ...collectAllStrings(motionIntents)];
  for (const s of all) {
    for (const pattern of PRIVATE_PATH_PATTERNS) {
      if (pattern.test(s)) {
        throw new Error(
          `[design-handoff] private path detected in handoff input: ` +
          `pattern ${String(pattern)} matched. Private corpus paths must not ` +
          `appear in design handoff output.`,
        );
      }
    }
  }
}

/** Reject structural Markdown (headings/fences with up to 3 leading spaces). */
function assertNoStructuralMarkdownEnvelope(spec: unknown, target: unknown, motionIntents: unknown): void {
  const all = [...collectAllStrings(spec), ...collectAllStrings(target), ...collectAllStrings(motionIntents)];
  const headingRe = /^ {0,3}#{1,6}\s/m;
  const fenceRe = /^ {0,3}(`{3,}|~{3,})/m;
  for (const s of all) {
    if (headingRe.test(s) || fenceRe.test(s)) {
      throw new Error(
        `[design-handoff] structural Markdown detected in handoff input: ` +
        `the value contains a heading or fenced code block that would break ` +
        `the deterministic section contract.`,
      );
    }
  }
}
