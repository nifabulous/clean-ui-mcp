# Web Design Target Profiles

> **Status:** Adapter contract for rendering one validated `UiSpec` 1.0 artifact into a web handoff. This document defines which web target profiles are supported, how each field is selected independently, and how unsupported combinations fail closed.
>
> **Authority:** Web Design Target Profiles and Deterministic Handoff Adapters plan (`docs/superpowers/plans/2026-07-22-web-design-adapters.md`). Source code: `src/design-target-contracts.ts`, `src/design-adapter-registry.ts`, `src/design-handoff.ts`.
>
> **Handoff version:** `web-1.0` (separately versioned from the `UiSpec` envelope, which remains at `specVersion: "1.0"`).

## 1. Canonical model

`UiSpec` 1.0 is the semantic source of truth. `DESIGN.md` and the JSON handoff are *derived* renderings produced by deterministic, offline, pure functions. The web target profile is NOT part of `UiSpec`; it is a renderer concern expressed through a separately versioned `DesignHandoff` envelope (`handoff_version: "web-1.0"`).

This boundary is intentional:

- An omitted target means **neutral web**. It never silently becomes React.
- The handoff envelope is a renderer concern until a future contract checkpoint approves embedding profiles directly in `UiSpec`. Such a change requires a `UiSpec` schema-version bump, contract-checkpoint sign-off, and refreshed tool fixtures and catalog digests.
- No profile is inferred from prose. The legacy `generate_design_prompt` brief and tokens output is unchanged when no target is supplied.

## 2. Supported target IDs

Exactly three target IDs are supported in this slice. Any other value fails closed.

| Target ID | Site framework | UI runtime | Typical use |
|---|---|---|---|
| `neutral-web` | `none` | `none` | Static HTML + CSS. No host framework, no UI runtime, no island strategy. |
| `astro-react` | `astro` | `react` | Astro host with React islands. React-compatible component libraries are permitted. |
| `astro-vue` | `astro` | `vue` | Astro host with Vue islands. Native HTML or custom components only. |

`neutral-web` is the fallback profile. If a caller hands the renderer a `UiSpec` without specifying a target, neutral web is the only legal interpretation. React is NEVER an implicit default.

Native runtimes (e.g. `swiftui`, `android-compose`, `flutter`) are explicitly rejected. Native adapters are a separate workstream and remain out of scope.

## 3. Independent choices

A web target profile is composed of six independent fields. Each is a separate decision — picking one does not constrain another at the schema level, but the capability registry enforces compatibility (see §5).

| Field | Values | Notes |
|---|---|---|
| `siteFramework` | `none`, `astro` | Astro is the only supported host. `none` is required for `neutral-web`. |
| `runtime` | `none`, `react`, `vue` | UI runtime, modeled separately from the site framework. `none` is required for `neutral-web`. |
| `styling` | `vanilla-css`, `tailwind`, `css-modules` | Determines whether `DESIGN.md` emits `:root` CSS custom properties or a Tailwind v4 `@theme` block. |
| `componentSource` | `native-html`, `custom`, `shadcn`, `kumo`, `base-ui`, `radix`, `react-aria`, `mui` | shadcn, kumo, base-ui, radix, react-aria, and mui are React-only. `astro-vue` rejects them. |
| `motion` | `css`, `view-transitions`, `css-view-transitions`, `vue-transition`, `motion`, `gsap` | JS motion runtimes (`motion`, `gsap`) are rejected under `neutral-web` and `astro-vue`. `vue-transition` is rejected under `neutral-web` and `astro-react`. |
| `islandStrategy` | `null` or a directive string (e.g. `client:load`, `client:idle`, `client:visible`) | Required (non-null) for `astro-react` and `astro-vue`. Must be `null` for `neutral-web`. |

Package dependencies listed in the handoff always use `versionPolicy: "exact"` with concrete published versions — never `latest`. Target compatibility ranges (e.g. `astro@5.x`, `vue@3.x`) use `versionPolicy: "range"`. Browser APIs and platform features use `versionPolicy: "unversioned"` with the literal suffix `@unversioned`.

## 4. Examples

### 4.1 Astro + React (Tailwind, shadcn/ui, Motion)

```yaml
id: astro-react
platform: web
siteFramework: astro
runtime: react
styling: tailwind
componentSource: shadcn
motion: motion
islandStrategy: client:load
```

Rendered frontmatter:

```yaml
spec_version: "1.0"
handoff_version: "web-1.0"
target_profile: "astro-react"
platform: "web"
site_framework: "astro@5.x"
site_framework_version_policy: "range"
ui_runtime: "react@19.x"
ui_runtime_version_policy: "range"
styling: "tailwind@4.x"
styling_version_policy: "range"
component_source: "shadcn@unversioned"
motion: "motion@unversioned"
```

Install dependencies are emitted with exact pins (e.g. `astro@5.7.10`, `react@19.2.0`, `react-dom@19.2.0`, `@astrojs/react@4.2.1`, `tailwindcss@4.0.0`, `motion@12.4.7`). The implementation section includes the island strategy subsection and React-compatible component guidance.

### 4.2 Astro + Vue (Tailwind, custom components, Vue Transition)

```yaml
id: astro-vue
platform: web
siteFramework: astro
runtime: vue
styling: tailwind
componentSource: custom
motion: vue-transition
islandStrategy: client:load
```

Rendered frontmatter:

```yaml
spec_version: "1.0"
handoff_version: "web-1.0"
target_profile: "astro-vue"
platform: "web"
site_framework: "astro@5.x"
site_framework_version_policy: "range"
ui_runtime: "vue@3.x"
ui_runtime_version_policy: "range"
styling: "tailwind@4.x"
styling_version_policy: "range"
component_source: "custom@unversioned"
motion: "vue-transition@unversioned"
```

The Vue target uses native HTML or custom components only. The motion guidance section references `<Transition>` (enter/exit) and `<TransitionGroup>` (list changes) with a `prefers-reduced-motion` fallback. No React-only component library ever appears as a recommendation.

### 4.3 Neutral web (no framework, no runtime)

```yaml
id: neutral-web
platform: web
siteFramework: none
runtime: none
styling: vanilla-css
componentSource: native-html
motion: css
islandStrategy: null
```

The output emits `:root` CSS custom properties (`--bg-canvas`, `--bg-surface`, `--text-primary`, `--text-muted`, `--action-accent`, `--font-heading`, `--font-body`, `--font-mono`). The implementation section omits the island strategy subsection entirely and never references React, Astro, Tailwind, or any JS motion runtime.

## 5. Unsupported-combination behavior (fail closed)

The renderer fails closed — it never silently substitutes a different profile or infers a missing field. `parseDesignHandoff` rejects malformed shapes at the schema level; `resolveWebTarget` (called by `buildDesignHandoff`) rejects legal shapes with incompatible combinations. The following inputs throw:

- Unknown `id`, unknown `siteFramework`, unknown `runtime`, unknown `styling`, unknown `componentSource`, unknown `motion`.
- Native platform values (e.g. `platform: "swiftui"`, `runtime: "flutter"`).
- `neutral-web` with any non-`none` site framework or runtime.
- `neutral-web` with a non-null `islandStrategy`.
- `neutral-web` with a React-only `componentSource` (shadcn, kumo, base-ui, radix, react-aria, mui).
- `neutral-web` with a JS motion runtime (`motion`, `gsap`) or `vue-transition`.
- `astro-react` without `siteFramework: "astro"` and `runtime: "react"`.
- `astro-vue` without `siteFramework: "astro"` and `runtime: "vue"`.
- `astro-react` or `astro-vue` with a null or empty `islandStrategy`.
- `astro-vue` with a React-only `componentSource`.
- `astro-vue` with a JS motion runtime (`motion`, `gsap`).
- A `motionIntents` array entry without a non-empty `reducedMotion` fallback.
- A captured source without a 64-character lowercase SHA-256, or a not-captured source without a reason.
- A package dependency with `versionPolicy: "range"` (ranges are reserved for target compatibility).

Producers MUST call `buildDesignHandoff(input)` (the only integration entry point) and MUST NOT construct `DesignHandoffT` directly. The brand on `DesignHandoffT` is an opaque, non-exported symbol that prevents ad-hoc object literals from satisfying the type.

## 6. Source provenance

Every consulted documentation source is one of the seven checked-in entries in `src/design-source-registry.ts`:

- `astro-official`, `vue-official`, `tailwind-official`, `shadcn-official`, `kumo-official` (MIT documentation).
- `transitions-dev`, `21st-community` (community catalogs; license `unknown`).

In this slice every entry is `not-captured` with the fixed reason `source bytes are not vendored`. URLs are preserved as provenance pointers; source bytes are never copied into `DESIGN.md` or the JSON handoff. A later source-snapshot task may promote an entry to `captured` only when bytes and a verified SHA-256 are checked in. No hash may be fabricated.

## 7. Adapter boundary with the workspace spec

The Grounded Design Workspace spec (`docs/superpowers/specs/2026-07-18-grounded-design-workspace-design.md`) treats `UiSpec` 1.0 as canonical and `DESIGN.md` as its deterministic rendering. The web adapter layer introduced here adds one derived concern: the same validated `UiSpec` can be rendered for `neutral-web`, `astro-react`, or `astro-vue` without changing the `UiSpec` bytes. The adapter plan's full file map and self-review live at `docs/superpowers/plans/2026-07-22-web-design-adapters.md`.

## 8. Relationship to the integration API

`buildDesignHandoff(input: DesignHandoffInput): DesignHandoffT` is the concrete producer-facing integration function exported from `src/design-handoff.ts`. A future `create_ui_spec` producer must call it after producing a schema-valid `UiSpec` and a structured `MotionIntent[]`; it must not construct `DesignHandoffT` directly. The legacy `generate_design_prompt` MCP tool is unchanged by this adapter layer — brief and tokens output remains identical when no target is supplied.

A future public `handoffProfileId` exposed through the tool contract requires a separate contract-checkpoint change with tool fixtures and catalog digest updates. It is not introduced by this slice.
