/**
 * design-handoff.ts — the deterministic DESIGN.md handoff renderer.
 *
 * Task 5 of the web design adapters plan. This module is the integration hub
 * that ties Tasks 1–4 together and produces the final DESIGN.md and JSON output.
 *
 * Public surface:
 *  - parseDesignHandoff(input)  — re-exported fail-closed boundary (Task 1).
 *  - buildDesignHandoff(input)  — producer-facing API: parse + resolve registry
 *                                  + build dependency/source manifests.
 *  - renderDesignHandoffMarkdown(handoff)  — deterministic 19-section DESIGN.md.
 *  - renderDesignHandoffJson(handoff)      — JSON with stable key order + final newline.
 *  - renderDesignHandoff(handoff, format)  — dispatch ("markdown" | "json").
 *
 * Invariants:
 *  - Renderers are pure, deterministic, offline.
 *  - No private corpus material (.c2-private) or third-party source code.
 *  - Markdown: 19-section outline, deterministic.
 *  - JSON: stable key order, final newline.
 *  - buildDesignHandoff is the ONLY integration entry point for future producers.
 */
import {
  parseDesignHandoff as parseDesignHandoffImpl,
  type DesignHandoffInput,
  type DesignHandoffT,
  type DependencyRef,
  type MotionIntent,
  type SourceRef,
  type WebTargetProfile,
} from "./design-target-contracts.js";
import {
  resolveWebTarget,
  buildDependencyManifest,
  type ResolvedWebTarget,
} from "./design-adapter-registry.js";
import { buildSourceManifest } from "./design-source-registry.js";
import {
  normalizeSemanticTokens,
  renderCssTokens,
  renderTailwindTheme,
} from "./design-token-adapters.js";
import {
  renderWebMotionGuidance,
  motionSourceRefs,
} from "./design-motion-adapters.js";
import type { UiSpecT } from "./tool-contracts.js";

// ===========================================================================
// Re-exports — Task 1 fail-closed boundary
// ===========================================================================

export {
  parseDesignHandoffImpl as parseDesignHandoff,
  type DesignHandoffInput,
  type DesignHandoffT,
};

// ===========================================================================
// Version constants — the handoff envelope versions
// ===========================================================================

const SPEC_VERSION = "1.0";
const HANDOFF_VERSION = "web-1.0";

// ===========================================================================
// ResolvedDesignHandoff — internal carry that bundles the parsed handoff with
// resolved manifests. The renderer pulls every per-profile decision from this
// object so there is exactly one place that owns the integration shape.
// ===========================================================================

interface ResolvedDesignHandoff {
  readonly handoff: DesignHandoffT;
  readonly resolved: ResolvedWebTarget;
  readonly dependencies: readonly DependencyRef[];
  readonly sources: readonly SourceRef[];
}

// ===========================================================================
// buildDesignHandoff — the ONLY integration entry point for future producers
// ===========================================================================

/**
 * The producer-facing integration API. A future `create_ui_spec` producer must
 * call this function after producing a schema-valid UiSpec and structured
 * MotionIntent array; it must NOT construct DesignHandoffT directly.
 *
 * Pipeline (fail-closed at every step):
 *  1. parseDesignHandoff — schema-validate spec, target, motionIntents.
 *  2. resolveWebTarget   — registry compatibility check (throws on incompatible).
 *  3. buildDependencyManifest — exact-version install pins.
 *  4. buildSourceManifest + motionSourceRefs — provenance (URLs only).
 *
 * The returned object is the trusted handoff envelope; manifests live on the
 * resolved carry used by the renderers.
 */
export function buildDesignHandoff(input: DesignHandoffInput): DesignHandoffT {
  // Step 1: fail-closed schema validation (the only constructor for DesignHandoffT).
  const handoff = parseDesignHandoffImpl(input);
  // Step 1b: private-path boundary. Reject any UiSpec whose text fields
  // contain private corpus paths (.c2-private/, corpus/private/, etc.).
  // The renderer reproduces UiSpec text verbatim into Markdown, so this
  // gate must fire at the handoff boundary, not in the renderer.
  assertNoPrivatePathsInSpec(handoff.spec, handoff.motionIntents);
  // Step 1c: structural Markdown injection. Reject UiSpec text fields or
  // motion intent fields that contain structural Markdown characters
  // (multi-line content with ## headers, fenced code blocks) that would
  // break the deterministic section count or inject untrusted content.
  assertNoStructuralMarkdownInSpec(handoff.spec, handoff.motionIntents);
  // Step 2: registry compatibility resolution. Throws on incompatible combos
  // (e.g. astro-vue + React-only source). This is where parseDesignHandoff's
  // shape-level check becomes a capability-level check.
  resolveWebTarget(handoff.target);
  // Step 3: eagerly build the dependency + source manifests. Their construction
  // is part of the fail-closed boundary (any future registry rule that throws
  // here surfaces at this entry point, not inside a renderer). The manifests are
  // recomputed by the renderer from the handoff alone (pure function of the
  // handoff) so the trusted envelope stays the single source of truth; the
  // eager calls here are for boundary integrity, not for the return value.
  buildDependencyManifest(handoff.target);
  buildSourceManifest(handoff.target);
  motionSourceRefs(handoff.target);
  return handoff;
}

// ---------------------------------------------------------------------------
// Boundary assertions — reject private paths and structural Markdown injection
// at the handoff boundary, before rendering.
// ---------------------------------------------------------------------------

const PRIVATE_PATH_PATTERNS = [
  /\.c2-private\//,
  /\/corpus\/private\//,
  /corpus\/images-private\//,
] as const;

/** Collect all user-supplied text fields from a UiSpec that the renderer emits. */
function collectSpecTextFields(spec: UiSpecT): Array<{ field: string; value: string }> {
  const fields: Array<{ field: string; value: string }> = [];
  fields.push({ field: "designDirection", value: spec.designDirection });
  if (spec.context.productContext) fields.push({ field: "context.productContext", value: spec.context.productContext });
  if (spec.context.implementationFramework) fields.push({ field: "context.implementationFramework", value: spec.context.implementationFramework });
  if (spec.context.designSystem) {
    if (spec.context.designSystem.registry) fields.push({ field: "context.designSystem.registry", value: spec.context.designSystem.registry });
    if (spec.context.designSystem.library) fields.push({ field: "context.designSystem.library", value: spec.context.designSystem.library });
  }
  if (spec.contentVoiceGuidance) fields.push({ field: "contentVoiceGuidance", value: spec.contentVoiceGuidance });
  if (spec.frameworkNotes) fields.push({ field: "frameworkNotes", value: spec.frameworkNotes });
  for (const c of spec.context.constraints) fields.push({ field: "context.constraints[]", value: c });
  for (const r of spec.rejectedDefaults) fields.push({ field: "rejectedDefaults[]", value: r });
  for (const i of spec.interactions) fields.push({ field: "interactions[]", value: i });
  for (const a of spec.accessibilityConstraints) fields.push({ field: "accessibilityConstraints[]", value: a });
  for (const ref of spec.citedReferences) fields.push({ field: "citedReferences[]", value: ref });
  for (const t of spec.techniques) fields.push({ field: "techniques[].text", value: t.text });
  for (const a of spec.antiPatterns) fields.push({ field: "antiPatterns[].text", value: a.text });
  for (const r of spec.layoutRegions) {
    fields.push({ field: "layoutRegions[].name", value: r.name });
    fields.push({ field: "layoutRegions[].type", value: r.type });
    for (const c of r.components) fields.push({ field: "layoutRegions[].components[]", value: c });
    for (const r2 of r.responsive) fields.push({ field: "layoutRegions[].responsive[]", value: r2 });
  }
  for (const rb of spec.responsiveBehavior) fields.push({ field: "responsiveBehavior[]", value: rb });
  for (const ci of spec.componentInventory) {
    fields.push({ field: "componentInventory[].name", value: ci.name });
    fields.push({ field: "componentInventory[].pattern", value: ci.pattern });
  }
  for (const n of spec.motionGuidance.notes) fields.push({ field: "motionGuidance.notes[]", value: n });
  for (const u of spec.unavailableDecisions) fields.push({ field: "unavailableDecisions[].reason", value: u.reason });
  for (const a of spec.acceptanceCriteria) {
    if ("subject" in a && typeof a.subject === "string") fields.push({ field: "acceptanceCriteria[].subject", value: a.subject });
    if ("expectedOutcome" in a && typeof a.expectedOutcome === "string") fields.push({ field: "acceptanceCriteria[].expectedOutcome", value: a.expectedOutcome });
    if ("assertion" in a && typeof a.assertion === "string") fields.push({ field: "acceptanceCriteria[].assertion", value: a.assertion });
  }
  return fields;
}

/**
 * Reject any UiSpec whose text fields contain private corpus paths. The
 * renderer reproduces UiSpec text verbatim into Markdown output, so private
 * paths must be caught at the handoff boundary.
 */
function assertNoPrivatePathsInSpec(spec: UiSpecT, motionIntents: ReadonlyArray<MotionIntent>): void {
  const fields = collectSpecTextFields(spec);
  for (const m of motionIntents) {
    fields.push({ field: `motionIntents[${m.id}].id`, value: m.id });
    fields.push({ field: `motionIntents[${m.id}].reducedMotion`, value: m.reducedMotion });
    fields.push({ field: `motionIntents[${m.id}].trigger`, value: m.trigger });
    fields.push({ field: `motionIntents[${m.id}].durationToken`, value: m.durationToken });
    fields.push({ field: `motionIntents[${m.id}].easingToken`, value: m.easingToken });
    for (const p of m.properties) fields.push({ field: `motionIntents[${m.id}].properties[]`, value: p });
  }
  for (const { field, value } of fields) {
    for (const pattern of PRIVATE_PATH_PATTERNS) {
      if (pattern.test(value)) {
        throw new Error(
          `[design-handoff] private path detected in UiSpec field "${field}": ` +
          `pattern ${String(pattern)} matched. Private corpus paths must not ` +
          `appear in design handoff output.`,
        );
      }
    }
  }
}

/**
 * Reject UiSpec text fields or motion intent fields containing structural
 * Markdown characters that would break the deterministic section contract:
 * - Values starting with `## ` (would inject extra sections)
 * - Values starting with triple backticks (would inject code blocks)
 * Checked on ALL values, not just multi-line ones — a single-line value
 * like "## INJECTED" at the start of a rendered section breaks the 19-section count.
 */
function assertNoStructuralMarkdownInSpec(spec: UiSpecT, motionIntents: ReadonlyArray<MotionIntent>): void {
  const fields = collectSpecTextFields(spec);
  for (const m of motionIntents) {
    fields.push({ field: `motionIntents[${m.id}].reducedMotion`, value: m.reducedMotion });
    fields.push({ field: `motionIntents[${m.id}].trigger`, value: m.trigger });
    fields.push({ field: `motionIntents[${m.id}].durationToken`, value: m.durationToken });
    fields.push({ field: `motionIntents[${m.id}].easingToken`, value: m.easingToken });
  }
  for (const { field, value } of fields) {
    // Check both single-line and multi-line: any line starting with ## or ```
    if (/^##\s/m.test(value) || /^```/m.test(value)) {
      throw new Error(
        `[design-handoff] structural Markdown detected in "${field}": ` +
        `the value contains a line starting with ## or triple backticks. ` +
        `This would inject extra sections or code blocks into the deterministic output.`,
      );
    }
  }
}

/** Resolve all per-profile manifests for rendering. Pure over the handoff. */
function resolveForRender(handoff: DesignHandoffT): ResolvedDesignHandoff {
  const resolved = resolveWebTarget(handoff.target);
  const dependencies = [...buildDependencyManifest(handoff.target)].sort(sortDependency);
  const sources = dedupeSources([
    ...buildSourceManifest(handoff.target),
    ...motionSourceRefs(handoff.target),
  ]);
  return {
    handoff,
    resolved,
    dependencies,
    sources,
  };
}

/** Stable alphabetical sort for the dependency manifest (no mutation). */
function sortDependency(a: DependencyRef, b: DependencyRef): number {
  return a.packageName < b.packageName ? -1 : a.packageName > b.packageName ? 1 : 0;
}

/** Deduplicate sources by sourceId, preserving the stable registry order. */
function dedupeSources(refs: readonly SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const ref of refs) {
    if (seen.has(ref.sourceId)) continue;
    seen.add(ref.sourceId);
    out.push(ref);
  }
  return out;
}

// ===========================================================================
// VersionedRef rendering helpers — uniform "<id>@<version>" with policy
// ===========================================================================

/**
 * Render a target field as `<value>@<policy-suffix>` for frontmatter / display.
 * The policy suffix is:
 *  - the version itself for `exact` (e.g. `5.7.10`)
 *  - the version range for `range` (e.g. `5.x`)
 *  - the literal `unversioned` for browser APIs / platform features
 */
function formatVersionedRef(value: string, version: string, policy: string): string {
  if (policy === "unversioned") return `${value}@unversioned`;
  return `${value}@${version}`;
}

// ---------------------------------------------------------------------------
// Per-field profile formatting. These are the only places that turn a profile
// enum into a versioned display string, so per-profile drift is impossible.
// ---------------------------------------------------------------------------

interface ProfileVersionInfo {
  siteFramework: string;
  siteFrameworkPolicy: string;
  uiRuntime: string;
  uiRuntimePolicy: string;
  styling: string;
  stylingPolicy: string;
  componentSource: string;
  componentSourcePolicy: string;
  motion: string;
  motionPolicy: string;
}

/** Map a WebTargetProfile to its display version info. */
function profileVersionInfo(p: WebTargetProfile): ProfileVersionInfo {
  let siteFramework = "none";
  let siteFrameworkPolicy = "unversioned";
  if (p.siteFramework === "astro") {
    siteFramework = "astro@5.x";
    siteFrameworkPolicy = "range";
  }

  let uiRuntime = "none";
  let uiRuntimePolicy = "unversioned";
  if (p.runtime === "react") {
    uiRuntime = "react@19.x";
    uiRuntimePolicy = "range";
  } else if (p.runtime === "vue") {
    uiRuntime = "vue@3.x";
    uiRuntimePolicy = "range";
  }

  let styling = "vanilla-css@unversioned";
  let stylingPolicy = "unversioned";
  if (p.styling === "tailwind") {
    styling = "tailwind@4.x";
    stylingPolicy = "range";
  } else if (p.styling === "css-modules") {
    styling = "css-modules@unversioned";
    stylingPolicy = "unversioned";
  }

  const componentSource = `${p.componentSource}@unversioned`;
  const componentSourcePolicy = "unversioned";

  const motion = `${p.motion}@unversioned`;
  const motionPolicy = "unversioned";

  return {
    siteFramework,
    siteFrameworkPolicy,
    uiRuntime,
    uiRuntimePolicy,
    styling,
    stylingPolicy,
    componentSource,
    componentSourcePolicy,
    motion,
    motionPolicy,
  };
}

// ===========================================================================
// renderDesignHandoffMarkdown — the deterministic 19-section DESIGN.md
// ===========================================================================

/** The 19 section headers, in fixed order. Implementation guidance is #14. */
const SECTION_HEADERS: readonly string[] = [
  "Direction",
  "Context",
  "Rejected defaults",
  "Sources",
  "Color tokens",
  "Typography",
  "Layout regions",
  "Responsive behavior",
  "Voice & copy",
  "Component inventory",
  "Techniques to borrow",
  "Anti-patterns to avoid",
  "Accessibility constraints",
  "Implementation guidance",
  "Interactions",
  "Motion guidance",
  "Acceptance criteria",
  "Dependency manifest",
  "Source manifest",
];

/** Assert the section header list satisfies the section-14 contract. */
function assertSectionContract(): void {
  if (SECTION_HEADERS.length !== 19) {
    throw new Error(`design-handoff: expected 19 sections, got ${SECTION_HEADERS.length}`);
  }
  if (!/implementation/i.test(SECTION_HEADERS[13])) {
    throw new Error(`design-handoff: section 14 must be Implementation guidance`);
  }
}
assertSectionContract();

/**
 * Render the deterministic DESIGN.md. Pure, offline, byte-identical on repeated
 * calls. The output opens with a YAML frontmatter block, then the 19 sections.
 */
export function renderDesignHandoffMarkdown(handoff: DesignHandoffT): string {
  const ctx = resolveForRender(handoff);
  const tokens = normalizeSemanticTokens(handoff.spec);
  const lines: string[] = [];

  // ── Frontmatter ──────────────────────────────────────────────────────────
  const v = profileVersionInfo(handoff.target);
  lines.push("---");
  lines.push(`spec_version: "${SPEC_VERSION}"`);
  lines.push(`handoff_version: "${HANDOFF_VERSION}"`);
  lines.push(`target_profile: "${handoff.target.id}"`);
  lines.push(`platform: "${handoff.target.platform}"`);
  lines.push(`site_framework: "${v.siteFramework}"`);
  lines.push(`site_framework_version_policy: "${v.siteFrameworkPolicy}"`);
  lines.push(`ui_runtime: "${v.uiRuntime}"`);
  lines.push(`ui_runtime_version_policy: "${v.uiRuntimePolicy}"`);
  lines.push(`styling: "${v.styling}"`);
  lines.push(`styling_version_policy: "${v.stylingPolicy}"`);
  lines.push(`component_source: "${v.componentSource}"`);
  lines.push(`motion: "${v.motion}"`);
  lines.push("---");
  lines.push("");

  // ── Title ────────────────────────────────────────────────────────────────
  lines.push("# DESIGN.md");
  lines.push("");

  // Each section is appended in fixed order. Section renderers never mutate
  // SECTION_HEADERS and never reorder content.
  for (let i = 0; i < SECTION_HEADERS.length; i++) {
    const header = SECTION_HEADERS[i]!;
    lines.push(`## ${header}`);
    lines.push(...renderSection(i, ctx, tokens));
    lines.push("");
  }

  // Trim trailing blank line, end with a single newline.
  return `${lines.join("\n").replace(/\n+$/, "\n")}`;
}

/**
 * Render the body of a single section by index. Switching on the index keeps
 * the section order coupled to SECTION_HEADERS — a section cannot drift without
 * also moving its index.
 */
function renderSection(
  index: number,
  ctx: ResolvedDesignHandoff,
  tokens: ReturnType<typeof normalizeSemanticTokens>,
): string[] {
  const { handoff } = ctx;
  const spec = handoff.spec;

  switch (index) {
    case 0: // Direction
      return [spec.designDirection];

    case 1: // Context
      return renderContextSection(spec);

    case 2: // Rejected defaults
      return spec.rejectedDefaults.length > 0
        ? spec.rejectedDefaults.map((d) => `- ${d}`)
        : ["_(no rejected defaults recorded)_"];

    case 3: // Sources
      return renderSourcesSection(ctx);

    case 4: // Color tokens
      return renderColorTokensSection(handoff.target, tokens);

    case 5: // Typography
      return renderTypographySection(spec.typographyTokens);

    case 6: // Layout regions
      return spec.layoutRegions.length > 0
        ? spec.layoutRegions.map((r) =>
            `- **${r.name}** (${r.type}) — components: ${r.components.join(", ") || "none"}; responsive: ${r.responsive.join(", ") || "n/a"}`,
          )
        : ["_(no layout regions recorded)_"];

    case 7: // Responsive behavior
      return spec.responsiveBehavior.length > 0
        ? spec.responsiveBehavior.map((b) => `- ${b}`)
        : ["_(no responsive behavior recorded)_"];

    case 8: // Voice & copy
      return [spec.contentVoiceGuidance ?? "_(no voice guidance recorded)_"];

    case 9: // Component inventory
      return spec.componentInventory.length > 0
        ? spec.componentInventory.map((c) => `- **${c.name}** — pattern: ${c.pattern}`)
        : ["_(no components recorded)_"];

    case 10: // Techniques to borrow
      return spec.techniques.length > 0
        ? spec.techniques.map((t) => `- ${t.text}`)
        : ["_(no techniques recorded)_"];

    case 11: // Anti-patterns to avoid
      return spec.antiPatterns.length > 0
        ? spec.antiPatterns.map((a) => `- ${a.text}`)
        : ["_(no anti-patterns recorded)_"];

    case 12: // Accessibility constraints
      return spec.accessibilityConstraints.length > 0
        ? spec.accessibilityConstraints.map((a) => `- ${a}`)
        : ["_(no accessibility constraints recorded)_"];

    case 13: // Implementation guidance (section 14)
      return renderImplementationSection(ctx);

    case 14: // Interactions
      return spec.interactions.length > 0
        ? spec.interactions.map((i) => `- ${i}`)
        : ["_(no interactions recorded)_"];

    case 15: // Motion guidance
      return renderWebMotionGuidance(handoff.target, handoff.motionIntents)
        .split("\n")
        // The motion adapter already emits a "## Motion guidance" header; drop
        // it so our SECTION_HEADERS owns the heading level.
        .filter((line) => !line.startsWith("## "))
        .map((line) => line);

    case 16: // Acceptance criteria
      return spec.acceptanceCriteria.map((ac) => {
        const base = `- **${ac.id}** [${ac.priority}] ${ac.subject} ${ac.assertion} → ${ac.expectedOutcome} (verifier: ${ac.verifier})`;
        return base;
      });

    case 17: // Dependency manifest
      return renderDependencyManifestSection(ctx);

    case 18: // Source manifest
      return renderSourceManifestSection(ctx);

    default:
      // Unreachable — SECTION_HEADERS length is asserted at module load.
      return ["_(unknown section)_"];
  }
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderContextSection(spec: DesignHandoffT["spec"]): string[] {
  const lines: string[] = [];
  lines.push(`- Product context: ${spec.context.productContext}`);
  if (spec.context.platform) lines.push(`- Platform: ${spec.context.platform}`);
  if (spec.context.implementationFramework) {
    lines.push(`- Implementation framework: ${spec.context.implementationFramework}`);
  }
  if (spec.context.designSystem && spec.context.designSystem.status === "identified") {
    const ds = spec.context.designSystem;
    const parts: string[] = [];
    if (ds.registry) parts.push(`registry: ${ds.registry}`);
    if (ds.library) parts.push(`library: ${ds.library}`);
    lines.push(`- Design system: identified (${parts.join(", ")})`);
  }
  if (spec.context.constraints.length > 0) {
    lines.push(`- Constraints: ${spec.context.constraints.join("; ")}`);
  }
  if (spec.frameworkNotes) {
    lines.push(`- Framework notes: ${spec.frameworkNotes}`);
  }
  return lines;
}

function renderSourcesSection(ctx: ResolvedDesignHandoff): string[] {
  const lines: string[] = [];
  // The handoff never embeds raw corpus records — only stable provenance URLs.
  const cited = ctx.handoff.spec.citedReferences;
  if (cited.length > 0) {
    lines.push("Cited references:");
    for (const ref of cited) lines.push(`- ${ref}`);
  } else {
    lines.push("_(no cited references recorded)_");
  }
  // Documentation sources consulted by the chosen profile.
  if (ctx.sources.length > 0) {
    lines.push("");
    lines.push("Documentation sources consulted by this target profile:");
    for (const src of ctx.sources) {
      lines.push(`- \`${src.sourceId}\` — ${src.url}`);
    }
  }
  return lines;
}

function renderColorTokensSection(
  target: WebTargetProfile,
  tokens: ReturnType<typeof normalizeSemanticTokens>,
): string[] {
  const lines: string[] = [];
  lines.push("Paste-ready semantic tokens. Stable custom property names are emitted regardless of profile so downstream CSS can reference them.");
  lines.push("");
  // Tailwind targets get the @theme block; everything else gets :root CSS vars.
  if (target.styling === "tailwind") {
    lines.push("```css");
    lines.push(renderTailwindTheme(tokens));
    lines.push("```");
  } else {
    lines.push("```css");
    lines.push(renderCssTokens(tokens));
    lines.push("```");
  }
  return lines;
}

function renderTypographySection(
  typographyTokens: DesignHandoffT["spec"]["typographyTokens"],
): string[] {
  const lines: string[] = [];
  if (typographyTokens) {
    lines.push(`- Heading: ${typographyTokens.heading}`);
    lines.push(`- Body: ${typographyTokens.body}`);
    lines.push(`- Mono: ${typographyTokens.mono}`);
  } else {
    lines.push("Typography tokens are unavailable for this spec. Do not infer a font stack from corpus data; record an explicit decision when one is made.");
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Implementation section (section 14)
// ---------------------------------------------------------------------------

function renderImplementationSection(ctx: ResolvedDesignHandoff): string[] {
  const { handoff, resolved } = ctx;
  const profile = handoff.target;
  const isNeutral = profile.id === "neutral-web";
  const isAstroReact = profile.id === "astro-react";
  const isAstroVue = profile.id === "astro-vue";
  const lines: string[] = [];

  // ── Setup ───────────────────────────────────────────────────────────────
  lines.push("### Setup");
  lines.push(resolved.definition.setupNotes);
  lines.push("");

  // ── Dependencies ────────────────────────────────────────────────────────
  lines.push("### Dependencies");
  if (ctx.dependencies.length > 0) {
    lines.push("Install with exact versions (never `latest`). Package dependencies always use `versionPolicy: \"exact\"`.");
    lines.push("");
    for (const dep of ctx.dependencies) {
      const docs = dep.docsUrl ? ` — docs: ${dep.docsUrl}` : "";
      lines.push(
        `- \`${dep.packageName}@${dep.version}\` (${dep.versionPolicy}${dep.required ? "; required" : "; optional"}) — ${dep.purpose}${docs}`,
      );
    }
  } else {
    lines.push("_(no install dependencies for this profile)_");
  }
  lines.push("");

  // ── Component-role mapping ──────────────────────────────────────────────
  lines.push("### Component-role mapping");
  lines.push(`Component source: \`${formatVersionedRef(profile.componentSource, "unversioned", "unversioned")}\`.`);
  if (handoff.spec.componentInventory.length > 0) {
    for (const comp of handoff.spec.componentInventory) {
      lines.push(`- \`${comp.name}\` → pattern: ${comp.pattern} (source: ${profile.componentSource})`);
    }
  } else {
    lines.push("_(no components recorded in the spec)_");
  }
  if (isAstroVue) {
    lines.push("");
    lines.push("This target is Vue-only. React-only component libraries are NOT permitted under any name; use native HTML or custom Vue components only.");
  }
  lines.push("");

  // ── Token filenames ─────────────────────────────────────────────────────
  lines.push("### Token filenames");
  if (profile.styling === "tailwind") {
    lines.push("- Emit Tailwind v4 `@theme` variables in `src/styles/tokens.css` (imported by the root layout).");
  } else {
    lines.push("- Emit CSS custom properties under `:root` in `src/styles/tokens.css` (imported by the root layout).");
  }
  lines.push("- Stable names: `--bg-canvas`, `--bg-surface`, `--text-primary`, `--text-muted`, `--action-accent`, `--font-heading`, `--font-body`, `--font-mono`.");
  lines.push("");

  // ── Island strategy ─────────────────────────────────────────────────────
  // neutral-web has no host framework and no UI runtime, so the island
  // subsection is OMITTED entirely (per the plan's "What differs by profile").
  // This keeps neutral-web output free of island/React/Astro vocabulary.
  if (!isNeutral) {
    lines.push("### Island strategy");
    lines.push(`Island directive: \`${profile.islandStrategy ?? "(none)"}\`.`);
    lines.push("- Hydrate only the components that need interactivity; static content stays server-rendered by Astro.");
    if (isAstroReact) {
      lines.push("- Apply the directive (`client:load`, `client:idle`, `client:visible`) on each React island root.");
    } else if (isAstroVue) {
      lines.push("- Apply the directive (`client:load`, `client:idle`, `client:visible`) on each Vue island root.");
    }
    lines.push("");
  }

  // ── Motion adapter ──────────────────────────────────────────────────────
  lines.push("### Motion adapter");
  lines.push(`Motion: \`${formatVersionedRef(profile.motion, "unversioned", "unversioned")}\`.`);
  lines.push("- See the Motion guidance section for the implementation primitives and the prefers-reduced-motion fallback.");
  lines.push("");

  // ── Source-attribution rules ────────────────────────────────────────────
  lines.push("### Source-attribution rules");
  lines.push("- Cite every consulted source by its stable `sourceId`; never copy third-party source code into the project.");
  lines.push("- A source is either `captured` (bytes vendored with a 64-char lowercase SHA-256) or `not-captured` (with a reason). Never invent a hash.");
  lines.push("- Documentation URLs are provenance pointers, not install dependencies; do not list them in the dependency manifest.");
  lines.push("");

  // ── Warnings for not-captured sources ───────────────────────────────────
  lines.push("### Source warnings");
  const notCaptured = ctx.sources.filter((s) => s.snapshotStatus === "not-captured");
  if (notCaptured.length > 0) {
    lines.push("WARNING — the following sources are referenced but NOT captured. Their bytes are not vendored; cite the URL, do not copy the source.");
    for (const src of notCaptured) {
      lines.push(
        `- WARNING: \`${src.sourceId}\` (${src.url}) is not-captured — reason: ${src.snapshotReason ?? "(no reason recorded)"}. License status: ${src.licenseStatus}. Attribution: ${src.attribution}.`,
      );
    }
  } else {
    lines.push("_(no not-captured source warnings for this profile)_");
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Dependency + source manifest sections
// ---------------------------------------------------------------------------

function renderDependencyManifestSection(ctx: ResolvedDesignHandoff): string[] {
  const lines: string[] = [];
  if (ctx.dependencies.length > 0) {
    for (const dep of ctx.dependencies) {
      lines.push(
        `- \`${dep.packageName}@${dep.version}\` — policy: ${dep.versionPolicy}; required: ${dep.required}; purpose: ${dep.purpose}${dep.docsUrl ? `; docs: ${dep.docsUrl}` : ""}`,
      );
    }
  } else {
    lines.push("_(no install dependencies — this profile uses platform-native primitives only)_");
  }
  return lines;
}

function renderSourceManifestSection(ctx: ResolvedDesignHandoff): string[] {
  const lines: string[] = [];
  if (ctx.sources.length > 0) {
    for (const src of ctx.sources) {
      const hashPart = src.snapshotSha256 ? `; sha256: ${src.snapshotSha256}` : "";
      const reasonPart = src.snapshotReason ? `; reason: ${src.snapshotReason}` : "";
      lines.push(
        `- \`${src.sourceId}\` (${src.kind}) — ${src.url}; status: ${src.snapshotStatus}${hashPart}${reasonPart}; license: ${src.licenseStatus}; attribution: ${src.attribution}`,
      );
    }
  } else {
    lines.push("_(no documentation sources consulted by this profile)_");
  }
  return lines;
}

// ===========================================================================
// renderDesignHandoffJson — stable key order + final newline
// ===========================================================================

/**
 * Render the handoff as a JSON string. The top-level key order is stable
 * (`spec_version`, `handoff_version`, `target_profile`, ...). Output ends with
 * a single trailing newline. Pure and deterministic.
 */
export function renderDesignHandoffJson(handoff: DesignHandoffT): string {
  const ctx = resolveForRender(handoff);
  const v = profileVersionInfo(handoff.target);

  // Build the object with keys in the exact stable order required. We do NOT
  // use JSON.stringify on an arbitrary object — TS preserves insertion order
  // for string keys, and we construct the object literal in this exact order.
  const payload = {
    spec_version: SPEC_VERSION,
    handoff_version: HANDOFF_VERSION,
    target_profile: handoff.target.id,
    platform: handoff.target.platform,
    site_framework: v.siteFramework,
    site_framework_version_policy: v.siteFrameworkPolicy,
    ui_runtime: v.uiRuntime,
    ui_runtime_version_policy: v.uiRuntimePolicy,
    styling: v.styling,
    styling_version_policy: v.stylingPolicy,
    component_source: v.componentSource,
    motion: v.motion,
    island_strategy: handoff.target.islandStrategy,
    generated_at: handoff.generatedAt,
    dependency_manifest: ctx.dependencies.map((dep) => ({
      package_name: dep.packageName,
      version: dep.version,
      version_policy: dep.versionPolicy,
      required: dep.required,
      purpose: dep.purpose,
      docs_url: dep.docsUrl,
    })),
    source_manifest: ctx.sources.map((src) => ({
      source_id: src.sourceId,
      kind: src.kind,
      url: src.url,
      snapshot_status: src.snapshotStatus,
      snapshot_sha256: src.snapshotSha256,
      snapshot_reason: src.snapshotReason,
      license_status: src.licenseStatus,
      attribution: src.attribution,
    })),
    motion_intents: handoff.motionIntents.map((intent) => ({
      id: intent.id,
      trigger: intent.trigger,
      properties: intent.properties,
      duration_token: intent.durationToken,
      easing_token: intent.easingToken,
      interruptible: intent.interruptible,
      reduced_motion: intent.reducedMotion,
    })),
  };

  // 2-space indentation; stable key order (insertion order); final newline.
  return `${JSON.stringify(payload, null, 2)}\n`;
}

// ===========================================================================
// renderDesignHandoff — dispatch
// ===========================================================================

/**
 * Dispatch to the requested renderer. Accepts only "markdown" or "json"; throws
 * on any other value (fail-closed — never silently default).
 */
export function renderDesignHandoff(
  handoff: DesignHandoffT,
  format: "markdown" | "json",
): string {
  if (format === "markdown") return renderDesignHandoffMarkdown(handoff);
  if (format === "json") return renderDesignHandoffJson(handoff);
  throw new Error(
    `renderDesignHandoff: unknown format "${format}" — only "markdown" or "json" are supported`,
  );
}
