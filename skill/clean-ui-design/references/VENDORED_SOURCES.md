# Vendored Source Manifest

This file records the upstream origin, commit SHA, and license for each
piece of third-party content vendored into the repository. It exists so
that any drift between the vendored copy and upstream is auditable.

Update the `Snapshot SHA` when re-syncing from upstream.

---

## skill/clean-ui-design/references/material-design-3.md

| Field | Value |
|---|---|
| Upstream repo | [darlanrod/material-design-md](https://github.com/darlanrod/material-design-md) |
| Snapshot SHA | `8cdbaf58a00532490710bb88710e68c289ac75af` (HEAD as of 2026-07-10) |
| License | MPL-2.0 ([full text](../../LICENSES/MPL-2.0.txt)) |
| Local modifications | Yes — type scale, color roles, spacing, shape, and component sections corrected against canonical m3.material.io values (original source had fabricated geometric formula and inaccurate values) |
| Canonical verification source | [m3.material.io/styles/typography/type-scale-tokens](https://m3.material.io/styles/typography/type-scale-tokens), [m3.material.io/styles/color/roles](https://m3.material.io/styles/color/roles), [m3.material.io/styles/shape/corner-radius-scale](https://m3.material.io/styles/shape/corner-radius-scale) |
| Cross-checked against | Jetpack Compose (`androidx.compose.material3`), Flutter Material 3, Material Web CSS |

## skill/clean-ui-design/references/design-engineering.md

| Field | Value |
|---|---|
| Upstream repo | [emilkowalski/skills](https://github.com/emilkowalski/skills) |
| Snapshot SHA | `220e8607c90b17337d210125777b7b695f26c221` (HEAD as of 2026-07-10) |
| License | MIT |
| Local modifications | Yes — reformatted from skill-prompt format to reference-document format; content adapted for clean-ui-mcp synthesis context |

## skill/clean-ui-design/references/banned-phrases.md (Visual slop section)

| Field | Value |
|---|---|
| Upstream repo | [educlopez/ui-craft](https://github.com/educlopez/ui-craft) |
| Snapshot SHA | `2ad8124987501096b84bf85d0dc710f3e8cc1c48` (HEAD as of 2026-07-10) |
| License | MIT |
| Local modifications | Yes — merged into existing banned-phrases.md as a new section; restructured into Critical/Major/Minor severity tiers |

## src/wcag/wcag-2.2.ts

| Field | Value |
|---|---|
| Upstream source | [W3C WCAG 2.2 machine-readable export](https://www.w3.org/WAI/WCAG22/wcag.json) |
| Upstream repo | [w3c/wcag](https://github.com/w3c/wcag) |
| Snapshot SHA | `8d1a2b09e72d36eee6e28ee68bb843f741590091` |
| Snapshot date | 2026-07-09 |
| License | [W3C Document License](https://www.w3.org/copyright/document-license/) |
| Local modifications | Yes — filtered to 86 active criteria (4.1.1 Parsing excluded as obsolete); TypeScript interface added |

---

## Re-syncing

To check if upstream has changed since the snapshot:

```bash
git ls-remote https://github.com/darlanrod/material-design-md.git HEAD
git ls-remote https://github.com/emilkowalski/skills.git HEAD
git ls-remote https://github.com/educlopez/ui-craft.git HEAD
```

Compare against the `Snapshot SHA` above. If they differ, review the upstream
changes, re-vendor (applying local modifications), update the SHA, and commit.
