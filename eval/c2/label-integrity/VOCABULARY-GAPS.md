# Vocabulary-gap audit — AI expert draft, 2026-07-25

Produced by four expert-taxonomist agents labeling all 40 selected entries against
the closed vocabulary in `packet/VOCABULARY.md`, instructed to pick the nearest
value and flag every case where no option was genuinely right.

**Update 2026-07-25 (later):** The high-frequency gaps (2+ entries) have been
applied to the vocabulary. Added to `patternType` (§1): `gallery`, `interstitial`
(with definitions in §6f). Added to `components` (§3): `avatar`, `avatar-group`,
`badge`, `banner`, `bottom-nav`, `carousel`, `checklist`, `cta-button`, `drawer`,
`illustration`, `list-row`, `primary-button`, `progress-bar`, `search-input`,
`stepper`, `toggle-switch` (16 values). The 1-entry proposals remain unadded
(judgement calls, not structural holes). The `categories: modal` contradiction
was already editorially resolved in §6a. The updated vocabulary is the stable
baseline for the two fresh reviewer passes.

**92 flags across 40 entries, 51 distinct proposals.**

Distinct proposals per field: categories 1, components 40, patternType 9, layout 1.

Evidence strength here is one labeling pass, not two independent reviewers, so the
`entries` column is the signal: a value wanted on many distinct screens is a real
hole, a one-off may be a judgement call. Re-run `summarize-gaps.mjs` once the human
reviewers return to get true cross-reviewer convergence.

| Field | Proposed value | Entries |
|---|---|---|
| `categories` | `modal` | 8 |
| `components` | `avatar` | 7 |
| `components` | `list-row` | 7 |
| `components` | `badge` | 3 |
| `components` | `banner` | 3 |
| `components` | `carousel` | 3 |
| `components` | `illustration` | 3 |
| `components` | `stepper` | 3 |
| `components` | `toggle-switch` | 3 |
| `patternType` | `interstitial` | 3 |
| `components` | `bottom-nav` | 2 |
| `components` | `checklist` | 2 |
| `components` | `cta-button` | 2 |
| `components` | `drawer` | 2 |
| `components` | `primary-button` | 2 |
| `components` | `progress-bar` | 2 |
| `components` | `search-input` | 2 |
| `patternType` | `gallery` | 2 |
| `components` | `action-bar` | 1 |
| `components` | `alert-banner` | 1 |
| `components` | `avatar-group` | 1 |
| `components` | `bottom-sheet` | 1 |
| `components` | `button` | 1 |
| `components` | `callout` | 1 |
| `components` | `callout-banner` | 1 |
| `components` | `checkbox` | 1 |
| `components` | `checkbox-list` | 1 |
| `components` | `date-picker` | 1 |
| `components` | `detail-rail` | 1 |
| `components` | `dropdown-menu` | 1 |
| `components` | `feature-list` | 1 |
| `components` | `file-upload` | 1 |
| `components` | `icon-rail` | 1 |
| `components` | `inline-validation` | 1 |
| `components` | `pagination` | 1 |
| `components` | `payment-card` | 1 |
| `components` | `phone-input` | 1 |
| `components` | `playback-controls` | 1 |
| `components` | `preview-pane` | 1 |
| `components` | `promo-card` | 1 |
| `components` | `quick-action-chip` | 1 |
| `components` | `scroll-cue` | 1 |
| `components` | `slider` | 1 |
| `layout` | `card-row` | 1 |
| `patternType` | `article` | 1 |
| `patternType` | `avatar-customizer` | 1 |
| `patternType` | `coach-mark` | 1 |
| `patternType` | `detail-view` | 1 |
| `patternType` | `marketplace` | 1 |
| `patternType` | `media-player` | 1 |
| `patternType` | `resource-index` | 1 |

## Already resolved

`categories` / `modal` (8 entries) is not a taxonomy hole — it was a contradiction in
VOCABULARY.md §6a, which told reviewers to put `modal` in `categories` when that value
exists only in the patternType list. The agents were right to flag it. §6a is fixed:
the overlay is recorded by `patternType: modal` plus `modal-dialog` in `components`.
Expect this flag to disappear on the human pass.

## Reading the rest

The heavy hitters are structural primitives the corpus taxonomy simply lacks —
`avatar` and `list-row` (7 entries each), then `badge`, `banner`, `carousel`,
`illustration`, `stepper`, `toggle-switch` (3 each). `bottom-nav` appears despite 17
mobile screens in the set, which understates it: reviewers had `tab-nav` to fall back on.

Adding any of these changes the vocabulary. Do not apply mid-labeling. Note the
direction: `components-recall` has no fixed floor, so widening `components` lowers its
baseline and loosens that gate.
