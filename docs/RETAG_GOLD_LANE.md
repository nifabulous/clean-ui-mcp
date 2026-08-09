# Retag gold lane

The retag gold lane is the correctness gate for corpus-wide changes to
`components`, `domainTags`, `colorScheme`, `mood`, and `visual.typePairing`.
It is deliberately separate from model-vs-model agreement: two models agreeing
does not establish that a label is true.

## Frozen sample

The lane uses the 40-entry, image-hash-bound selection in
`eval/c2/label-integrity/selection.json` (35 reproducible entries and 5
challenge entries). The selection is a sampling frame, not a label source. A
packet is regenerated if an image hash changes; it must never be edited to make
the hashes pass.

Generate a private packet outside `corpus/`:

```sh
npm run retag-gold -- packet --out /tmp/clean-ui-retag-gold-packet.json
```

For an image-first reviewer page, generate both artifacts in one command:

```sh
npm run retag-gold -- packet \
  --out /tmp/clean-ui-retag-gold-packet.json \
  --html /tmp/clean-ui-retag-gold-review.html
open /tmp/clean-ui-retag-gold-review.html
```

The HTML embeds the packet metadata and local `file://` image URLs, so the
screenshots render at large size without a server. It autosaves a local draft,
keeps every field visible, and has both **Copy JSON** and **Download JSON**
buttons. The copied/downloaded envelope still must pass the CLI validator.

The packet contains local image paths and is intentionally not a durable,
tracked artifact. Open the images directly and fill one independent submission
per reviewer. Do not seed the fields from the existing corpus or from a model
draft.

## Field rules

Every entry must receive all five fields:

- `present`: the value is visibly/evidentially supported and uses the current
  canonical vocabulary.
- `none`: the field is observable and absent. Do not use this for “I could not
  tell.”
- `abstain`: evidence is insufficient; include a short reason.
- `oov`: the evidence supports a real candidate outside the closed vocabulary;
  record the candidate(s) and explain why the current vocabulary is inadequate.

`components` and `domainTags` accept only values in `src/schema.ts`. A novel
component/domain is an OOV proposal, never a silently dropped value.
`colorScheme` is `light` or `dark`. `mood` has no frozen vocabulary yet, so
record a concrete phrase as `oov` rather than claiming a scoreable `present`
value. `visual.typePairing`
is `present` only when a DOM signal identifies the font; screenshot-only font
inference is an abstention.

For `components`, `present` means “select every visible item from the current
component list.” You can also add one or more missing candidates while keeping
the known selections; those candidates are preserved as OOV taxonomy evidence.
`none` means you inspected the screen and no listed component applies; if a
clear component is visible but missing from the list, use the missing-candidate
input (or `oov` when there are no known components).
For `domainTags`, `present` requires visible domain evidence; do not infer a
domain from the product name. `colorScheme` is either light, dark, or
abstain—there is no meaningful “none” theme.

Two people should label the same frozen packet independently. A disagreement is
an adjudication input, not permission to average model output. Promote a new
component/domain only after reviewing repeated OOV proposals and updating the
schema vocabulary; then rerun the gold lane before any corpus backfill.

## Validate a submission

Validation checks the schema, exact selection artifact hash, complete entry set,
per-image hashes, canonical closed vocabulary, and evidence rules:

```sh
npm run retag-gold -- validate \
  --submission /private/reviewer-alice.json \
  --out /private/reviewer-alice.validated.json
```

When both independent files are ready, validate the pair in one pass:

```sh
npm run retag-gold -- validate \
  --submission /private/reviewer-alice.json \
  --peer-submission /private/reviewer-bob.json
```

The pair check requires different actors and complementary `gold`/`qa` roles.

The command is read-only with respect to the corpus and refuses to write under
`corpus/`. A submission that names a changed image or a different selection is
invalid, even if all labels look plausible.

The validated submission envelope can be passed directly to a shadow retag;
the runner converts it to evaluator labels and still rechecks the current
image bindings:

```sh
npm run retag-shadow -- --provider gemini --sample-file /private/ids.txt \
  --gold /private/reviewer-alice.validated.json
```

## Scoring implications

`src/retag-eval.ts` treats `abstain` and `oov` as non-scoring labels. OOV counts
are reported separately, so a model cannot improve accuracy by guessing a
canonical value where a human recorded a novel but plausible concept. Only
scored `present`/`none` labels contribute to exact accuracy, precision, recall,
and F1.

This lane establishes the evidence baseline. It does not automatically rewrite
the 787-entry corpus. After two independent submissions and adjudication, use
the accepted labels to evaluate a shadow retag, inspect field-level diffs, and
promote only fields that clear the agreed gate. Preserve abstentions, OOV
proposals, and disputed prose as review work.
