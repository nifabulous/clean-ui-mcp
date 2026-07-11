<!-- SPDX-License-Identifier: MPL-2.0 -->
<!-- © 2024 Darlan Rod. Derived from https://github.com/darlanrod/material-design-md -->
<!-- Licensed under the Mozilla Public License 2.0 — see THIRD_PARTY_LICENSES.md -->

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

## Color tokens

MD3 defines a tonal color system where each role maps to a tone (0-100) in a
generated palette. The system is scheme-aware (light/dark) with fixed variants
that stay constant across schemes. MD3's own roles page cites **45 color
roles** in its canonical swatch; counting all `md.sys.color.*` system tokens
(including deprecated `background`/`onBackground`/`surfaceVariant`) totals 49.

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

### Surfaces (tonal elevation — flat-design-friendly)

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

## Type scale (15 baseline tokens)

MD3 uses hand-tuned sizes — there is **no geometric ratio formula** (the
"16px × 1.2^step" generator is a Material Design 2 concept and does not
produce these values). Verified against m3.material.io, Jetpack Compose
(`androidx.compose.material3`), Flutter Material 3, and Material Web CSS.

| Token | Size | Weight | Line height | Tracking |
|---|---|---|---|---|
| `display-large` | 57px | 400 | 64px | -0.25px |
| `display-medium` | 45px | 400 | 52px | 0px |
| `display-small` | 36px | 400 | 44px | 0px |
| `headline-large` | 32px | 400 | 40px | 0px |
| `headline-medium` | 28px | 400 | 36px | 0px |
| `headline-small` | 24px | 400 | 32px | 0px |
| `title-large` | 22px | 400 | 28px | 0px |
| `title-medium` | 16px | 500 | 24px | 0.15px |
| `title-small` | 14px | 500 | 20px | 0.1px |
| `body-large` | 16px | 400 | 24px | 0.5px |
| `body-medium` | 14px | 400 | 20px | 0.25px |
| `body-small` | 12px | 400 | 16px | 0.4px |
| `label-large` | 14px | 500 | 20px | 0.1px |
| `label-medium` | 12px | 500 | 16px | 0.5px |
| `label-small` | 11px | 500 | 16px | 0.5px |

The spec also defines 15 *emphasized* variants (`*.emphasized`) that share
the same sizes and line heights but use bolder variable-font weights. For
sizing and layout, the 15 baseline tokens above are the complete set.

---

## Spacing scale (8dp base grid)

MD3 does not use t-shirt sizing (xs/sm/md/lg/xl). It uses a numbered token
system on an 8dp grid (`spaceN`), where `space100 = 8dp`:

| Token | Value |
|---|---|
| `space0` | 0dp |
| `space50` | 4dp |
| `space100` | 8dp |
| `space150` | 12dp |
| `space200` | 16dp |
| `space250` | 20dp |
| `space300` | 24dp |
| `space400` | 32dp |
| `space500` | 40dp |
| `space600` | 48dp |

Scale continues in 4dp increments. Most components use `space100`–`space300`
(8–24dp) for internal padding.

---

## Shape scale (corner radius)

MD3's canonical corner radius scale from m3.material.io/styles/shape:

| MD3 name | Radius |
|---|---|
| None | 0dp |
| Extra small | 4dp |
| Small | 8dp |
| Medium | 12dp |
| Large | 16dp |
| Large increased | 20dp |
| Extra large | 28dp |
| Full | 50% (stadium/pill) |

---

## Component design tokens

MD3 does not define a flat list of "canonical component tokens." Instead,
each component has its own token namespace (`md.comp.*`) with properties
like `container-color`, `label-text-color`, `container-elevation`,
`state-layer-opacity`. The component catalog includes (non-exhaustive):

**Buttons:** `filled-button`, `tonal-button`, `outlined-button`, `text-button`,
`elevated-button` — each with container/label/state-layer tokens.

**Inputs:** `text-field` (filled + outlined variants) with indicator, label,
supporting-text, and container tokens.

**Containers:** `filled-card`, `outlined-card`, `elevated-card`.

**Other:** `chip` (assist/filter/input/suggestion), `dialog`, `navigation-bar`,
`navigation-rail`, `snackbar`, `tooltip`, `fab`, `menu`, `slider`, `switch`.

Each component defines dozens of properties; consult the spec page for the
specific component when classifying.

### Interactive state layers

| State | Opacity |
|---|---|
| Hover | 8% |
| Focus | 10% |
| Pressed | 10% |
| Dragged | 16% |

State layers are semi-transparent overlays using the `on{Role}` color — they
signal affordance without changing the element's base color.
