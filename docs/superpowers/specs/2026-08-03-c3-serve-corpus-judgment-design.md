# Serving Corpus Design Judgment — C3 Reopening (Design)

**Status:** Proposed
**Date:** 2026-08-03
**Scope:** Reopen the C3 served-content posture so `create_ui_spec` may serve
corpus *design judgment* — attributed and identity-screened — instead of
refusing all corpus prose. Supersedes the "no verbatim corpus prose on the
wire" constraint recorded in `2026-08-02-deterministic-body-grounding-design.md`.

## Why reopen

The deterministic body ships with 8 of 13 sections empty. Measured against the
live corpus, the dominant cause is not a defect — it is this posture. The
corpus is fully populated on exactly the fields those sections need:

| target section | corpus field | coverage |
|---|---|---|
| Techniques to borrow | `whatToSteal` | 787 / 787 |
| Anti-patterns to avoid | `antiPatterns.antiPatterns` | 787 / 787 |
| Voice & copy | `voice.tone`, `voice.avoid` | 600 / 787 |
| (entry summary) | `critique` | 787 / 787 |

No engineering fills those sections while the posture holds. The prohibition is
the product's central promise, so changing it is a governance decision, not a
refactor — hence a spec rather than a patch.

**Correction to the Plan 2 spec:** it recorded
`antiPatterns.whereThisFails` as 787/787 populated. The key is present on all
787 entries but holds an **empty array on every one of them** — 0/787 usable.
A truthiness count reads it as full coverage. (Third instance of that confusion
in this workstream; the field-coverage audit should count usable values, not
key presence.)

## What the data actually says

The prose is pattern-descriptive, not product-descriptive. A representative
`whatToSteal` row:

> "Use a right-side callout tooltip/card anchored to chart regions with concise
> title, icon, and stacked dividers; keep it visually distinct via white
> surface and slight rounding."

That is publishable design judgment. But a minority of rows name a product,
almost always because the text quotes UI copy verbatim ("How Mobbin works",
"Add SLMobbin to Slack", "Hello from Hive"). Scanned across all 787 entries:

- **Zero** prose strings contain a URL, a corpus id, or an image path (0/787
  on each). The leak classes the existing screen already covers do not occur
  in prose at all.
- Product identity DOES occur. Rate per field, under the screen defined below:

| field | rows dropped by the screen |
|---|---|
| `antiPatterns.antiPatterns` | 21 / 787 (2.7%) |
| `voice.tone` | 22 / 600 (3.7%) |
| `whatToSteal` | 34 / 787 (4.3%) |
| `voice.avoid` | 37 / 600 (6.2%) |
| `critique` | 52 / 787 (6.6%) |
| **`voice.examples`** | **119 / 600 (19.8%)** |

`voice.examples` is an outlier by an order of magnitude because it *is* quoted
third-party interface copy.

**But the raw drop-rate is misleading, and an earlier draft of this spec cut
the field on it.** Composition of all 1,832 example strings (p50 length: 13
characters):

| class | share | disposition |
|---|---|---|
| generic label under 20 chars ("Log in", "Password") | 60.6% | no design value |
| product identity | 7.6% | screened |
| pure data / under 6 chars (`"52,420"`, `"Alan"`) | 7.9% | screen scrapings, not copy |
| **sentence-like microcopy** | **23.9% (438)** | the actual material |

The surviving 438 are the best copy guidance in the corpus — concrete voice
rather than the abstraction `voice.tone` provides:

> "We'll text you a code to confirm it's really you" · "What should we call
> you?" · "We like to keep things personal" · "Prefer not to answer"

**A length cap is NOT a reproduction control, and an earlier draft claimed it
was.** Reading all 7 strings an 80-char cap would have excluded: six are plain
functional product copy — notification text, onboarding blurbs, and a
privacy-policy sentence ("This is necessary to ensure your protection and meet
our legal obligations"). Only one carries anything slogan-like, and the
distinctive part of it is three words. Length does not track protectability:
the least creative string in the set (legal boilerplate) is the one the cap
removed.

What actually bounds the risk here is the identity screen plus the per-response
cap of 3 — not string length. The length bounds that remain are honest about
their jobs:

- **lower bound 20 chars — a QUALITY filter.** Drops the 68.5% of the field
  that is generic labels ("Log in", "Password") and screenshot data
  (`"52,420"`, `"Alan"`), none of which carries design signal.
- **upper bound 140 chars — a SIZE guard.** The longest example in the corpus
  today is 132 chars, so this excludes **0 of 438** currently. It exists so a
  future long entry cannot dominate the artifact, not to filter content.

## Governing invariant (revised)

The old invariant was "no corpus content is ever returned." The new one is
narrower and must be stated positively so it can be tested:

> Everything the corpus records about a design may be served, attributed to a
> response-scoped evidence id and screened for identity. No third-party product
> name, title, URL, image path, or corpus id is ever published; a string that
> trips the screen is dropped rather than edited; and a served observation is
> never promoted into an authoritative token slot it has not earned.

Four properties are load-bearing and each gets a test:
1. **Attributed** — every served row carries the evidence id it came from.
2. **Screened** — the screen runs on every prose string, fail-closed.
3. **Dropped, never redacted** — see "Why drop, not redact" below.
4. **Observation ≠ authority** — §2d. Serving a corpus colour does not populate
   `colorTokens`.

Note what this invariant deliberately does NOT say: it does not forbid verbatim
interface copy. Short functional labels ARE served, attributed and capped
(§1). The earlier draft forbade them and then permitted them via a character
count, which was incoherent — the invariant now matches the behaviour.

## Design

### 1. What is served

| section | source | rule |
|---|---|---|
| Techniques to borrow | `whatToSteal` | up to 5 rows, each cited |
| Anti-patterns to avoid | `antiPatterns.antiPatterns` | up to 5 rows, each cited |
| Reference summary | `critique` | 1 per matched entry, cited |
| Voice & copy | `voice.tone`, `voice.avoid` | tone (1) + avoid (up to 3), cited |
| Voice & copy — examples | `voice.examples` | up to 3, **20–140 chars**, cited |
| Accessibility constraints | `antiPatterns.accessibilityRisks` | all present, cited |
| Style signals | `styleTags`, `categories` | closed tokens, no screen |
| Mood / colour scheme | `mood`, `colorScheme` | when present, cited |
| Component inventory | `components` | when present, cited |
| Responsive behavior | `responsiveBehavior`, `layout.regions` | when present, cited |
| Typography observation | `visual.typePairing` | observation only — see §2d |
| Colour observation | `visual.colorRoles` | observation only — see §2d |

`voice.examples` carries two extra filters beyond the shared identity screen,
each doing a job the screen does not:

- **Length 20–140 chars.** Lower bound is a quality filter (drops 68.5% generic
  labels and data). Upper bound is a size guard that excludes nothing today —
  see above. Neither is a copyright control.
- **Reject numeric/data-only strings** (`^[\d\s.,%$£€+-]+$`) — screenshot values
  like `"52,420"`, not copy.
- **Cap 3 per response**, which — with the identity screen — is what actually
  bounds reproduction: no single reference's copy appears in bulk, and every
  served string is attributed to its evidence id.

Strings that survive are short functional interface labels, attributed and
capped. If the project later decides that even attributed functional copy
should not be served, that is a content decision to make explicitly, not
something to approximate with a character count.

### 2. Disposition: serve everything except identity

**The coverage floor is withdrawn as a serving criterion.** It came from Plan 2
Task 0, where it gated *synthesis eligibility* — whether there was enough data
to compute a plurality. It was never a publishing rule, and reusing it as one
was my error. Sparse is not a reason to withhold: an attributed observation
present on 22 of 787 entries is honest and useful, and refusing it hides the
gap instead of showing it.

Two mechanical rules replace the floor:

1. **Identity screen** on every prose field (§3), fail-closed.
2. **Present-or-absent.** A field renders when a matched entry carries it. When
   none do, the section states its unavailability with the reason — not silence.

Expected appearance per response, given 3 retrieved entries:

| field | coverage | appears in |
|---|---|---|
| `whatToSteal`, `antiPatterns`, `critique`, `styleTags`, `categories`, `visual.typePairing` | 787 | 100% |
| `layout.regions` | 704 | 99.9% |
| `voice.tone` / `avoid` / `examples` | 600 | 98.7% |
| `components` | 23 | 8.5% |
| `mood`, `colorScheme`, `responsiveBehavior` | 22 | 8.2% |
| `accessibilityRisks` | 10 | 3.8% |
| `whereThisFails` | 0 usable | never, until the corpus carries it |

Wiring the sparse fields yields little today and costs almost nothing. It is
what makes corpus growth pay off the day an entry is added, rather than
requiring another code change then — which is the stated plan.

### 2a. Served, with the identity screen

`whatToSteal`, `antiPatterns.antiPatterns`, `critique`, `voice.tone`,
`voice.avoid`, `voice.examples` (windowed + capped), `accessibilityRisks`.

`critique` is now served — the earlier "duplicates the other fields" exclusion
was a judgement call, and a whole-entry design summary is worth its own section.

### 2b. Served, no screen needed (closed tokens, no identity)

`styleTags`, `categories`, `mood`, `colorScheme`, `components`,
`responsiveBehavior`, `layout.regions`, `visual.typePairing`,
`visual.colorRoles`.

### 2c. Never served

`title`, `source.*` (including `productName` and `url`), `image`, and the
corpus entry `id`. Identity by definition. Unchanged.

`antiPatterns.whereThisFails` and Interactions are not exclusions — the first
is an empty array on all 787 entries, the second has no corpus field at all.
Both are wired; both simply have nothing to render yet.

### 2d. The one line I hold: observation is not token authority

Serving a value and promoting it into an authoritative token slot are different
acts, and the distinction survives this decision:

- **`visual.colorRoles` — serve as cited observations; do NOT populate
  `colorTokens`.** This is a correctness objection, not a coverage one. Measured
  across the last campaign, **0 of 8** synthesized palettes met the caller's
  stated AA floor, and one emitted an accent identical to the page canvas.
  Publishing a known-failing palette in the slot that downstream CSS consumes
  is not the same as publishing a sparse observation — someone pastes it and
  ships an invisible button. Tokens stay `unavailable` with a reason until they
  pass a contrast and role-distinctness gate.
- **`visual.typePairing` — serve as a cited observation; do NOT populate
  `typographyTokens`.** The corpus records display + body; `TypographyTokens`
  requires `mono`. Emitting a fabricated third role to complete the slot would
  be invention. The pairing is useful evidence on its own.

Everything else the corpus holds is served.

### 3. The identity screen

Per candidate string, drop it if any matches, word-boundary and
case-insensitive:

- the source entry's own `source.productName` or `title`;
- any of the **71 distinctive product names** in the corpus. Six of the 77 are
  dictionary words (`Origin`, `Hive`, `People`, `Projects`, `Mercury`,
  `Untitled`) and are excluded from the global list — matching them would drop
  ~8% of good rows for the word "projects". Those six are still caught by the
  own-entry check, which is precise.
- the existing `containsPrivateMarker` sweep (URLs, paths, corpus ids),
  unchanged and still fail-closed.

The distinctive-name list is DERIVED from the corpus at build time, not
hand-maintained, so a new entry cannot silently widen the hole.

**Residual risk, stated:** a prose row naming a product that is not in the
corpus at all is not caught. The screen bounds a class, it is not a proof. This
is the same bounded-class property the existing marker sweep has, and it must be
recorded in the tool description rather than implied away.

### 4. Why drop, not redact

A screened string is discarded whole. Never regex-replace the name in place: a
row rendered as `"How  works"` is worse than absent — it reads as tampering,
corrupts the sentence, and leaves the reader unable to judge what was removed.
Dropping loses one row of grounding; redacting publishes a damaged claim.

### 5. Attribution

Every served row cites the response-scoped `evidence-N` of the entry it came
from, through the existing `citedDecisions` mechanism with `corpus-evidence`
authority — the same path the synthesized `designDirection` and `colorTokens`
already use. `## Sources` must then list those ids; today it reads "(no cited
references recorded)" while the direction cites them, which is the
self-contradiction the audit found in 12 of 12 files. This spec closes it.

### 6. The published promise changes

`src/create-ui-spec-mcp.ts:164` currently reads:

> "No corpus content, path, url or product identity is ever returned — corpus
> grounding appears only as opaque evidence ids."

That becomes false the moment this ships. Replacement:

> "Design judgment drawn from the reference corpus is returned as cited
> observations, each attributed to a response-scoped evidence id. No product
> identity, path, url, or corpus id is returned. Short interface copy may
> appear as cited examples, capped per response; longer brand or legal prose
> does not."

Three leaf annotations also become false and must change in the same commit —
`data.rejectedDefaults[]`, `data.techniques[].text`, `data.antiPatterns[].text`
all currently say "recipe-owned prose", which will no longer be true for the
latter two. This is the same annotation-truthfulness class as the
`data.designDirection` correction.

## Error handling

- Screen trips → that row is dropped; remaining rows still serve. All rows
  dropped → the section renders its unavailable reason, not an empty list.
- Entry lacks the field → contributes nothing; no placeholder.
- Zero surviving rows across all entries → sections stay unavailable with
  reasons, exactly as today. This path must remain reachable and tested.

## Testing

1. **Screen, positive:** a fixture entry whose `whatToSteal` names its own
   product → that row is absent from the served spec, siblings survive.
2. **Screen, global list:** a row naming a DIFFERENT corpus product → dropped.
3. **Dictionary-word names:** a row containing "projects" as an ordinary noun →
   NOT dropped (guards the false-positive regression).
4. **Never redacted:** no served string contains a partial/blanked name; assert
   dropped rows are absent entirely.
5. **Attribution:** every served technique/anti-pattern/voice row has a
   `citedDecisions` entry with `corpus-evidence` authority citing an id in the
   corpus lane; `## Sources` lists exactly those ids.
6. **voice.examples filters:** a 19-char example is absent and a 20-char one is
   present (lower boundary pins); a 141-char one is absent and a 140-char one is
   present (upper boundary pins). A numeric-only example is absent. At most 3
   appear regardless of how many qualify. Mutation-test the cap of 3 by raising
   it and asserting a fourth string appears — a limit nobody has broken on
   purpose is a limit nobody has verified.
7. **Full-corpus sweep:** run the producer over all 787 entries and assert zero
   served bytes contain any of the 77 product names or any title.
8. **Unavailable path:** all-dropped → reasons, not empty arrays.
9. **Sparse fields render when present:** a fixture entry carrying `mood`,
   `components`, and `accessibilityRisks` produces all three sections populated
   and cited — proving the wiring works before the corpus is grown into it.
   A fixture without them renders the unavailable reason, not an empty list.
10. **Observation never becomes authority:** a fixture whose `colorRoles` would
   fail contrast produces the colour OBSERVATION in the served body while
   `colorTokens` stays null with its reason and `colorTokenAuthority` stays
   `editorial`. Mutation-test by wiring the observation into the token slot and
   asserting the contrast gate then fails.

## Non-goals

- **Populating `colorTokens` or `typographyTokens` from corpus values.** Both
  are served as cited observations (§2d); the authoritative slots stay
  `unavailable` until tokens pass a contrast + role-distinctness gate, which is
  tracked separately.
- Changing retrieval (still top-3 ranked, pattern-deduped) or the model lane.
- Re-signing the readiness ledger. No C3 closure artifact asserts the
  no-corpus-content property, so this is a product-contract change rather than a
  ledger reopening — confirm before implementation.
- Growing the corpus. Sparse fields are wired now precisely so that adding
  entries later needs no code change.
