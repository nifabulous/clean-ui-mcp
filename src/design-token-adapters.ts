/**
 * design-token-adapters.ts — semantic token projections for web handoffs.
 *
 * Task 3 of the web design adapters plan. `normalizeSemanticTokens` projects a
 * validated UiSpec 1.0 instance into stable semantic token names. The CSS and
 * Tailwind renderers are pure, deterministic, offline, and reject token values
 * that could break out of a CSS declaration (newlines, backticks, raw `;`).
 *
 * When a UiSpec carries null `colorTokens` or `typographyTokens` (an editorial
 * "unavailable" decision), the corresponding semantic tokens render as the
 * explicit string `"unavailable"` — never a guessed fallback or corpus-inferred
 * value. This keeps the "explicit decision over silent inference" invariant.
 *
 * The UiSpec 1.0 -> SemanticTokens mapping is isolated in one named function so
 * a future UiSpec schema that adds a real `canvas` token can swap the mapping
 * without touching the renderers.
 */
import type { UiSpecT } from "./tool-contracts.js";

// ===========================================================================
// 1. SemanticTokens type
// ===========================================================================

/**
 * Stable semantic token names. Every value is either the UiSpec token string
 * or the literal `"unavailable"` when the source token group was null.
 */
export interface SemanticTokens {
  bg: { canvas: string; surface: string };
  text: { primary: string; muted: string };
  action: { accent: string };
  font: { heading: string; body: string; mono: string };
}

/** The explicit sentinel emitted when a source token was null. */
export const UNAVAILABLE = "unavailable" as const;

// ===========================================================================
// 2. normalizeSemanticTokens — UiSpec 1.0 compatibility mapping
// ===========================================================================

/**
 * Project a validated UiSpec 1.0 instance into stable semantic token names.
 *
 * Current compatibility mapping (UiSpec 1.0 has no native `canvas` field, so
 * `bg.canvas` is sourced from `colorTokens.primary` until a future schema bump
 * introduces a real canvas token):
 *
 *   bg.canvas        <- colorTokens.primary
 *   bg.surface       <- colorTokens.surface
 *   text.primary     <- colorTokens.ink
 *   text.muted       <- colorTokens.muted
 *   action.accent    <- colorTokens.accent
 *   font.heading     <- typographyTokens.heading
 *   font.body        <- typographyTokens.body
 *   font.mono        <- typographyTokens.mono
 *
 * Null `colorTokens` renders every bg/text/action field as "unavailable"; null
 * `typographyTokens` renders every font field as "unavailable". No value is
 * inferred from corpus data.
 *
 * The input MUST be a schema-validated UiSpec 1.0 instance (constructed by
 * `parseDesignHandoff` or `UiSpec.parse`). This function performs no parsing.
 */
export function normalizeSemanticTokens(spec: UiSpecT): SemanticTokens {
  const ct = spec.colorTokens;
  const tt = spec.typographyTokens;

  return {
    bg: {
      canvas: ct ? ct.primary : UNAVAILABLE,
      surface: ct ? ct.surface : UNAVAILABLE,
    },
    text: {
      primary: ct ? ct.ink : UNAVAILABLE,
      muted: ct ? ct.muted : UNAVAILABLE,
    },
    action: {
      accent: ct ? ct.accent : UNAVAILABLE,
    },
    font: {
      heading: tt ? tt.heading : UNAVAILABLE,
      body: tt ? tt.body : UNAVAILABLE,
      mono: tt ? tt.mono : UNAVAILABLE,
    },
  };
}

// ===========================================================================
// 3. Value sanitization — reject injection attempts
// ===========================================================================

/**
 * Characters that let a token value escape its CSS declaration and inject a new
 * rule. We reject any token containing these rather than attempting escape,
 * because CSS has no general escape that is safe for arbitrary value content.
 *
 *  - `\n`, `\r`: line breaks terminate/rewrite declarations.
 *  - `` ` ``:    template-literal / shell escape vector in downstream tooling.
 *  - `;`:        declaration terminator — `#fff;--evil:1` writes a new prop.
 *
 * A raw `;` anywhere in the value is the classic injection vector. We reject it
 * outright; legitimate CSS values (hex, rgb(), color(), font stacks with
 * commas, quotes, spaces, parentheses) never contain a bare `;`.
 */
const FORBIDDEN_CHARS = /[\n\r`;]/;

/**
 * Validate a single token value for safe emission. Throws if the value contains
 * any character that could break out of a CSS declaration. Safe values include
 * hex colors, function calls (rgb, hsl, color()), quoted font stacks with
 * commas and spaces, and the `"unavailable"` sentinel.
 */
function assertSafeTokenValue(value: string, fieldName: string): void {
  if (FORBIDDEN_CHARS.test(value)) {
    throw new Error(
      `renderTokens: token value for "${fieldName}" contains a forbidden character ` +
        `(newline, backtick, or declaration terminator ';'); refusing to emit unsafe CSS`,
    );
  }
}

/** Validate every token value in a SemanticTokens instance before rendering. */
function assertAllSafe(tokens: SemanticTokens): void {
  assertSafeTokenValue(tokens.bg.canvas, "bg.canvas");
  assertSafeTokenValue(tokens.bg.surface, "bg.surface");
  assertSafeTokenValue(tokens.text.primary, "text.primary");
  assertSafeTokenValue(tokens.text.muted, "text.muted");
  assertSafeTokenValue(tokens.action.accent, "action.accent");
  assertSafeTokenValue(tokens.font.heading, "font.heading");
  assertSafeTokenValue(tokens.font.body, "font.body");
  assertSafeTokenValue(tokens.font.mono, "font.mono");
}

// ===========================================================================
// 4. renderCssTokens — stable :root custom properties
// ===========================================================================

/**
 * Render semantic tokens as CSS custom properties under a `:root` selector.
 * Stable, deterministic, byte-identical on repeated calls. The property names
 * are stable (`--bg-canvas`, `--text-primary`, ...) so downstream CSS can
 * reference them regardless of the producing profile.
 *
 * Output shape:
 *
 *   :root {
 *     --bg-canvas: <value>;
 *     --bg-surface: <value>;
 *     --text-primary: <value>;
 *     --text-muted: <value>;
 *     --action-accent: <value>;
 *     --font-heading: <value>;
 *     --font-body: <value>;
 *     --font-mono: <value>;
 *   }
 *
 * Throws if any value contains a forbidden character (newline, backtick, `;`).
 */
export function renderCssTokens(tokens: SemanticTokens): string {
  assertAllSafe(tokens);
  const lines: string[] = [":root {"];
  lines.push(`  --bg-canvas: ${tokens.bg.canvas};`);
  lines.push(`  --bg-surface: ${tokens.bg.surface};`);
  lines.push(`  --text-primary: ${tokens.text.primary};`);
  lines.push(`  --text-muted: ${tokens.text.muted};`);
  lines.push(`  --action-accent: ${tokens.action.accent};`);
  lines.push(`  --font-heading: ${tokens.font.heading};`);
  lines.push(`  --font-body: ${tokens.font.body};`);
  lines.push(`  --font-mono: ${tokens.font.mono};`);
  lines.push("}");
  return lines.join("\n");
}

// ===========================================================================
// 5. renderTailwindTheme — Tailwind v4 @theme variables
// ===========================================================================

/**
 * Render semantic tokens as Tailwind v4 `@theme` variables. Color tokens carry
 * the `--color-` prefix so Tailwind synthesizes `bg-bg-canvas` / `text-text-*`
 * utilities; font tokens use the `--font-` prefix. This emits THEME VARIABLES
 * ONLY — no utility classes, no `@layer`, no `@utility`.
 *
 * Output shape:
 *
 *   @theme {
 *     --color-bg-canvas: <value>;
 *     --color-bg-surface: <value>;
 *     --color-text-primary: <value>;
 *     --color-text-muted: <value>;
 *     --color-action-accent: <value>;
 *     --font-heading: <value>;
 *     --font-body: <value>;
 *     --font-mono: <value>;
 *   }
 *
 * Throws if any value contains a forbidden character (newline, backtick, `;`).
 */
export function renderTailwindTheme(tokens: SemanticTokens): string {
  assertAllSafe(tokens);
  const lines: string[] = ["@theme {"];
  lines.push(`  --color-bg-canvas: ${tokens.bg.canvas};`);
  lines.push(`  --color-bg-surface: ${tokens.bg.surface};`);
  lines.push(`  --color-text-primary: ${tokens.text.primary};`);
  lines.push(`  --color-text-muted: ${tokens.text.muted};`);
  lines.push(`  --color-action-accent: ${tokens.action.accent};`);
  lines.push(`  --font-heading: ${tokens.font.heading};`);
  lines.push(`  --font-body: ${tokens.font.body};`);
  lines.push(`  --font-mono: ${tokens.font.mono};`);
  lines.push("}");
  return lines.join("\n");
}
