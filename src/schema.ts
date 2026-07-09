import { z } from "zod";
import { getWcagTitle, isWcagCriterion } from "./wcag/registry.js";

/**
 * CORPUS SCHEMA
 * =============
 * One entry = one exceptional UI example.
 *
 * Design principles for this schema (read before adding fields):
 *
 * 1. Images are NOT the source of truth for redistribution-safety.
 *    `image.visibility` controls whether the raster is shippable in the
 *    open-source corpus at all. Default to "private" (local-only, your
 *    own research copy) unless you captured it yourself from a project
 *    you have rights to, or it's a low-res thumbnail you're comfortable
 *    defending as fair use. See /docs/SOURCING.md.
 *
 * 2. The written `critique` field is the actual IP you're creating.
 *    Tags and hex codes are cheap to scrape; a specific, accurate
 *    explanation of *why* something works is not. Treat this as the
 *    most important field in the record, not metadata-on-the-side.
 *
 * 3. Keep tags as small closed-ish vocabularies (see TAG_VOCAB below)
 *    rather than free text, so search/filter stays useful at 200 or
 *    20,000 entries. Add new tags deliberately, not per-entry.
 */

export const Category = z.enum([
  "dashboard",
  "landing-page",
  "pricing",
  "onboarding",
  "auth",
  "settings",
  "empty-state",
  "navigation",
  "data-table",
  "forms",
  "mobile-nav",
  "notifications",
  "search",
  "checkout",
  "profile",
  "marketing-hero",
  "editor-canvas",
  "chat-interface",
]);

export const StyleTag = z.enum([
  "minimal",
  "dense-data",
  "editorial",
  "brutalist",
  "playful",
  "monochrome",
  "high-contrast",
  "soft-neumorphic",
  "glassmorphic",
  "retro",
  "technical-mono",
  "warm-tactile",
  "luxury-quiet",
  "bold-color",
]);

/**
 * Visible component taxonomy — concrete UI building blocks observed in the
 * screenshot. This is deliberately separate from `categories`: categories say
 * what product/design pattern the entry belongs to; components say what is
 * physically present on screen (charts, cards, nav, report rows, controls).
 */
export const Component = z.enum([
  "sidebar-nav",
  "top-nav",
  "tab-nav",
  "bottom-nav",
  "action-list",
  "search-command",
  "command-palette",
  "kpi-card",
  "metric-grid",
  "summary-card",
  "stat-card",
  "data-table",
  "chart",
  "line-chart",
  "bar-chart",
  "area-chart",
  "donut-chart",
  "pie-chart",
  "gauge-chart",
  "report-list",
  "card-list",
  "feed-list",
  "media-grid",
  "filter-controls",
  "form-controls",
  "segmented-control",
  "status-chip",
  "icon-button",
  "notification-bell",
  "modal-dialog",
  "empty-state",
  "pricing-card",
  "timeline",
  "kanban-board",
  "map-view",
]);

/**
 * Domain tags — the BUSINESS/PRODUCT context of the page (billing, security,
 * team management), distinct from `categories` (design pattern: dashboard,
 * settings) and `components` (physical UI parts: sidebar-nav, data-table).
 * A billing page is correctly tagged categories:["settings","dashboard"] —
 * but that gives no way to answer "show me billing screens."
 */
export const DomainTag = z.enum([
  "billing",
  "usage",
  "team-management",
  "security",
  "integrations",
  "analytics",
  "notifications-settings",
  "audit-log",
  "api-keys",
  "permissions-roles",
  "profile-account",
  "data-export",
  "support-help",
  "legal-compliance",
  "workspace-settings",
]);

export const SpacingDensity = z.enum(["compact", "moderate", "spacious"]);
export const CornerStyle = z.enum(["sharp", "slight-round", "pill", "mixed"]);

/**
 * Primary pattern classification — ONE per entry, distinguishing full-page
 * patterns from component patterns. Complements `categories` (which stays a
 * 1-4 multi-tag classifier). `patternType` is what makes "find me 10 great
 * empty states" queryable as a primary axis, not just a tag.
 *
 * Intentional overlap with `Category`: an entry can be tagged
 * categories: ["dashboard","data-table"] while patternType: "data-table".
 */
export const PatternType = z.enum([
  // full-page patterns
  "dashboard",
  "landing-page",
  "pricing",
  "onboarding",
  "auth",
  "settings",
  "search",
  "checkout",
  "profile",
  "marketing-hero",
  "calculator", // numeric inputs -> live-computed outputs: transfer fees, ROI, pricing estimators, mortgage/loan
  // component patterns
  "data-table",
  "empty-state",
  "navigation",
  "forms",
  "mobile-nav",
  "notifications",
  "editor-canvas",
  "chat-interface",
  "command-palette",
  "modal",
]);

/**
 * Platform — the device class the screenshot was captured on. Orthogonal to
 * patternType: a mobile app can have a dashboard, settings, onboarding, auth
 * screen — none of which are "mobile-nav" (that's a component, not a platform).
 * Lets the corpus answer "show me mobile onboarding flows" vs "show me web
 * onboarding flows." Optional + auto-detected from the screenshot aspect ratio
 * at tag time, so existing entries backfill instantly from their dimensions.
 */
export const Platform = z.enum(["web", "mobile", "tablet"]);

/** Detect platform from image dimensions. Shared rule — tagger, backfill, UI. */
export function detectPlatform(width: number | null | undefined, height: number | null | undefined): "web" | "mobile" | "tablet" {
  if (!width || !height) return "web"; // unknown — default to web (most corpus)
  if (height > width * 1.2) return "mobile";   // portrait → phone
  if (width > height * 1.2) return "web";      // landscape → desktop
  return "tablet";                               // roughly square → tablet
}

/**
 * Pattern discovery metadata — an open-vocabulary side lane used to decide
 * which recurring hidden patterns deserve promotion into the closed PatternType
 * enum. This is intentionally not used for filtering/search; it is curator
 * evidence for taxonomy evolution.
 *
 * Only the suggestion is persisted — the "current" patternType is already on
 * the entry and deriving it here would denormalize (drift if patternType is
 * later edited via PUT while this field stays stale).
 */
export const PatternDiscovery = z.object({
  suggestedPatternType: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
});

/**
 * Accessibility risk — a single a11y concern found on screen. A structured
 * object with a required `evidence` field — the gate that prevents fabricated
 * risks. Evidence must cite visible text, name an exact screen region, or quote
 * a DOM metric. Palette values, generic component guesses, and absent-state
 * speculation are not valid evidence.
 *
 * `wcag` is a REQUIRED array of one or more canonical WCAG 2.2 success-criterion
 * IDs (e.g. ["1.4.3"]). Only IDs that exist in the vendored WCAG 2.2 registry
 * are accepted — this is referential integrity, not proof that a screenshot
 * violates the criterion (the evidence gate remains the authority on that).
 * Titles are never persisted here; they are looked up from the registry at
 * display time via formatAccessibilityRisk.
 *
 * `confidence: "dom-grounded"` is code-owned (reserved for future DOM-signals
 * injection); models may only emit "visible" or "inferred".
 *
 * Historical uncited notes (legacy free-text strings from older prompts) are
 * NOT valid here — they live in `antiPatterns.legacyAccessibilityNotes`, where
 * they're retained for human review but excluded from MCP retrieval and
 * semantic embeddings.
 */
export const AccessibilityRisk = z.object({
  element: z.string().min(3),
  risk: z.string().min(10),
  evidence: z.string().min(8),
  confidence: z.enum(["visible", "inferred", "dom-grounded"]),
  wcag: z.array(z.string().refine(isWcagCriterion, "canonical WCAG 2.2 registry ID")).min(1).max(3),
});

export type AccessibilityRiskT = z.infer<typeof AccessibilityRisk>;

/**
 * Collect every free-text string from an accessibility risk (for draft-marker
 * scanning). Returns the element/risk/evidence fields plus each wcag ID joined.
 */
export function accessibilityRiskTextFields(risk: AccessibilityRiskT): string[] {
  return [risk.element, risk.risk, risk.evidence, risk.wcag.join(", ")].filter(Boolean);
}

/**
 * Format an accessibility risk as a single human-readable string. Used by MCP
 * rendering and anywhere that needs the flat display. Set `includeEvidence` to
 * append the evidence on a second line (UI detail views). WCAG IDs are rendered
 * with their registry titles (e.g. "1.4.3 Contrast (Minimum)"), looked up at
 * display time so a registry refresh can fix a title without a corpus edit.
 */
export function formatAccessibilityRisk(
  risk: AccessibilityRiskT,
  opts: { includeEvidence?: boolean } = {},
): string {
  const wcag = risk.wcag.length ? ` (${risk.wcag.map(formatWcagId).join("; ")})` : "";
  const base = `[${risk.confidence}] ${risk.element}: ${risk.risk}${wcag}`;
  return opts.includeEvidence ? `${base}\n  Evidence: ${risk.evidence}` : base;
}

/** Render a single WCAG ID with its registry title for display. */
function formatWcagId(id: string): string {
  const title = getWcagTitle(id);
  return title ? `${id} ${title}` : id;
}

/**
 * Structured anti-patterns — the corpus's biggest differentiator from raw
 * screenshot libraries (Mobbin has 621k screenshots, zero anti-patterns).
 * Replaces the old free-text `whatToAvoidHere` array.
 *
 * `antiPatterns` is required (min 1): what common mistake does this design
 * deliberately avoid? The other two default to [] since not every entry has them.
 */
export const AntiPatterns = z.object({
  antiPatterns: z.array(z.string().min(10)).min(1), // common mistakes this design avoids
  whereThisFails: z.array(z.string().min(10)).default([]), // contexts where copying hurts
  accessibilityRisks: z.array(AccessibilityRisk).default([]), // active a11y risks — each with canonical WCAG 2.2 IDs + evidence
  legacyAccessibilityNotes: z.array(z.string().min(10)).default([]), // retained uncited historical notes — human review backlog, excluded from MCP + embeddings
});

/**
 * Structured layout — a machine-readable wireframe an agent can consume to
 * reproduce the page's STRUCTURE (not its attributes). This is the field the
 * corpus was missing: the Origin dashboards describe their three-column form in
 * prose ("persistent left nav + wide content column + right rail"), but without
 * this field that instruction is buried in critique text.
 *
 * Optional: an entry can be excellent without a documented wireframe (e.g. a
 * pricing page whose value is typographic, not structural). Only populate when
 * the layout itself is the teachable thing.
 */
export const LayoutRegion = z.object({
  role: z.enum([
    "primary-nav",    // persistent left navigation
    "icon-nav",       // narrow icon-only rail
    "summary-strip",  // metric row above the canvas
    "main-canvas",    // the primary content area
    "detail-rail",    // right-hand stacked supporting content
    "form-panel",     // a form column (two-column layouts)
    "visual-panel",   // hero image/visual column (two-column layouts)
    "overlay-card",   // centered modal content on a dimmed bg
  ]),
  width: z.enum(["fixed-narrow", "flex", "fixed-wide"]).optional(),
});

export const LayoutStructure = z.object({
  // High-level page form — the "what kind of layout" axis.
  form: z.enum([
    "single-column",   // centered content, no rails (pricing, empty state)
    "two-column",      // form + visual panel (onboarding)
    "three-column",    // left nav + main canvas + right rail (dashboards)
    "modal-overlay",   // centered card on dimmed bg
  ]),
  // Ordered regions, left→right / top→bottom. The machine-readable wireframe.
  regions: z.array(LayoutRegion).min(1),
});

export const BusinessGoal = z.enum([
  "increase-conversion",
  "reduce-support-load",
  "build-trust",
  "drive-habitual-use",
  "reduce-cognitive-load-at-decision-point",
  "surface-upsell-opportunity",
  "reduce-churn-risk",
  "establish-credibility",
  "other",
]);

/**
 * Business rationale — a deliberately small, pilot-friendly inference field.
 * Optional because isolated component captures often do not contain enough
 * product context to infer intent honestly.
 */
export const BusinessRationale = z.object({
  businessGoal: BusinessGoal,
  targetUser: z.string().max(80),
  rationale: z.string().max(280),
  confirmed: z.boolean().default(false),
});

export const ImageVisibility = z.enum([
  "private", // local-only, never published in the open-source repo
  "public-thumb", // low-res thumbnail, ok to redistribute, links to source
  "public-own", // full image, you captured/created it and hold rights
]);

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");
const CorpusImagePath = z
  .string()
  .regex(/^(images-private|images-public)\/[^/].+$/, "Expected corpus-relative path under images-private/ or images-public/")
  .refine((p) => !p.includes(".."), "Image paths must not contain '..'");

export const ImageRef = z.object({
  visibility: ImageVisibility,
  // Path is always local-relative; private/public split is by directory,
  // see corpus/images-private vs corpus/images-public.
  path: CorpusImagePath.nullable(), // null if no raster stored at all (link-only entry)
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
}).superRefine((image, ctx) => {
  if (image.visibility === "private") {
    if (image.path && !image.path.startsWith("images-private/")) {
      ctx.addIssue({
        code: "custom",
        path: ["path"],
        message: "Private images must live under images-private/",
      });
    }
    return;
  }

  if (!image.path) {
    ctx.addIssue({
      code: "custom",
      path: ["path"],
      message: "Public images must include a redistributable image path",
    });
  } else if (!image.path.startsWith("images-public/")) {
    ctx.addIssue({
      code: "custom",
      path: ["path"],
      message: "Public images must live under images-public/",
    });
  }

  if (!image.width || !image.height) {
    ctx.addIssue({
      code: "custom",
      path: ["width"],
      message: "Public images must include width and height",
    });
  }
});

export const SourceAttribution = z.object({
  productName: z.string(), // e.g. "Linear"
  url: z.string().url().nullable(), // link to the live product/page, not a rehosted copy
  capturedAt: IsoDate, // ISO date, when you captured/noted this
  capturedBy: z.enum(["self", "automated-collection"]),
  lastVerified: IsoDate.optional(), // when you last confirmed the source still matches — staleness tracking
});

export const TypePairing = z.object({
  display: z.string().nullable(), // e.g. "Söhne" — heading/display font if identifiable
  body: z.string().nullable(), // body font if identifiable
  notes: z.string().optional(), // e.g. "tight letter-spacing on all-caps labels"
});

/**
 * Labeled color roles — evolves the bare `dominantColors` hex list into an
 * actionable token set an agent can paste into `:root`. "Here are 6 hex values"
 * isn't usable; "canvas/surface/ink/muted/accent" is. Optional, alongside the
 * legacy dominantColors (kept for backward compat) — populate when the role
 * mapping is confident; cannot be safely auto-inferred from unordered hex lists.
 */
const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const ColorRoles = z.object({
  canvas:  HexColor,                       // app background
  surface: HexColor,                       // cards/panels
  ink:     HexColor,                       // primary text
  muted:   HexColor.nullable(),            // secondary text (nullable — some palettes have no distinct muted)
  accent:  HexColor,                       // single brand/interactive color
});

export const VisualAttributes = z.object({
  dominantColors: z.array(HexColor).min(1).max(6),
  accentColor: HexColor.nullable(),
  colorRoles: ColorRoles.optional(),       // labeled token set (prove-then-expand axis)
  typePairing: TypePairing,
  spacingDensity: SpacingDensity,
  cornerStyle: CornerStyle,
  usesShadows: z.boolean(),
  usesBorders: z.boolean(),
});

export const CorpusEntry = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Expected stable kebab-case slug"), // stable slug, e.g. "linear-issue-board-2026"
  title: z.string(), // human label, e.g. "Linear — Issue board, grouped view"
  patternType: PatternType, // primary pattern (one) — complements the multi-tag categories
  patternDiscovery: PatternDiscovery.optional(), // open-vocab suggestion lane; never replaces canonical patternType
  platform: Platform.optional(), // device class (web/mobile/tablet) — orthogonal to patternType
  colorScheme: z.enum(["light", "dark"]).optional(), // page-level theme — the most obvious visual fact, trivially queryable
  categories: z.array(Category).min(1).max(4),
  styleTags: z.array(StyleTag).min(1).max(4),
  components: z.array(Component).max(10).default([]),
  domainTags: z.array(DomainTag).max(4).optional(), // business/product context — see DomainTag docs
  industryVertical: z.string().max(40).optional(), // industry context (fintech, devtools, healthcare) — inferred from product/copy
  responsiveBehavior: z.enum(["responsive", "fixed-width", "adaptive"]).optional(), // layout adaptation strategy

  source: SourceAttribution,
  image: ImageRef,

  visual: VisualAttributes,

  // The actual value-add: why this is here, in your own words.
  mood: z.string().max(60).optional(), // emotional register ("playful", "clinical", "authoritative") — read from colors/type/copy/whitespace
  critique: z.string().min(80), // enforce: this can't be a one-liner
  whatToSteal: z.array(z.string().min(10)).min(1), // concrete, copyable techniques
  antiPatterns: AntiPatterns, // structured: mistakes avoided + where it fails + a11y risks
  layout: LayoutStructure.optional(), // machine-readable wireframe (optional — see LayoutStructure docs)

  /**
   * Business rationale — why this design choice may exist from a product
   * perspective. Keep absent when the capture lacks enough business context
   * (notably isolated group-member component crops).
   */
  businessRationale: BusinessRationale.optional(),

  /**
   * Voice — microcopy as a first-class dimension. "Good afternoon, Sam" vs
   * "Dashboard" is a design decision as much as font choice. Optional; populate
   * when the writing itself is notable (empty states, onboarding, error copy).
   */
  voice: z.object({
    tone: z.string(),                         // "restrained, confident, slightly dry"
    examples: z.array(z.string().min(2)).min(1), // real copy from the screen, verbatim
    avoid: z.array(z.string().min(2)).default([]), // "no exclamation enthusiasm on financial data"
  }).optional(),

  /**
   * Quality tier — exceptional (default) vs cautionary. A cautionary entry is a
   * genuinely bad example with a critique of WHY it fails — Mobbin can't do this
   * (no editorial stance). Same shape as any entry; low qualityScore + critique
   * reframed as "what goes wrong." Search ranks by qualityScore so cautionary
   * entries sink by default and surface only when explicitly asked.
   */
  qualityTier: z.enum(["exceptional", "cautionary"]).default("exceptional"),

  qualityScore: z.number().min(1).max(5), // your own rating, for ranking in search
  addedAt: IsoDate, // ISO date

  /**
   * Workflow state — separates "content hygiene" (the [DRAFT] marker gate, which
   * blocks save until text is rewritten) from "is this entry finished/approved."
   * A draft passes the marker gate (text is real) but isn't ready for MCP
   * retrieval yet — e.g. awaiting a second look, or staged for a batch commit.
   * MCP search hides drafts by default; surface with reviewStatus:"draft".
   * Optional + defaults to "approved" so existing entries need no migration.
   */
  reviewStatus: z.enum(["draft", "approved"]).optional().default("approved"),

  /**
   * Pin — protects curated entries from bulk re-tag. When true (or present),
   * `/api/auto-retag` skips the entry without invoking the tagger. Absent and
   * false are equivalent. Uses `.optional()` (not `.default(false)`) so existing
   * entries don't get a materialized `pinned: false` on their next save — no
   * corpus churn.
   */
  pinned: z.boolean().optional(),

  /**
   * Provenance — who produced the structured fields, and (optionally) who
   * reviewed them. Lets you tell which entries were rubber-stamped from the
   * tagger vs actually reviewed — essential for drift detection and if a second
   * curator joins. Optional + defaults so existing entries need no migration:
   *   - "auto"           : tagger produced the fields, no human review yet
   *   - "auto-reviewed"  : tagger produced, a human reviewed/edited
   *   - "human"          : a human wrote every field by hand (no tagger)
   * reviewedBy captures the reviewer's name/handle when set.
   */
  provenance: z.object({
    taggedBy: z.enum(["human", "auto", "auto-reviewed"]),
    reviewedBy: z.string().optional(),
    /**
     * When the entry came from the capture pipeline (vs. manual upload), records
     * how the image was produced. Absent = manual upload. Nested in provenance
     * rather than flat on `image` because it describes the process that produced
     * the pixels, not the pixels themselves — matches the taggedBy/reviewedBy
     * convention. The UI's "real capture" indicator is a single existence check
     * on this field.
     */
    capture: z.object({
      mode: z.enum(["section", "group-member", "recursive", "full-screen", "consent-modal"]),
      viewport: z.string(),                    // "desktop" | "mobile"
      selectorPath: z.string().optional(),     // best-effort CSS path for re-capture
      capturedAt: z.string(),                  // ISO timestamp
      sourceUrl: z.string(),                   // the URL the screenshot was taken from
    }).optional(),
    /** When the entry was last auto-tagged or retagged (YYYY-MM-DD). Advanced
     *  only by the tagger/retag path, NOT by human edits. Absent on legacy
     *  entries (pre-dating this field); display falls back to addedAt. */
    taggedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }).optional(),
});

export type CorpusEntryT = z.infer<typeof CorpusEntry>;

export const Corpus = z.object({
  version: z.literal(2),
  entries: z.array(CorpusEntry),
});

export type CorpusT = z.infer<typeof Corpus>;

// ─── Decision Lab (increment 1: single-screen decision brief) ──────────────────

/** Scope of the comparison. Increment 1 supports "screen" only; "flow" is
 *  reserved for a later increment and rejected by the validator. */
export const DecisionScope = z.enum(["screen", "flow"]);

/** Workflow state of a decision's analysis. */
export const DecisionStatus = z.enum(["draft", "analyzing", "analyzed", "failed"]);

/** Where a screen image came from. Increment 1 supports "upload" only; "figma"
 *  is reserved for a later increment and rejected by the validator. */
export const ScreenSource = z.enum(["upload", "figma"]);

/** Honest corpus-evidence labeling. Shown separately from analysis confidence. */
export const EvidenceCoverage = z.enum(["strong", "limited", "unavailable"]);

export const DecisionContext = z.object({
  targetUser: z.string().min(1),
  businessGoal: z.string().min(1),
  primaryKpi: z.string().min(1),
  platform: Platform.optional(),
  constraints: z.string().optional(),
});

/** One rubric dimension scored for a direction. Every score must cite at least
 *  one evidence id — enforced by the citation gate in decision-lab.ts. */
export const RubricDimension = z.enum([
  "goal-alignment",
  "visual-hierarchy",
  "cognitive-load",
  "copy-clarity",
  "consistency",
]);

export const RubricScore = z.object({
  dimension: RubricDimension,
  /** 1-5 scale. Null means the evidence was insufficient to score this dimension. */
  score: z.number().int().min(1).max(5).nullable(),
  rationale: z.string().min(1),
  /** Evidence ids (assembled-evidence keys) that justify this score. */
  evidence: z.array(z.string()).min(1),
});

/** One of the four fixed simulated perspectives. */
export const Perspective = z.object({
  lens: z.enum(["new-user", "returning-power-user", "accessibility-first", "growth-pm"]),
  directionId: z.string(),
  reaction: z.string().min(1),
  observations: z.array(z.object({
    note: z.string().min(1),
    evidence: z.array(z.string()).min(1),
  })).max(3),
  concern: z.string().min(1),
  confidence: z.enum(["high", "medium", "low"]),
  questionForUsers: z.string().min(1),
});

export const ExperimentBrief = z.object({
  hypothesis: z.string().min(1),
  successMetric: z.string().min(1),
  guardrails: z.array(z.string()).min(1),
});

/** A decision-relevant trade-off surfaced by the comparison. */
export const Tradeoff = z.object({
  description: z.string().min(1),
  evidence: z.array(z.string()).min(1),
});

export const DecisionScreen = z.object({
  id: z.string(),
  order: z.number().int().min(0),
  source: ScreenSource,
  imageRef: z.string().min(1),
  /** Present when source is "figma" (post-MVP). */
  figma: z.object({
    fileKey: z.string(),
    nodeId: z.string(),
    frameName: z.string(),
  }).optional(),
  /** The tagger extraction output (Pass 1), stored as an opaque record.
   *  Consumed by the synthesis as assembled evidence. */
  tagging: z.record(z.string(), z.unknown()).optional(),
});

export const Direction = z.object({
  id: z.string(),
  name: z.string().min(1),
  description: z.string().optional(),
  screens: z.array(DecisionScreen).min(1),
});

export const DecisionAnalysis = z.object({
  status: DecisionStatus,
  providerMetadata: z.object({
    extractionProvider: z.string(),
    synthesisProvider: z.string(),
    model: z.string(),
  }).optional(),
  analyzedAt: IsoDate.optional(),
  directionRubrics: z.array(z.object({
    directionId: z.string(),
    scores: z.array(RubricScore),
  })),
  tradeoffs: z.array(Tradeoff).min(1).max(3),
  evidenceCoverage: EvidenceCoverage,
  corpusEntryCount: z.number().int().min(0),
  perspectives: z.array(Perspective),
  experimentBrief: ExperimentBrief,
});

export const Decision = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "lowercase kebab-case id"),
  title: z.string().min(1),
  createdAt: IsoDate,
  updatedAt: IsoDate,
  context: DecisionContext,
  /** Increment 1: must be "screen". The enum includes "flow" for forward
   *  compatibility, but the refines below reject it until the flow increment. */
  scope: DecisionScope,
  directions: z.array(Direction).min(2).max(3),
  analysis: DecisionAnalysis.optional(),
}).superRefine((val, ctx) => {
  if (val.scope === "flow") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Multi-screen flow comparison is not yet supported", path: ["scope"] });
  }
  val.directions.forEach((dir, i) => {
    dir.screens.forEach((screen, j) => {
      if (screen.source === "figma") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Figma import is not yet supported — upload screenshots instead", path: ["directions", i, "screens", j, "source"] });
      }
    });
  });
});

export type DecisionT = z.infer<typeof Decision>;
export type DirectionT = z.infer<typeof Direction>;
export type DecisionScreenT = z.infer<typeof DecisionScreen>;
export type DecisionContextT = z.infer<typeof DecisionContext>;
export type DecisionAnalysisT = z.infer<typeof DecisionAnalysis>;
export type RubricScoreT = z.infer<typeof RubricScore>;
export type PerspectiveT = z.infer<typeof Perspective>;
export type ExperimentBriefT = z.infer<typeof ExperimentBrief>;
export type TradeoffT = z.infer<typeof Tradeoff>;
export type EvidenceCoverageT = z.infer<typeof EvidenceCoverage>;

/** Container for decisions.json, mirroring the Corpus wrapper. */
export const Decisions = z.object({
  version: z.literal(1),
  decisions: z.array(Decision),
});

export type DecisionsT = z.infer<typeof Decisions>;

// ─── draft hygiene (single source of truth) ──────────────────────────────────

/**
 * Regex matching draft/placeholder/todo markers that mean "this field is not
 * finished." Used by validate-corpus, commit-draft, ui-server, and the browser
 * save flow so the rule is identical everywhere — no duplicated, slightly-
 * inconsistent checks.
 */
const DRAFT_MARKER_RE = /\[(?:DRAFT|PLACEHOLDER|TODO\b)/i;

/**
 * Collect every free-text field on an entry that could carry a draft marker.
 * Returns the texts so callers can report WHICH field is dirty.
 */
export function entryTextFields(entry: CorpusEntryT): Array<{ field: string; text: string }> {
  return [
    { field: "critique", text: entry.critique },
    ...entry.whatToSteal.map((t, i) => ({ field: `whatToSteal[${i}]`, text: t })),
    ...entry.antiPatterns.antiPatterns.map((t, i) => ({ field: `antiPatterns.antiPatterns[${i}]`, text: t })),
    ...entry.antiPatterns.whereThisFails.map((t, i) => ({ field: `antiPatterns.whereThisFails[${i}]`, text: t })),
    // Structured a11y risks carry multiple text fields (element/risk/evidence/wcag).
    // Expand each with indexed field paths so draft-marker reports point at the
    // exact sub-field that's dirty.
    ...entry.antiPatterns.accessibilityRisks.flatMap((risk, i) => {
      const fields: Array<{ field: string; text: string }> = [
        { field: `antiPatterns.accessibilityRisks[${i}].element`, text: risk.element },
        { field: `antiPatterns.accessibilityRisks[${i}].risk`, text: risk.risk },
        { field: `antiPatterns.accessibilityRisks[${i}].evidence`, text: risk.evidence },
        { field: `antiPatterns.accessibilityRisks[${i}].wcag`, text: risk.wcag.join(", ") },
      ];
      return fields;
    }),
    ...(entry.antiPatterns.legacyAccessibilityNotes ?? []).map((note, i) => ({
      field: `antiPatterns.legacyAccessibilityNotes[${i}]`, text: note,
    })),
    ...(entry.businessRationale ? [
      { field: "businessRationale.targetUser", text: entry.businessRationale.targetUser },
      { field: "businessRationale.rationale", text: entry.businessRationale.rationale },
    ] : []),
    ...(entry.voice ? [
      { field: "voice.tone", text: entry.voice.tone },
      ...entry.voice.examples.map((t, i) => ({ field: `voice.examples[${i}]`, text: t })),
      ...entry.voice.avoid.map((t, i) => ({ field: `voice.avoid[${i}]`, text: t })),
    ] : []),
  ];
}

/**
 * Returns the fields that still carry a draft/placeholder/todo marker, or an
 * empty array if the entry is clean. One function, one rule, every caller.
 */
export function findDraftMarkers(entry: CorpusEntryT): string[] {
  return entryTextFields(entry)
    .filter((f) => DRAFT_MARKER_RE.test(f.text))
    .map((f) => f.field);
}

/** Convenience boolean — true if the entry is clean and safe to commit. */
export function hasDraftMarkers(entry: CorpusEntryT): boolean {
  return findDraftMarkers(entry).length > 0;
}
