# Material Design 3 — Design-System Taxonomy Reference

> Vendored from [darlanrod/material-design-md](https://github.com/darlanrod/material-design-md)
> (`references/material-design-3.md`). Applied as a tagging vocabulary anchor —
> when the tagger observes a tonal color system, elevation hierarchy, or shape
> scale, it can classify it against this structured taxonomy rather than
> describing from scratch.

Material Design 3 (MD3) is Google's named, codified design-system vocabulary.
It provides structured taxonomies for color roles, typography, spacing, shape,
and component tokens — the kind of precise, enumerated vocabulary a screenshot
tagger can reference when classifying real-world UIs.

---

## Color tokens (49-role system)

MD3 defines a tonal color system where each role maps to a tone (0-100) in a
generated palette. The system is scheme-aware (light/dark) with fixed variants
that stay constant across schemes.

### Accent roles (primary / secondary / tertiary)

Each accent group has 4 tokens:

| Token | Purpose |
|---|---|
| `primary` / `secondary` / `tertiary` | The role color itself |
| `on{Primary}` / `on{Secondary}` / `on{Tertiary}` | Text/icon color on the role color |
| `{primary}Container` / etc. | Tinted surface variant |
| `on{Primary}Container` / etc. | Text/icon color on the container |

### Error

`error`, `onError`, `errorContainer`, `onErrorContainer` — same 4-token pattern.

### Surfaces (5 elevation levels, flat-design-friendly)

| Token | Purpose |
|---|---|
| `surfaceContainerLowest` | Deepest surface (insets, wells) |
| `surfaceContainerLow` | Below-content surface |
| `surfaceContainer` | Default container |
| `surfaceContainerHigh` | Raised cards, dialogs |
| `surfaceContainerHighest` | Top layer (snackbars, FABs) |
| `surfaceDim` | Dimmed surface for low-ambient-brightness |
| `surfaceBright` | Bright surface for high-ambient-brightness |

These replace shadow-based elevation in flat designs — depth through tonal
steps rather than drop shadows.

### Outline, inverse, and effects

`outline`, `outlineVariant`, `inverseSurface`, `inverseOnSurface`, `inversePrimary`,
`shadow`, `scrim`, `surfaceTint`.

### Fixed colors (constant across light/dark)

Each accent has fixed variants: `{accent}Fixed`, `{accent}FixedDim`,
`on{accent}Fixed`, `on{accent}FixedVariant`.

### Tonal palette tones

Exposed at: 0, 5, 10, 15, 20, 25, 30, 35, 40, 50, 60, 70, 80, 90, 95, 98, 99, 100.
Scheme-invariant — only the role→tone mapping changes between light and dark.

**Variant:** Tonal Spot (M3 default, most balanced). Contrast level: 0.0.

---

## Type scale (15 levels)

Base: 16px × 1.2^step. Two font families: **titles** (display/headline/title)
and **body** (body/label).

| Token | Step | Size | Weight | Line height |
|---|---|---|---|---|
| `display-large` | +7 | 57px | 400 | 1.1 |
| `display-medium` | +6 | 48px | 400 | 1.1 |
| `display-small` | +5 | 40px | 400 | 1.1 |
| `headline-large` | +4 | 33px | 400 | 1.2 |
| `headline-medium` | +3 | 28px | 400 | 1.2 |
| `headline-small` | +2 | 23px | 400 | 1.2 |
| `title-large` | +1 | 19px | 500 | 1.2 |
| `title-medium` | 0 | 16px | 500 | 1.2 |
| `title-small` | -1 | 13px | 500 | 1.2 |
| `body-large` | 0 | 16px | 400 | 1.5 |
| `body-medium` | -1 | 13px | 400 | 1.5 |
| `body-small` | -2 | 11px | 400 | 1.5 |
| `label-large` | -1 | 13px | 500 | 1.4 |
| `label-medium` | -2 | 11px | 500 | 1.4 |
| `label-small` | -3 | 10px | 500 | 1.4 |

---

## Spacing scale (5 steps, base 16px)

| Token | Size | Multiplier |
|---|---|---|
| `xs` | 4px | ×0.25 |
| `sm` | 8px | ×0.5 |
| `md` | 16px | base |
| `lg` | 24px | ×1.5 |
| `xl` | 48px | ×3 |

---

## Shape scale (6 steps)

| Token | Radius |
|---|---|
| `xs` | 4px |
| `sm` | 8px |
| `md` | 12px |
| `lg` | 16px |
| `xl` | 24px |
| `full` | 9999px |

---

## Component tokens (16 canonical)

Buttons: `button-primary` (+`-hover`/`-pressed`/`-disabled`), `button-secondary`
(+`-hover`), `button-text` (+`-hover`).

Inputs: `input-field` (+`-focused`/`-error`/`-disabled`).

Surfaces: `card`, `chip` (+`-selected`), `tooltip`.

### Interactive states (non-normative properties)

| Property | Values |
|---|---|
| `stateLayerOpacity` | hover 8%, pressed 10%, focus 10%, dragged 16% |
| `backgroundOpacity` | disabled buttons 12%, inputs 4% |
| `textOpacity` | disabled 38% |

State layers are semi-transparent overlays on interactive elements — they
signal affordance without changing the element's base color.
