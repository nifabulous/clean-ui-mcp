# Backfill model pilot — which model fills the four corpus fields

**Run date:** 2026-08-08/09
**Script:** `src/scripts/backfill-pilot.ts`
**Sample:** 25 entries pinned in `eval/backfill-pilot/sample-ids.txt`, reused by
every arm.
**Evidence (committed):** `eval/backfill-pilot/results.jsonl` — all 75 rows
(3 arms × 25), keyed by `entryId` + `imageSha256`. Every number in this document
is recomputable from it.
**Raw per-arm output (local only):** `eval/backfill-pilot/<provider>-<model>.jsonl`
— gitignored, because it carries `corpus/images-private/*` paths, which have
never entered git. `results.jsonl` is those files with the path field replaced
by a content hash; nothing else is dropped. Regenerate it with
`node eval/backfill-pilot/merge-results.mjs` (committed — the merge is not a
shell one-liner that dies with the terminal session, and it refuses to write if
any row still references a private path).
**Corpus written:** none. The script has no write path. Verified `UNCHANGED`
after every arm.

## Re-running it

```bash
npm run backfill-pilot -- --provider gemini --model gemini-3.5-flash-lite
```

One arm per invocation, sequentially — the script pins the model through the
provider's env var, so two concurrent arms would race each other onto one model.
The first run pins the sample to `eval/backfill-pilot/sample-ids.txt`; every
later arm reuses it, so delete that file only if you intend to invalidate the
comparison. Then regenerate the committed evidence:

```bash
node eval/backfill-pilot/merge-results.mjs
```

## Why this ran

`components`, `mood`, `colorScheme`, `domainTags` are recorded on ~3% of the
corpus (23 / 22 / 22 / 14 of 787). They drive 298 of the diagnosis run's 331
gates. Backfilling them is the largest remaining lever — and unlike everything
in the verification cycle, a value written here **gets served**. So the model
choice was measured before spending a full run, not after.

## What was measured, and what was not

`mood` is **not** in the scored set. It is a Pass 2 (prose) field; the
`extractionOnly` return object never emits it, so scoring it here would report
0/25 for every model and read as "no model can do mood" when the truth is that
no model was asked. This was caught at 1 image, before the arms ran. Backfilling
`mood` needs a second call per image and belongs in its own exercise.

## Arm results (presence + latency)

| arm | ok/25 | components | domainTags | colorScheme | median latency | comp/img | distinct comps |
|---|---|---|---|---|---|---|---|
| `gemini-3.5-flash-lite` | 25/25 | 25 | 17 | 25 | **2,096 ms** | 5.0 | 24 |
| `claude-haiku-4-5` | 25/25 | 25 | 15 | 25 | 7,174 ms | 5.9 | 23 |
| `minimax-M3` (incumbent) | **12/25** | 12 | 5 | 12 | 3,300 ms | 4.6 | 19 |

**These are presence counts, not accuracy.** Per the project standard, a
non-null count is not a quality measurement. The accuracy section below is the
one that decides anything.

### The MiniMax result is infrastructure, not quality

13 of 25 MiniMax calls failed with `fetch failed` — the same network flakiness
that blocked the B2 re-measurement. Nothing here says MiniMax-M3 is a worse
tagger; it says the endpoint did not answer half the time in a sequential run.

That is still operationally significant, because **MiniMax is the configured
production extraction provider** (`AUTO_TAG_PROVIDER_EXTRACTION=minimax`). A
787-image backfill on the current default would, at this failure rate, drop
~400 images and need repeated resume passes.

## Inter-model agreement — the actual finding

Gemini and Haiku both scored all 25 images, so they can be compared directly.

| measure | value |
|---|---|
| components — median Jaccard per image | **0.56** |
| components — mean Jaccard | 0.59 |
| tags both models proposed | 99 |
| gemini-only | 27 |
| haiku-only | 49 |
| **share of all proposed tags corroborated by the other model** | **57%** |
| domainTags — median Jaccard (n=19 images) | 0.50 |
| colorScheme identical | **25/25** |

Two independent models looking at the same screenshot agree on ~57% of proposed
component tags. **This is why presence counts cannot pick a winner**: 43% of
what either model proposes is model-specific opinion, and both arms score
25/25 on presence regardless.

### colorScheme has no discriminating power here

25/25 identical, and a corpus-wide luminance measurement puts the corpus at
**95.6% light** — all 787 images, median luminance 253, only 35 below the
threshold (`node eval/backfill-pilot/measure-luminance.mjs`; the script pins the
method, because the number moves with it — see the note below). This
field should be a **deterministic pixel computation**, not a model call. That
closes both halves at once: computing the value fills the corpus (the 50-entry
cohort has **41** `colorScheme` gates — `docs/verifier-abstain-diagnosis.md`
line 99, `gate` column), and computing it again at verify time makes the field
`provable` rather than model-lane. Zero API calls either way. Do not spend
backfill budget on it.

## Hand adjudication of the disputed tags

76 tags are disputed across 23 images. Four screenshots were opened and their
disputed tags scored by inspection (n = 20 tags):

| | unique tags proposed | correct on inspection |
|---|---|---|
| gemini-only | 7 | **5 (71%)** |
| haiku-only | 13 | **6.5 (50%)** |

Representative calls:

- **Arcade Web Screens 24** — gemini's `timeline` (playhead + 10s/20s/30s/40s
  ruler), `tab-nav` (Edit/Preview/Insights with active underline) and `top-nav`
  are all plainly present. Haiku's `media-grid` is a single-column step rail,
  and `action-list` is a properties panel.
- **Wise 31** — haiku's `icon-button` is right (×, →, +); its `status-chip` is
  not (`Added · 12 Feb` is plain text). Gemini's `media-grid` is one promo card.
- **sample-5 (Origin)** — haiku's `area-chart` beats gemini's `line-chart`: the
  gradient fill under the curve is unmistakable. Gemini's `stat-card` is right.
  Haiku's `status-chip` is a coloured dot.
- **Quicken Web Screens 5** — haiku's `bar-chart` is a progress bar; its
  `status-chip` (Shopping / Gas & Fuel / Groceries pills) and `summary-card`
  are right. Gemini's `top-nav` is right.

Haiku proposes roughly twice as many unique tags and is right about half the
time — it over-proposes. Gemini is more conservative and more precise.

**Sample size caveat:** 20 tags across 4 images. Directional, not a precision
measurement. It is enough to rank the two arms; it is not enough to publish a
precision figure for either.

## Decisions

1. **Single-model backfill: `gemini-3.5-flash-lite`.** 25/25 completion, 3.4×
   faster than Haiku (787 images ≈ 28 min vs ≈ 94 min sequential), and higher
   precision on the tags the two models disagree about.

2. **Do not backfill `colorScheme` with a model.** Compute it from pixels.

3. **Do not run the backfill on the configured production provider as-is.**
   `AUTO_TAG_PROVIDER_EXTRACTION=minimax` failed 52% of calls in this run.

4. **The consensus deferral in `TODOS.md` now has evidence.** The intersection
   of two models (99 tags, 4.0/image, both models agree) is a materially
   higher-confidence set than either model's 5.0–5.9/image alone. A two-model
   backfill that writes only the intersection, and parks the 43% disagreement
   set for review instead of writing it, is the accuracy-maximising option —
   at 2× cost and Haiku's latency. This is a cost/confidence trade for a human
   to make, not a default to assume.

## Two numbers this document had wrong before review

Both were caught by the coherence check run before the branch artifact was
written, not by the per-arm review. Recording them because the failure mode is
the same in each case — a number that reads as measured but has no pinned
method or no source.

1. **"39 cohort gates" for `colorScheme` was wrong; it is 41.** The 39 belongs
   to `visual.accentColor`'s *abstain* column in the same table
   (`docs/verifier-abstain-diagnosis.md` line 82) — a different field and a
   different column from `colorScheme`'s `gate` count on line 99.

2. **The luminance figures were unreproducible.** The first version reported
   median 242 with 28 images below threshold, from a command that no longer
   exists. The pinned method reports median 253 with 35. The conclusion — the
   corpus is overwhelmingly light, so `colorScheme` does not need a model —
   survives either way, which is exactly why the wrong figures were easy to
   miss. `eval/backfill-pilot/measure-luminance.mjs` is now the authority, and
   it states its own method in its header because the number moves with it.

## Known gap

The file header promises a `droppedInvalid` metric — the count of invented,
out-of-vocabulary tags silently discarded by `componentsFromAllowed` /
`domainTagsFromAllowed`. It is **not implemented**: the vocabulary filter runs
inside the tagger, before this script sees raw output. A model that invents
plausible-but-wrong component names is therefore indistinguishable here from one
that found nothing. Measuring it needs a tagger-side hook.
