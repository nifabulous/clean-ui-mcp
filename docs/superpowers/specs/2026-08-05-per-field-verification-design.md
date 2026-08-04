# Per-field verification — design

**Status:** design approved, spec under review
**Stage:** 2a of the corpus trust gate program (Stage 1 shipped in #94, `c6b73ba`)

## Why this exists

Stage 1 shipped `isVerified(entry)` — a single boolean per entry. Stage 2's design
work found that shape is wrong, and found it before any entry carried a record, so
the correction is free.

**The defect.** One verification record un-gates *every* field on an entry. The
evidence layer Stage 2b will build can genuinely measure colour roles, contrast and
aspect ratio from pixels. It cannot measure whether "the sidebar groups metrics by
row" is true of an image. So Stage 2 will routinely produce entries that are
`measured` on colour and unverifiable on prose — and today, writing one `measured`
record for such an entry un-gates the prose too.

That re-opens the exact hole Stage 1 closed. `alan-alan-ios-screens-5-2026-07-05`
describes a left navigation rail on a 1179×2556 portrait phone screenshot; a
measured colour record on that entry would serve the phantom rail again, now
carrying a trust label.

The spec for Stage 1 warned about this class in a different place — "granting trust
from these checks would re-ship the same fabrication class with a trust label
attached", written about the doctor's detectors. The reasoning was applied to the
detectors and missed for the record itself.

**This is a correction to code that shipped on 2026-08-04, not a change of mind.**
Its diff will read as churn against `main`; that is expected.

## Governing invariant

Unchanged from Stage 1, but now enforceable at the granularity it always implied:

> A corpus-derived value is servable only when it is grounded in evidence that can
> be checked. An unverifiable assertion is never served.

The operative word is **value**, not entry. An entry is not a unit of truth: it is
a bag of claims with different evidence available for each. Verification must
attach where the claim is.

## The record

`provenance.verification` becomes a map from **field key** to its own record.

```ts
verification?: {
  [fieldKey: string]: {
    method: string;              // VERIFICATION_METHODS is the authority
    verifiedAt: string;
    verifierVersion: string;
    imageSha256?: string;        // required when method is "image-confirmed"
  };
};
```

The per-record shape is unchanged from Stage 1 — same four fields, same
`.passthrough()` forward-compatibility, same `imageSha256` rule. Only the nesting
changes.

`method` stays a plain string with unknown keys passing through. A corpus written
by a newer verifier must remain *readable* by an older build even when its tiers are
not *trusted*: readability and trust are different questions, and only trust is
fail-closed.

The consequence of getting this wrong differs by mode, and both are bad:

- **Public mode** throws — `corpus-reader.ts:332` raises on a failed parse, so one
  unreadable record makes the whole corpus unavailable.
- **Private mode**, the default, is worse and quieter. A schema-invalid corpus
  decodes as `corrupt`, which `fromDecodeResult` maps to `null`
  (`persistence.ts:137-139`), and the caller **silently falls back to a snapshot or
  the seed**. An older build reading a newer corpus would not error; it would serve
  stale data and say nothing.

Stage 1's review flagged the private-mode path and the note was never corrected.
It is recorded here because the per-field map widens the surface: ten keys per entry
is ten chances for an unknown shape to arrive from a newer verifier.

Since the map's *keys* are open by construction, an unknown key is already
tolerated. The rule that matters is that an unknown key must read as **not
verified** rather than as an error — which the fail-closed predicate gives for free.

### Field keys

Keys are corpus field paths, because that is what a claim is about. The servable
set, derived from what `createUiSpecDeterministic` and the MCP tools actually read:

| key | serves |
|---|---|
| `visual.colorRoles` | `colorTokens`, `get_color_palette` |
| `visual.accentColor` | direction accent signal, `get_color_palette` |
| `visual.typePairing` | direction typography clause |
| `layout` | `layoutRegions`, `responsiveBehavior` form clause |
| `critique` | direction critique clause |
| `whatToSteal` | `techniques`, `get_stealable_techniques` |
| `antiPatterns` | `antiPatterns`, `get_anti_patterns` |
| `voice` | `contentVoiceGuidance` |
| `components` | `componentInventory` |
| `responsiveBehavior` | `responsiveBehavior` mode clause |
| `styleTags` `categories` `mood` `colorScheme` | direction group-B signals |

An absent key is not verified. There is no wildcard key and no "all" key: a
verifier that wants to attest to ten fields writes ten records. This is deliberate
— a single key meaning "everything" would recreate the defect this spec exists to
fix, and a verifier is never in a position to check ten different claims with one
piece of evidence.

## The predicate

```ts
export function isVerified(entry: CorpusEntryT, field: string): boolean
export function verifiedFields(entry: CorpusEntryT): ReadonlySet<string>
```

`isVerified` gains a required second parameter. Making it required rather than
optional is the point: every call site must state which claim it is asking about,
and a site that cannot name its field has not understood what it is gating. An
optional parameter defaulting to "any field" would let all 18 existing call sites
compile unchanged and silently keep the current wrong behaviour.

Fail-closed rules per record are unchanged: no provenance, no verification, no
record under that key, an unrecognised `method`, or an `image-confirmed` record
with no `imageSha256` all read false.

`verifiedFields` exists for the sites that need the set rather than a single answer
(the reader's redaction decision and doctor's reporting).

## How each consumer changes

### `createUiSpecDeterministic` — per-field selectors behind the same shadow

The Stage 1 structural property holds: the ungated parameter is `allMatchedEntries`
and the body cannot reach it. What changes is that the body no longer has one
trusted list. Instead:

```ts
const verifiedFor = (field: string) => allMatchedEntries.filter((m) => isVerified(m.entry, field));
```

Each selector asks for the field it serves — `verifiedFor("whatToSteal")` for
techniques, `verifiedFor("voice")` for the voice composition. The shadowing still
prevents access to ungated data; naming the field is explicit at each selector,
which is right, because each selector is the only place that knows which field it
reads.

`colorTokens` and `layoutRegions` come from `SanitizedEvidence` rows rather than
entries, so they keep the Stage 1 evidence-id bridge — but the bridge is now built
per field: `trustedEvidenceIdsOf(matched, "visual.colorRoles")`.

**Threshold consequence.** The three-contributor `colorTokens` guard counts entries
verified *for `visual.colorRoles`*, not entries verified for anything. Counting the
latter would derive a palette from entries whose colour was never checked — the
over-claim the program exists to stop.

### `TrustGatedCorpusReader` — gate per tool, at wiring time

`search`, `getById`, `findSimilar` and `entriesForAggregation` return whole entries
to tools that then render a subset of fields. A per-field predicate needs a policy
here, and there are two candidates:

1. **Redact unverified fields from the returned entry.** Correct in principle, but
   the corpus schema has required fields (`critique`, `whatToSteal`), so stripping
   them produces a value that no longer parses as a `CorpusEntryT`. It would force
   a projection type through every tool handler.
2. **Parameterize the reader with the fields the tool serves.** Each registration
   in `createServer` constructs a reader gated on the field set that tool renders:

   ```ts
   registerGetStealableTechniques(server, new TrustGatedCorpusReader(reader, ["whatToSteal"]));
   registerGetColorPalette(server, new TrustGatedCorpusReader(reader, ["visual.colorRoles"]));
   ```

**Option 2 is chosen.** It keeps Stage 1's structural property — one filter per
tool, declared at wiring time in `createServer` rather than scattered through
handler bodies — while making the field set explicit and reviewable in one place.
An entry is returned only when *every* field in the set is verified, which is the
conservative reading and the one that cannot over-serve.

`trustPosture()` and `refusedForTrust()` report against the reader's own field set,
so a tool's honest "0 of 787" message stays true for the claim that tool makes.

The double-wrap guard added after review stays.

### The taxonomy methods

`listCategories`/`listStyleTags`/`listDomainTags` currently recompute from entries
verified at all (`corpus-trust-reader.ts:127`, `:134`, `:141`, added in `f6fc17c`).
They become gated on the field each vocabulary is drawn from — `categories`,
`styleTags`, `domainTags` respectively — so a label is advertised only when the
entry's own tagging of that label was checked.

### `doctor.ts`

`unassessed-quality` (`doctor-helpers.ts:521`) currently exempts an entry with any
verification record. It becomes: exempt when the entry has a record for the fields
quality assessment actually covers. The `verification-malformed` and
`verified-image-missing`/`verified-hash-stale` detectors iterate the record map and
report per key, so one malformed record among ten names the key that is wrong.

A new detector, `verification-orphan-key`, reports a record written under a key that
is not in the servable set — a verifier writing keys nothing reads is a silent
no-op, and the current code would not notice.

### The disclosure warning

`create-ui-spec.ts:1500` counts entries verified for anything. It becomes a
per-field count, and the warning message names what was and was not verified rather
than reporting one number that averages incomparable things.

## Testing

The Stage 1 test discipline carries over, with the failure modes review found:

- **Both directions per field.** For each servable key: verified serves, unverified
  withholds. A one-direction test passes with the feature simply broken.
- **The cross-field case is the new one, and it is the reason this spec exists.**
  An entry verified for `visual.colorRoles` and NOT for `critique` must serve the
  palette and withhold the critique, in the same response. This is the test that
  fails today and cannot be written against an entry-level predicate.
- **Mutation-verified.** Patching `isVerified` to `return true` must fail tests
  across every consumer. Measured on `main` at `c6b73ba` (2026-08-05): **51 tests
  fail** under that mutation. This change must not regress below 51, and should
  exceed it — the cross-field cases are new tests that the mutation also kills.
  (An earlier figure of 35 came from a reviewer's measurement before the taxonomy
  gating in `f6fc17c` and the round-2 fix tests landed; 51 is the current number.)
- **Fixtures unverified by default**, matching production and the fail-closed
  default. Serving tests opt in per field.
- **Schema tests parse through real Zod**, never `as unknown as CorpusEntryT` — the
  seam where Stage 1's forward-compatibility claim was false and its test could not
  see it.
- **No test asserts presence alone.** A record's existence is not the claim; the
  claim is that the right field serves and the wrong one does not.

## Out of scope

- **The evidence bundle** (Stage 2b) and **the retag/verifier** (Stage 2c). This
  spec changes only the shape trust is recorded and read in. It writes no records.
- **Any change to what is servable today.** Zero entries carry a record before this
  change and zero carry one after, so the served posture is byte-identical: the
  whole server continues to serve nothing corpus-derived. This is a refactor of the
  gate's granularity, verifiable by the existing suites staying green.
- **Redaction/projection types** for partially-verified entries. Rejected above;
  revisit only if per-tool field sets prove too coarse in 2c.

## Risks

1. **A required second parameter touches 18 call sites.** That is the intent — each
   must state its field — but a mechanical rename would let a site pass a
   plausible-looking wrong field and compile. Every site's field choice needs
   review against what that site actually serves, not just a green build.
2. **Per-tool field sets can be wrong in the safe direction and look right.** A set
   that is too broad over-gates: the tool serves nothing and the honest message
   still renders, so nothing fails. Only a both-directions test per tool catches it,
   which is why they are mandatory above.
3. **`colorTokens`' threshold is the subtle one.** It must count entries verified
   for `visual.colorRoles`. Counting any-field-verified entries would pass every
   test that does not specifically mix fields.
4. **This lands on `main` one day after Stage 1.** Reviewers will see two large
   diffs over the same code. The commit message and this spec carry the reason.
