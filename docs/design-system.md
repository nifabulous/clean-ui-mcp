# Design System — Shared Token and Interaction Contract

> **Status:** Single source of truth. Both the public React application (`site/`) and the curator dashboard implement the contract recorded here. Changes to any token, scale, focus rule, motion value, or state convention MUST be made in this document first and then reflected in both applications' CSS custom properties or equivalent rules.
>
> **Authority:** Unified Product Experience Redesign design (`docs/superpowers/specs/2026-07-18-unified-product-experience-redesign-design.md`), §3.3 (shared product system), §5 (visual direction), §10 (accessibility), §11 (motion). WCAG 2.2 AA is the minimum quality bar.

## 1. Scope and consumers

This contract governs presentation primitives that the public site and the curator dashboard must render identically:

- Color and theme tokens (light and dark).
- Typography stack and hierarchy.
- Spacing and layout rhythm.
- Radii, borders, and elevation.
- Focus and interaction states.
- Loading, empty, error, success, and disabled (semantic) states.
- Motion and reduced-motion behavior.
- Copy terminology and content hierarchy.

The two applications do NOT share runtime components. Each ships its own CSS that consumes the custom property names recorded here. A property name in this document is normative: if the public app names a token `--focus`, the dashboard must use the same name with the same per-theme value.

## 2. Theme tokens

Themes are applied by setting `document.documentElement.dataset.theme` to `"light"` or `"dark"` before first paint. The token values below are the EXACT values from `site/src/styles/tokens.css` and are the canonical cross-app values.

### 2.1 Token names (shared)

| Token | Role |
|---|---|
| `--canvas` | App background. Pale cool canvas in light; near-black neutral in dark. |
| `--surface` | Card / panel fill. |
| `--surface-raised` | Elevated panel fill (modals, dropdowns, raised cards). |
| `--ink` | Primary text. |
| `--ink-muted` | Secondary / supporting text. |
| `--border` | Hairline borders and dividers. |
| `--focus` | Focus ring color and interactive link accent. |
| `--success` | Positive semantic state (never the brand accent). |
| `--warning` | Caution semantic state. |
| `--danger` | Destructive / error semantic state. |
| `--radius-sm` | Small corner radius (inputs, chips, small controls). |
| `--radius-md` | Medium corner radius (buttons, cards). |
| `--radius-lg` | Large corner radius (modals, hero panels). |

### 2.2 Light theme

Selector: `:root, :root[data-theme="light"]`

| Token | Value |
|---|---|
| `--canvas` | `#f3f6fb` |
| `--surface` | `#ffffff` |
| `--surface-raised` | `#f8fafc` |
| `--ink` | `#0b2348` |
| `--ink-muted` | `#637089` |
| `--border` | `#dbe3ef` |
| `--focus` | `#2457d6` |
| `--success` | `#287a4d` |
| `--warning` | `#986515` |
| `--danger` | `#b33a2b` |
| `--radius-sm` | `6px` |
| `--radius-md` | `10px` |
| `--radius-lg` | `16px` |

The light canvas is a pale cool architectural tone, never plain white. Faint architectural linework frames content but must not cross critical copy or controls. There is no inherited green brand accent.

### 2.3 Dark theme

Selector: `:root[data-theme="dark"]`

| Token | Value |
|---|---|
| `--canvas` | `#111113` |
| `--surface` | `#19191c` |
| `--surface-raised` | `#222226` |
| `--ink` | `#f4f4f5` |
| `--ink-muted` | `#a1a1aa` |
| `--border` | `#34343a` |
| `--focus` | `#a8c7ff` |
| `--success` | `#78a887` |
| `--warning` | `#d2a455` |
| `--danger` | `#e17a6b` |

Dark mode is a true neutral charcoal interface. The canvas is near-black; raised surfaces are neutral charcoal. There is no navy, violet, green, or neon tint applied to the base theme. Corpus screenshots supply most of the color. Per the gallery principle, the canvas recedes while authentic showcased work carries visual energy.

### 2.4 Theme behavior

- Default to `prefers-color-scheme` when no explicit choice exists.
- Persist an explicit theme choice in `localStorage` under the key `clean-ui-theme` (values: `"light"` or `"dark"`).
- Apply the resolved theme before first paint to prevent a flash of the wrong theme (see the inline bootstrap in `site/index.html`).
- Layout, information hierarchy, and semantic meaning are identical between themes.
- Semantic status colors are validated independently in each theme; status is never communicated by color alone (always pair with text or icon).

### 2.5 Curator dashboard implementation notes

The curator dashboard (`index-2.html` + `ui/styles.css` + `ui/app.js`, a vanilla-JavaScript hash-routed SPA) consumes the §2.1 token contract via its own CSS custom properties. It does NOT share runtime code with the public React app; only the token names and per-theme values are shared. The notes below record how the curator maps its legacy token names onto the shared contract so incremental module migration (Tasks 2-5 of the redesign plan) does not break.

**Token name mapping.** The curator CSS declares the §2.2/§2.3 values under both the canonical names and the legacy aliases its existing selectors already use:

| Curator CSS token | Maps to (shared) | Notes |
|---|---|---|
| `--canvas`, `--surface`, `--ink`, `--focus`, `--pos`, `--warn`, `--neg` | same names | Identical name and value to the contract. |
| `--surface-2` | `--surface-raised` | Legacy alias for the raised-surface fill. |
| `--ink-2` | `--ink-muted` | Legacy alias for secondary text. |
| `--muted` | `--ink-muted` | Legacy alias; retained because existing selectors read `--muted`. |
| `--hairline`, `--hairline-2` | `--border` | Legacy aliases for 1px hairline borders. |
| `--pos-soft`, `--warn-soft`, `--neg-soft` | semantic soft fills | Subtle tinted fills paired with the matching status text/icon (never the sole signal). |
| `--accent` (DEPRECATED) | `--focus` | Was the warm-editorial teal brand color. Aliased to `--focus` for this task because the legacy CSS used `--accent` for BOTH emphasis and focus rings — aliasing to `--focus` preserves WCAG-visible focus everywhere it appeared. New selectors MUST use `--ink` (emphasis) or `--focus` (links/focus); do not reference `--accent`. |
| `--accent-soft`, `--accent-2` (DEPRECATED) | `--surface-2`, `--focus` | Soft highlight and darker-accent aliases, retained only so un-migrated selectors keep rendering neutral. |

The dark `--canvas` is asserted by browser test to equal `#111113` exactly, so any drift toward a navy/violet/green/neon tint fails loudly (spec §5.3).

**Pre-paint resolver.** `index-2.html` carries the same synchronous resolver the public site uses (`site/index.html`), placed before the stylesheet link so there is no flash of the wrong theme. It reads the `clean-ui-theme` localStorage key and falls back to `prefers-color-scheme`.

**Runtime controller — `window.cleanUiTheme`.** `ui/app.js` exposes a testable controller on `window`:

- `getTheme()` — pure; returns the active `"light"` / `"dark"`.
- `setTheme(theme)` — writes `clean-ui-theme` to localStorage, sets `documentElement.dataset.theme`, updates the toggle's accessible name, and unsubscribes from OS `prefers-color-scheme` changes (an explicit choice wins from then on).
- `clearTheme()` — removes the localStorage key, re-resolves from the OS immediately, and re-subscribes to OS changes.

The toggle button (`#themeToggle` in the top bar) has an accessible name that describes the action it performs ("Switch to dark theme" / "Switch to light theme"). OS preference is followed ONLY while no explicit local choice exists.

## 3. Typography

Strong modern sans-serif hierarchy drives all surfaces. A restrained editorial italic is used ONLY for selected headline phrases — never for body copy or UI chrome.

### 3.1 Sans-serif stack

```
system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial,
"Apple Color Emoji", "Segoe UI Emoji", sans-serif
```

The preferred family is Inter where available; otherwise the system stack is used. The public site sets this on `html`. Both applications MUST use the same stack so text rendering is consistent.

### 3.2 Editorial italic

For selected headline phrases only, a serif or transitional italic may be applied (e.g. `"Iowan Old Style", "Palatino Linotype", Palatino, "Hoefler Text", Georgia, serif`, italic). It is reserved for emphasis within a single headline; it is never used for paragraphs, labels, or buttons.

### 3.3 Hierarchy baseline

| Role | Relative weight | Notes |
|---|---|---|
| H1 (page) | 600–700, largest | One per page. |
| H2 (section) | 600 | Section leads. |
| H3 (subsection) | 600 | Card / block leads. |
| Body | 400 | Base size 16px, line-height 1.5. |
| Supporting / muted | 400, `--ink-muted` | Captions, metadata. |

Base body size is `16px` with a `1.5` line height. Body text uses `--ink`; supporting text uses `--ink-muted`. Logical heading order is required (no skipped levels).

## 4. Spacing scale

Spacing uses a fixed 4px-based scale. Applications MUST consume these steps; arbitrary one-off values are not permitted.

| Token step | Value |
|---|---|
| `space-1` | `4px` |
| `space-2` | `8px` |
| `space-3` | `12px` |
| `space-4` | `16px` |
| `space-6` | `24px` |
| `space-8` | `32px` |
| `space-12` | `48px` |
| `space-16` | `64px` |

These map to layout rhythm: `space-1`/`space-2` for inline gaps, `space-3`/`space-4` for component padding, `space-6`/`space-8` for section gutters, and `space-12`/`space-16` for page-level vertical rhythm.

## 5. Radii, borders, and elevation

### 5.1 Radii

The radius scale is fixed and shared. These are the EXACT values from `tokens.css`.

| Token | Value | Use |
|---|---|---|
| `--radius-sm` | `6px` | Inputs, chips, small controls. |
| `--radius-md` | `10px` | Buttons, cards. |
| `--radius-lg` | `16px` | Modals, hero panels, large containers. |

### 5.2 Borders

Use crisp 1px hairline borders colored with `--border`. Avoid heavy borders. Dividers between content blocks use the same `--border` color at 1px.

### 5.3 Elevation

Elevation is minimal and crisp. Prefer borders over shadows. Where a shadow is required, it is subtle and theme-aware: a single low-spread shadow that does not introduce color tint. Raised surfaces (`--surface-raised`) handle most elevation through fill color, not heavy shadow.

## 6. Focus and interaction states

### 6.1 Focus ring (normative)

The visible focus indicator for every interactive element is:

```css
box-shadow: 0 0 0 3px color-mix(in srgb, var(--focus) 35%, transparent);
```

This expression is mandatory for keyboard focus on all interactive controls in both applications. It produces a 3px translucent halo tinted by the theme's `--focus` token. The translucent mix keeps the ring legible without overpowering adjacent content. Focus MUST be visible in both light and dark themes.

The default user-agent `:focus-visible` outline may be removed only when this `box-shadow` ring is applied in its place. Focus indication MUST never be removed without a documented replacement.

### 6.2 Interaction states

Every interactive element defines all of:

- **Rest** — base appearance using `--surface` / `--ink` / `--border`.
- **Hover** — a subtle surface or border shift. No hover-only actions exist (every hover affordance has a keyboard equivalent).
- **Focus-visible** — the §6.1 focus ring.
- **Active/pressed** — a slightly darker surface or inset treatment.
- **Disabled** — `--ink-muted` fill, `not-allowed` cursor, and `aria-disabled` or the native `disabled` attribute; the §6.1 focus ring is NOT shown for disabled controls.

### 6.3 Touch targets

Primary mobile controls present a minimum `44px × 44px` hit target. This applies to all nav items, the theme control, buttons, filter chips, and copy actions on touch surfaces.

## 7. Semantic states

Every asynchronous surface implements loading, empty, error, success, and disabled states. State is NEVER communicated by color alone; each state pairs its semantic color with an icon or text label.

| State | Token | Required accompanying signal |
|---|---|---|
| Success | `--success` | Confirmation text and/or a check icon. |
| Warning | `--warning` | Caution text describing the risk. |
| Error / destructive | `--danger` | Error message and recovery guidance. |
| Loading | n/a (use a spinner or skeleton) | Non-blocking indication; reduced-motion safe. |
| Empty | `--ink-muted` text | Explains the empty state and offers a next action. |
| Disabled | `--ink-muted` | `aria-disabled`/`disabled`; no focus ring. |

Failed images render a structured wireframe fallback, never a broken-image icon. Failed searches preserve the query and filters. One failed asset never blanks other content.

## 8. Motion

Motion explains state and hierarchy; it never decorates scroll position.

| Duration | Use |
|---|---|
| `150ms` | Disclosure toggles, button feedback, hover transitions, filter chip state. |
| `250ms` | Drawers, mobile menu, dialogs, theme-sensitive surface transitions. |

Easing should be a neutral ease (`cubic-bezier(0.4, 0, 0.2, 1)` or `ease`). The following are prohibited:

- Scroll-jacking.
- Autoplay video.
- Continuous background animation.
- Decorative parallax.
- Layout-shifting entrance animations.

### 8.1 Reduced motion

A user request for reduced motion (`prefers-reduced-motion: reduce`) MUST disable all nonessential transitions. The required behavior:

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
    scroll-behavior: auto !important;
  }
}
```

Essential state communication (e.g. content swap feedback) remains, but delivered without movement. Theme switching, menu open/close, and disclosure changes become instantaneous.

## 9. Copy terminology and content hierarchy

Consistent vocabulary across both applications:

- **Primary action** — the single most important action on a view (e.g. "Try Playground", "Save entry"). Visually distinct.
- **Secondary action** — supporting actions (e.g. "Install MCP", "Cancel"). Lower visual weight.
- **Destructive action** — requires confirmation and states its scope (e.g. "Delete entry").
- **Loading** — "Loading…" or a labelled spinner; never silent.
- **Empty** — describes the state and offers a next step (e.g. "No results — try removing a filter.").
- **Error** — plain-language cause and recovery (e.g. "Couldn't load the snapshot. Retry.").

Heading order is logical and starts at H1 per page. Page titles are unique and descriptive. Link and button text is descriptive out of context (no bare "click here").

## 10. Verification

Each application verifies this contract independently:

- Light/dark contrast checks against the §2 values.
- Keyboard-only walkthroughs confirming the §6.1 focus ring renders on every interactive control.
- 44px target check on the agreed mobile profile.
- Reduced-motion check confirming §8.1 disables nonessential transitions.
- axe checks on representative routes and states, targeting WCAG 2.2 AA.

Token values in this document MUST match `site/src/styles/tokens.css` exactly. If a value changes, change it here first, then in both applications' CSS.
