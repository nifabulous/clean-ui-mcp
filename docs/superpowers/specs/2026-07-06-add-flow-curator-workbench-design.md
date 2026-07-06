# Add Flow Curator Workbench Design

Date: 2026-07-06

## Goal

Redesign the `#/add` flow so it feels native to clean-ui's corpus console: an evidence-first curator workbench rather than a generic step wizard. The flow should make screenshot selection, auto-fill progress, review, and save decisions calmer and more obvious while preserving the existing capture/upload/tag/save pipeline.

## Context

The current add flow already supports:

- URL capture and image upload through the shared `draft` object.
- Multi-candidate capture via `_candidates`, `_selectedCandidates`, and `_candidateStatus`.
- Bulk auto-fill and commit through `autoFillCandidates()` and `commitCandidates()`.
- Single-candidate review through `reviewCandidate()` and `saveDraft()`.

The redesign should change the interaction and presentation layer, not replace these mechanics. Capture triage, upload, and edit depend on the same draft shape, so the implementation must keep those contracts intact.

## Recommended Approach

Use a two-column "Curator Workbench" layout.

The left column is the artifact area. It starts with a compact source strip for capture vs upload, then gives most of the page to screenshots: candidate grid, active image preview, and image metadata. This keeps the curator focused on the source evidence before deciding whether AI-generated metadata is good enough.

The right column is the session rail. It summarizes state and offers the next primary session action: select, auto-fill, review, or bulk commit. It also shows counts for selected, tagged, saved, and issues. This consolidates actions that are currently scattered below candidate grids and status tables.

The rail owns bulk/session actions; the review sheet owns single-draft save. When a candidate is loaded with `reviewCandidate(index)`, the rail should shift to session context: `Back to queue`, candidate position, remaining tagged/saved/issues, and optional `Commit all tagged` if other tagged candidates exist. The active review sheet should contain the single `Save entry` button. This prevents competing terminal CTAs.

## User Experience

The default empty state asks for a source, but it should not look like a blank form. It should present capture and upload as equal input modes, with the URL input selected by default because that is the richer Corpus path.

After URL capture, the candidate grid becomes the main surface. Candidate cards should read as corpus specimens:

- Large top-aligned thumbnails.
- Mono source/candidate identifiers.
- A checkbox as the primary selection control; the selected border is only the visual consequence of that checkbox state.
- Icon-only preview control with an `aria-label` and title on desktop; at narrow widths, use an always-visible text label if the icon alone is ambiguous.
- No nested cards or decorative wrappers.

When auto-fill starts, progress should stay visible in the session rail and the candidate status list. Status labels should use corpus language where possible: `pending`, `tagging`, `tagged`, `saved`, `duplicate`, `error`, `skipped`.

When reviewing one candidate, the screenshot remains visible and prominent. The metadata review area should prioritize human judgment:

- Title.
- Product name.
- Quality score.
- Quality tier or review status.
- Critique.

Auto-detected classification fields (`patternType`, categories, style tags, platform) should be visible but secondary as a compact classification block inside the review sheet.

## Visual System

The add flow must reuse the dashboard's established identity instead of introducing a new product skin.

- `add-workbench`: use `--canvas` for the page background, `--surface` for bounded working areas, `--hairline` and `--hairline-2` for structure, and no decorative shadows.
- `source-strip`: use Archivo labels, IBM Plex Mono for URLs/slugs, and petrol teal (`--accent`) only for the active segment, focused input, and primary action.
- `candidate-specimen`: use IBM Plex Mono for candidate identifiers, top-aligned thumbnails, `--hairline` for default borders, and petrol teal border/outline only when selected.
- `add-session-rail`: use `--surface`, sticky positioning, small Archivo labels, IBM Plex Mono numeric tallies, and existing badge/status colors for state.
- `review-sheet`: use Fraunces only for section headings, Archivo for labels and body fields, IBM Plex Mono for IDs/classification data, and the existing cautionary rubber-stamp pill style for cautionary tier display.

## Component Design

Add these UI concepts within the existing vanilla JS/CSS structure:

- `add-workbench`: page-level two-column layout for the add flow.
- `add-artifact`: left artifact column containing source strip, candidates, active image, and status table.
- `add-session-rail`: sticky right rail containing state, tallies, errors, and primary actions.
- `source-strip`: compact segmented capture/upload control plus current input.
- `candidate-specimen`: redesigned candidate card using existing candidate data and image endpoint.
- `review-sheet`: editorial metadata form for an active image or candidate.

The implementation can be plain template strings in `ui/app.js` and CSS in `ui/styles.css`, matching the existing SPA pattern.

## Data Flow

No schema or server changes are required.

The redesign must continue to use:

- `wizardCapture(form)` for URL capture.
- `wizardUpload(file)` for image upload.
- `wizardAutoTag()` for single-image auto-fill.
- `autoFillCandidates()` for selected multi-candidate tagging.
- `commitCandidates()` for bulk commit.
- `reviewCandidate(index)` for loading a tagged candidate into the review form.
- `saveDraft()` for final single-entry save.

Rendering can be reorganized around the same booleans already computed in `#/add`: `hasImage`, `hasFields`, `hasCandidates`, `reviewing`, and `busy`.

## State To Layout Mapping

| State | Left artifact column | Right session rail |
| --- | --- | --- |
| Empty add page | Source strip with capture selected; upload available as a segment | Short state summary, disabled next action until URL or file exists |
| Capturing or uploading | Source strip plus lightweight progress message; no candidate grid yet | Busy state, elapsed/progress text when available, conflicting actions disabled |
| Candidates present, not reviewing | Candidate specimen grid and optional status table below it | Selected/tagged/saved/issues tallies; primary action is `Auto-fill selected` when selection exists, then `Commit all tagged` when tagged rows exist |
| Reviewing candidate | Sticky active screenshot plus review sheet | Session context only: `Back to queue`, candidate position, remaining tagged/saved/issues, and bulk commit only for other tagged rows |
| Uploaded single image | Active screenshot plus review sheet after auto-fill; before auto-fill, show image preview and auto-fill prompt | Single-image progress/error summary; no bulk commit action |
| Save in flight | Active screenshot and review sheet remain visible with fields disabled as needed | Save progress/error summary; no duplicate save action |

## Error Handling

Errors should appear in the session rail and near the affected candidate row where available. The existing `_error` and per-candidate `_error` fields are enough.

Busy states should disable only actions that would conflict with the in-flight operation. The user should still be able to inspect candidates and screenshots while tagging or committing is running.

Duplicate and error rows should keep the existing retry and skip actions.

Async auto-fill and commit progress should be announced through a polite live region so keyboard and screen-reader users get status changes without losing focus.

## Responsive Behavior

Desktop uses a two-column workbench with a sticky session rail.

Tablet and mobile collapse to one column:

- Source strip first.
- Artifact/candidate area second.
- A slim sticky session summary/action bar third, pinned near the bottom when practical.
- Review sheet below the active screenshot.

Tap targets must remain at least 36px high on mobile where practical, and text must not overflow buttons or candidate cards.

Keyboard focus order should follow the same order as the visual flow: source controls, artifact/candidate controls, session action, review fields. Candidate preview must be closable by keyboard and return focus to the invoking preview control.

## Testing And Verification

Run the existing relevant test suite after implementation:

- `npm test`
- Update or add browser coverage for the redesigned add flow.

Also manually verify the add flow in a browser:

- Empty add page renders.
- Capture URL path shows candidates.
- Candidate selection updates counts.
- Auto-fill status progresses and preserves selections.
- Review opens a tagged candidate without losing session state.
- Save still creates an entry.
- Upload path still supports single-image auto-fill and save.
- Mobile viewport does not overlap controls or hide primary actions.

Required browser interaction coverage:

- Candidate selection updates the rail tally and selected card state.
- Rail primary action switches correctly between auto-fill, commit, and session-only review context.
- Reviewing one candidate shows exactly one single-entry save CTA.
- Mobile collapse order places candidates before the sticky session summary/action bar.
- Auto-fill progress is exposed through the live region.

## Non-Goals

- No backend API changes.
- No corpus schema changes.
- No rewrite of capture, auto-fill, commit, or save functions.
- No redesign of the separate `#/capture` triage page beyond shared styles that naturally apply.
- No new frontend framework or build step.
