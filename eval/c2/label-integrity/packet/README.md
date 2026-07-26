# C2 label-integrity — reviewer packet

Two reviewers independently label the same 40 UI screenshots. Their observed
agreement is evaluated against the separate, parent-authority baseline-metrics
artifact for the C2 Pass 3 label-integrity gate.

## Before anyone labels — operator checklist

1. **Deliver the image bundle.** The 40 screenshots live under
   `corpus/images-private/`, which is **gitignored** (rights-bound). A fresh
   clone has no images, and labeling without them is impossible. The operator
   must deliver the 40 PNGs separately and confirm they resolve at the paths
   embedded in `label.html` / `reviewer-template.json` before reviewers begin.
   The browser sheet shows a red banner if images are missing. **Do not commit
   private images without rights clearance.**
2. **Freeze the tie-break rules.** `VOCABULARY.md` §6 contains rules derived
   from diagnostic disagreement analysis, not a canonical baseline. Review and
   freeze each rule before labeling. Changing rules mid-labeling invalidates
   completed passes.
3. **Pick two distinct reviewers.** They need distinct human actor IDs and
   canonical roles in their sealed submission envelopes. Different display
   names alone are not evidence of independence. If one person does both
   passes, that is sole-operator mode — self-consistency, not independent
   validation — and must be recorded as such.
4. **Decide directionality and keep it.** Reviewer 1 is *gold* (predicted),
   reviewer 2 is *qa* (reference). Swapping them changes both recall values.
5. **Build once:** `npm run build`. The validator refuses to run without
   `dist/`.

## For each reviewer

Two ways to label. The browser sheet is faster; the JSON file is there if you
would rather not use a browser.

### Option A — browser sheet (recommended)

Run `open-sheet` from this directory (or `./open-sheet` from the repo root).
It verifies the image bundle against the frozen selection before opening the
sheet. Do not double-click `label.html`, because that bypasses the image-hash
preflight. It shows all 40 screenshots with the closed vocabulary as dropdowns
and chips — no typing tags, so no spelling drift.

- Enter your reviewer id at the top first.
- **Type to filter.** `components` has 44 values and `patternType` 23 — type a
  few letters, then click or press Enter. Arrow keys move, Backspace on an empty
  box removes the last pick, Escape closes. There is no free-text entry: the
  lists are closed by design.
- Selected values appear as pills; click a pill's × to drop it.
- **Click any screenshot to zoom** full-resolution. Escape closes.
- Mobile captures render in a phone frame beside the fields, which stays pinned
  while you scroll them. Desktop captures render full width above the fields.
- Required fields turn red only once you have started that entry, so an
  untouched card is not a wall of warnings.
- **Next incomplete** jumps to the first unfinished entry.
- Work saves to browser local storage as you go; you can close the tab.
- **Export JSON** downloads `reviewer-<id>.json`.
- **Import** loads any file with a `labels` array — a previous export, or a
  pre-filled draft to review. It overwrites what is in this browser (it asks
  first) and restores gap flags too. Only schema fields are read; extras like
  `_rationale` are ignored.
- **Clear** wipes every label and flag in this browser. Use it between reviewers
  if they must share a machine.

> **Importing a pre-filled draft is not neutral.** Two reviewers who both start
> from the same draft are editing a shared anchor, not labeling independently.
> Their agreement will overstate real reliability, and since `components-recall`
> and `domain-tags-recall` take their whole floor from the baseline, that sets
> the bar from an artifact. Use a draft for a single operator's review pass or
> for finding vocabulary gaps — never as the seed for both baseline reviewers.

It must be opened so the relative image paths resolve — from this directory, or
served from the repo root.

**Autosave caveat.** Safari refuses local storage for pages opened directly from
disk. The page detects this and shows a red banner: if you see it, your work is
in memory only and a reload loses it. Use Chrome or Firefox, or serve the folder
instead:

```bash
python3 -m http.server 8000
```

then open `http://localhost:8000/eval/c2/label-integrity/packet/label.html`.
Storage works on a real origin.

Do not label two reviewers in the same browser profile — they share one storage
key and would overwrite each other. Use separate machines, separate browser
profiles, or export and clear between passes.

### Option B — edit JSON directly

Copy `reviewer-template.json` to `reviewer-<your-id>.json`, set the `reviewer`
field, and fill each of the 40 entries. Each stub carries an `_image` path
(relative to this directory) so you can open the screenshot. Fill:

- `patternType` — exactly one value
- `categories`, `components`, `domainTags` — at least one value each
- `visualFields` — all four keys, all non-empty
- `critiqueQuality` — one of three values

Leave `groundedClaimIds`, `protectedFieldExpectation` and the `_image`,
`_cohort`, `_width`, `_height` viewing aids alone. `accessibilityEvidenceIds` stays `[]` unless an a11y affordance is
visible.

Read `VOCABULARY.md` first either way. Do not compare notes with the other
reviewer.

## When both files come back

```bash
npm run build

node eval/c2/label-integrity/packet/validate-reviewer-file.mjs \
  path/to/reviewer-one.json \
  --strict \
  --out eval/c2/label-integrity/human-labels-gold.json \
  --gaps eval/c2/label-integrity/gaps-gold.json \
  --verify-images

node eval/c2/label-integrity/packet/validate-reviewer-file.mjs \
  path/to/reviewer-two.json \
  --strict \
  --out eval/c2/label-integrity/human-labels-qa.json \
  --gaps eval/c2/label-integrity/gaps-qa.json \
  --verify-images
```

The validator checks entryId set and order against the frozen selection, closed
vocabulary membership, completeness, and a parse through the production schema.
It strips the packet-only `_image` / `_cohort` keys, which the strict production
schema would reject.

**`--strict` is required when emitting output (`--out` / `--gaps`)**. It validates
the reviewer's file as a complete `C2IndependentLabelSubmission` — not just the
labels, but the full envelope: `actorId`, `actorKind`, `reviewerRole`, `sealedAt`,
`submissionVersion`, `artifactId`, `artifactType`. A file that is only labels
(missing the envelope) cannot produce a clean artifact. Without `--strict`, the
validator runs in diagnostic mode (labels only) — useful for checking vocabulary
and schema shape on a draft, but it does not confirm the file is a valid
submission.

When `--out` or `--gaps` is supplied, image verification is mandatory and a
missing or mismatched PNG exits non-zero before anything is written. Diagnostic
validation without output may omit `--verify-images` when the private bundle is
unavailable.

Then compute the four observed agreement metrics. These values describe this
reviewer pair; they do **not** create or replace the parent-authority
`baseline-metrics.json` artifact.

```bash
node scripts/compute-baseline-metrics.mjs \
  eval/c2/label-integrity/human-labels-gold.json \
  eval/c2/label-integrity/human-labels-qa.json --json --disagree
```

## Vocabulary gaps — the corpus-enrichment output

The closed lists began with the machine-generated corpus taxonomy and remain
deliberately finite. Earlier corpus audits found primitives that taxonomy could
not represent; some, including `bottom-nav`, are now in the measurement list,
while others remain gap candidates. Reviewers therefore pick the nearest value
**and** flag what was missing, via the ⚑ control on each entry.

Those flags travel in a `vocabularyGaps` array beside the labels, never inside
them — `EntryLabelSchema` is strict and the agreement computation never sees
them. The validator's `--gaps` flag splits them into their own report. Merge
both reviewers' reports into a ranked shortlist:

```bash
node eval/c2/label-integrity/packet/summarize-gaps.mjs \
  eval/c2/label-integrity/gaps-gold.json \
  eval/c2/label-integrity/gaps-qa.json
```

Proposals both reviewers reached independently are ranked first — the same
convergence rule this repo applies to review findings. That shortlist is the
evidence base for a **separate** corpus-enrichment pass.

Keep the two jobs apart. Measurement wants a narrow, unambiguous vocabulary
(maximum agreement, clean floor); enrichment wants a rich one (captures what is
actually on screen). Enriching mid-measurement serves neither: a wider list can
lower the pair's observed agreement, and changing it after labeling invalidates
the pass. It does not rewrite the parent-authority baseline or legitimately
loosen the gate.

Keep the two artifacts' exact paths and hashes in the agreement inputs. Do not
repoint `sourceArtifactRefs` in
`eval/c2/label-integrity/baseline-metrics.json` at these submissions: that file
must remain derived from parent-authority evidence. If parent-authority evidence
is still missing, the label-agreement gate remains blocked even when both
reviewer submissions are valid.

## Reading the result

Low agreement is a real finding, not a failure to hide. It says `patternType` is
under-specified for this corpus, and the fix is tighter rules in `VOCABULARY.md`
§6 followed by a re-label — not a quieter number.

Note which way the floors move. `pattern-type-exact-accuracy` and
`categories-macro-f1` resolve to `max(fixedFloor, baseline)` against fixed
floors of 0.90 and 0.85, so a weak baseline there is absorbed.
`components-recall` and `domain-tags-recall` have **no** fixed floor — the
parent-authority baseline value is the entire bar. The current pair's observed
agreement is compared with that bar; it does not redefine it.

## Provenance

Whoever labels, record honestly what happened. Two independent humans produce a
valid reviewer pair for the agreement computation, not parent-authority baseline
evidence. The spec requires the baseline-metrics artifact to exist independently
of Pass 3; a baseline created now from these submissions would be circular and
must not be used. Nothing in the code can establish that provenance; it is an
attestation that must be backed by the delivery packet.
See `../PROVENANCE.md` for the current state.

## Files

| File | Role |
| --- | --- |
| `open-sheet` | serves the repo on localhost and opens the sheet — the reliable way in. **Default is `blank`** (independent reviewer pass); use `open-sheet draft` to review the AI draft. Runs the image-bundle preflight before opening. |
| `README.md` | this file |
| `VOCABULARY.md` | closed vocabulary + tie-break rules — **edit §6 before labeling** |
| `label.html` | browser labeling sheet, opened through `open-sheet` after image verification |
| `review-draft.html` | AI draft pre-filled sheet, for review/correction only |
| `reviewer-template.json` | 40 empty stubs for manual editing |
| `validate-reviewer-file.mjs` | validates a filled file, emits a clean copy + a gaps report. `--strict` (required for `--out`) validates the full `C2IndependentLabelSubmission` envelope. Output mode always preflights the image bundle. |
| `verify-image-bundle.mjs` | preflight: hashes every PNG against `selection.json.imageSha256`. Run before labeling or validation to catch stale/swapped screenshots. |
| `summarize-gaps.mjs` | merges both reviewers' gap reports into a ranked shortlist |
