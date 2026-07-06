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

The right column is the session rail. It summarizes state and offers the next primary action: select, auto-fill, review, commit, or save. It also shows counts for selected, tagged, saved, and issues. This consolidates actions that are currently scattered below candidate grids and status tables.

## User Experience

The default empty state asks for a source, but it should not look like a blank form. It should present capture and upload as equal input modes, with the URL input selected by default because that is the richer Corpus path.

After URL capture, the candidate grid becomes the main surface. Candidate cards should read as corpus specimens:

- Large top-aligned thumbnails.
- Mono source/candidate identifiers.
- Quiet selection affordance using border, checkbox, and a selected state.
- Icon-only preview control with a tooltip or title.
- No nested cards or decorative wrappers.

When auto-fill starts, progress should stay visible in the session rail and the candidate status list. Status labels should use corpus language where possible: `pending`, `tagging`, `tagged`, `saved`, `duplicate`, `error`, `skipped`.

When reviewing one candidate, the screenshot remains visible and prominent. The metadata review area should prioritize human judgment:

- Title.
- Product name.
- Quality score.
- Quality tier or review status.
- Critique.

Auto-detected classification fields (`patternType`, categories, style tags, platform) should be visible but secondary, either as a compact classification block or collapsible section.

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

## Error Handling

Errors should appear in the session rail and near the affected candidate row where available. The existing `_error` and per-candidate `_error` fields are enough.

Busy states should disable only actions that would conflict with the in-flight operation. The user should still be able to inspect candidates and screenshots while tagging or committing is running.

Duplicate and error rows should keep the existing retry and skip actions.

## Responsive Behavior

Desktop uses a two-column workbench with a sticky session rail.

Tablet and mobile collapse to one column:

- Source strip first.
- Session rail summary second.
- Artifact/candidate area third.
- Review sheet below the active screenshot.

Tap targets must remain at least 36px high on mobile where practical, and text must not overflow buttons or candidate cards.

## Testing And Verification

Run the existing relevant test suite after implementation:

- `npm test`
- Any browser/UI test available for the curator UI, especially `src/scripts/ui-browser.test.ts` if it remains applicable.

Also manually verify the add flow in a browser:

- Empty add page renders.
- Capture URL path shows candidates.
- Candidate selection updates counts.
- Auto-fill status progresses and preserves selections.
- Review opens a tagged candidate without losing session state.
- Save still creates an entry.
- Upload path still supports single-image auto-fill and save.
- Mobile viewport does not overlap controls or hide primary actions.

## Non-Goals

- No backend API changes.
- No corpus schema changes.
- No rewrite of capture, auto-fill, commit, or save functions.
- No redesign of the separate `#/capture` triage page beyond shared styles that naturally apply.
- No new frontend framework or build step.
