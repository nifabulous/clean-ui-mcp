# C3 Phase 1 — Serve Corpus Prose Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill six empty `create_ui_spec` sections from corpus design judgment,
identity-screened and attributed, with no `UiSpec` schema change.

**Architecture:** Matched corpus entries reach `assembleSpec` through a new
INTERNAL `ResolvedEvidence.matchedEntries` channel (never projected); a pure
`corpus-prose-screen` module drops any string carrying product identity; a
selector maps screened prose into six existing `UiSpec` fields; the two
`sourceIds` leaf positions move to the evidence-id domain so techniques and
anti-patterns can cite `evidence-N`.

**Tech Stack:** TypeScript, Zod, Vitest.

**Design:** `docs/superpowers/specs/2026-08-03-c3-serve-corpus-judgment-design.md`

## Global Constraints

- Governing invariant: everything the corpus records may be served, attributed
  to a response-scoped evidence id and screened for identity. No product name,
  title, URL, image path, or corpus id is ever published; a screened string is
  **dropped whole, never redacted in place**; and a served observation is never
  promoted into an authoritative token slot.
- **Phase 1 changes no `UiSpec` field and adds no section.** `colorTokens` and
  `typographyTokens` stay null with their reason rows (Phases 2 and 3).
- `ResolvedEvidence.matchedEntries` holds RAW corpus entries — `title`,
  `source.productName`, `image`. It must never reach a transport projection.
  That is the single largest leak risk in this plan and gets its own test.
- The leaf gate is fail-closed. Every position this populates is already
  classified EXCEPT the two `sourceIds` domains changed in Task 2.
- Every task is TDD: failing test → minimal implementation → passing test →
  commit, then a review artifact before the next task's commit.

## Three review corrections carried into this plan

The design spec asserted three things that verification disproved. They are
fixed here; do not re-derive them from the spec's prose.

1. **`sourceIds[]` is NOT an evidence-id channel.**
   `data.techniques[].sourceIds[]` and `data.antiPatterns[].sourceIds[]` are in
   `CREATE_UI_SPEC_SAFE_REFERENCE_LEAVES`, which enforces
   `SAFE_PUBLIC_REFERENCE_ID` (`ref-<sha256>`). Writing `evidence-2` there
   REFUSES the whole response. Task 2 moves both positions to the evidence-id
   set. Verified safe: nothing populates `sourceIds` today — `techniques` and
   `antiPatterns` come from the recipe's decisions map and are always empty.
2. **`citedReferences` cannot fix the Sources contradiction.** It is populated
   only from `resolved.resolvedReferenceTokens` (caller-supplied tokens, opaque
   `ref-<sha>` digests) and is classified `safe-public-reference`. Putting
   `evidence-N` there fails the gate. Task 6 adds a distinct "Grounded in" line
   instead; `citedReferences` is untouched.
3. **`ResolvedEvidence` carries no corpus entries.** Prose cannot come through
   `structuredFacts` — that is a closed, deliberately prose-free allowlist.
   Task 1 adds the internal channel.

## Task 1: Internal matched-entry channel

**Files:** Modify `src/create-ui-spec.ts`; Test `src/create-ui-spec.test.ts`

- [ ] **Step 1: Write the failing leak test first.** This is the guard, so it
  precedes the feature:

```ts
it("never projects matchedEntries or raw corpus identity to a transport", async () => {
  const corpus = [corpusEntryWithRoles("internal-a", "#2563eb", "dashboard")];
  // give the entry unmistakable identity to hunt for
  (corpus[0] as unknown as Record<string, unknown>).title = "ZZTITLEZZ";
  (corpus[0] as unknown as Record<string, unknown>).source = { productName: "ZZPRODZZ" };
  const out = await createUiSpecForAdapter(noRefRequest(), deps(corpus, corpus.map(e => ({ entry: e, score: 5 }))));
  const served = JSON.stringify({ envelope: out.envelope, evidence: out.sanitizedEvidence });
  expect(served).not.toContain("ZZTITLEZZ");
  expect(served).not.toContain("ZZPRODZZ");
  expect(served).not.toContain("matchedEntries");
});
```

Run: `npx vitest run src/create-ui-spec.test.ts -t "never projects matchedEntries"`
Expected: PASS immediately (nothing carries entries yet). It must KEEP passing
through every later task — treat a failure here as a stop-work.

- [ ] **Step 2: Add the channel.** In `ResolvedEvidence`, after `sanitized`:

```ts
  /**
   * INTERNAL ONLY. Matched corpus entries paired with the response-scoped
   * evidence id assigned to each, so the synthesizer can read prose the
   * sanitized rows deliberately exclude (structuredFacts is a closed,
   * prose-free allowlist). These are RAW entries — title, source.productName,
   * image. Nothing may project this field; the transport adapters read
   * `sanitized`, never this. Pinned by the leak test in create-ui-spec.test.ts.
   */
  readonly matchedEntries: readonly { readonly evidenceId: string; readonly entry: CorpusEntryT }[];
```

Populate it in `resolveAutomaticRetrieval` inside the existing `for (const r of top)`
loop (push `{ evidenceId: id, entry: r.entry }`). Return `matchedEntries: []`
from `resolveExplicitReferences` and from every zero-match branch.

- [ ] **Step 3: Run the affected suites**

Run: `npx vitest run src/create-ui-spec.test.ts src/create-ui-spec-mcp.test.ts src/create-ui-spec-http.test.ts`
Expected: PASS, leak test included.

- [ ] **Step 4: Commit** — `feat(create-ui-spec): internal matched-entry channel for prose`

## Task 2: Move `sourceIds` to the evidence-id domain

**Files:** Modify `src/tool-contracts.ts`; Test `src/tool-contracts.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("accepts evidence ids in techniques/antiPatterns sourceIds", () => {
  const payload = makeValidSuccess("create_ui_spec") as Record<string, unknown>;
  const data = payload.data as Record<string, unknown>;
  data.techniques = [{ text: "Use a right-side callout anchored to chart regions.", sourceIds: ["evidence-2"] }];
  data.antiPatterns = [{ text: "Avoids heavy chart chrome.", sourceIds: ["evidence-2"] }];
  const r = parseToolResult(payload);
  expect(r.ok, r.ok ? "" : JSON.stringify(r.errors)).toBe(true);
});

it("still refuses a raw corpus id in sourceIds", () => {
  const payload = makeValidSuccess("create_ui_spec") as Record<string, unknown>;
  (payload.data as Record<string, unknown>).techniques = [{ text: "x", sourceIds: ["corpus-abc123"] }];
  expect(parseToolResult(payload).ok).toBe(false);
});
```

Run: `npx vitest run src/tool-contracts.test.ts -t "sourceIds"`
Expected: FAIL — `evidence-2` is rejected as not matching `ref-<sha256>`.

- [ ] **Step 2: Move both positions.** In `src/tool-contracts.ts`, delete
  `"data.techniques[].sourceIds[]"` and `"data.antiPatterns[].sourceIds[]"`
  from `CREATE_UI_SPEC_SAFE_REFERENCE_LEAVES` and add them to
  `CREATE_UI_SPEC_EVIDENCE_ID_LEAVES`, with a comment:

```ts
  // Moved from the safe-reference domain in C3 Phase 1. These cite the
  // response-scoped evidence-N of the corpus entry a technique came from, not
  // a ref-<sha256> digest. Verified before the move: no producer populated
  // sourceIds, so no existing value changes meaning.
```

- [ ] **Step 3: Run and commit** — `npx vitest run src/tool-contracts.test.ts`,
  then `feat(contracts): sourceIds cites response-scoped evidence ids`

## Task 3: The identity screen

**Files:** Create `src/corpus-prose-screen.ts` + `.test.ts`

**Interfaces:** `screenProse(text, entry, deniedNames): string | null` — returns
the string unchanged, or `null` when it must be dropped. Never edits.
`buildDeniedNames(entries): ReadonlySet<string>` — derived from the corpus, not
hand-maintained.

- [ ] **Step 1: Write the failing tests**

```ts
it("drops a string naming its own entry's product", () => {
  expect(screenProse("How Mobbin works is the hook", entryNamed("Mobbin"), names)).toBeNull();
});
it("drops a string naming a different corpus product", () => {
  expect(screenProse("unlike Superhuman's triage", entryNamed("Other"), names)).toBeNull();
});
it("keeps a dictionary-word product name used as an ordinary noun", () => {
  // "Projects" is a corpus product name AND an English word; matching it
  // globally would drop ~8% of good rows.
  expect(screenProse("Group projects under one nav item", entryNamed("Other"), names)).not.toBeNull();
});
it("drops, never redacts", () => {
  const out = screenProse("How Mobbin works", entryNamed("Mobbin"), names);
  expect(out).toBeNull();          // not "How  works"
});
it("still applies the private-marker sweep", () => {
  expect(screenProse("see corpus-abc123", entryNamed("Other"), names)).toBeNull();
});
```

- [ ] **Step 2: Implement.** Word-boundary, case-insensitive. Denied set =
  the entry's own `source.productName` and `title` (always, even when they are
  dictionary words — the own-entry check is precise) UNION the corpus-derived
  distinctive names, excluding the six dictionary words
  (`Origin`, `Hive`, `People`, `Projects`, `Mercury`, `Untitled`). Then run
  `containsPrivateMarker`. Any hit → `null`.

- [ ] **Step 3: Full-corpus characterization test.** Assert the measured drop
  rates hold, so a future change to the name list is visible:
  `whatToSteal` ≈ 34/787, `antiPatterns` ≈ 21/787, `critique` ≈ 52/787. Use
  ranges, not exact equality, and state that these are characterization
  numbers rather than requirements.

- [ ] **Step 4: Commit** — `feat(corpus): identity screen for served prose`

## Task 4: Select prose into the six UiSpec fields

**Files:** Modify `src/create-ui-spec-deterministic.ts` + `.test.ts`,
`src/create-ui-spec.ts`

- [ ] **Step 1: Write the failing tests.** Extend `DeterministicSynthesis` with
  `techniques`, `antiPatterns`, `contentVoiceGuidance`,
  `accessibilityConstraints`, `componentInventory`, `responsiveBehavior`;
  assert each is populated from a fixture entry, each technique/anti-pattern
  carries its `evidenceId` in `sourceIds`, and a screened row is absent.

- [ ] **Step 2: Implement selection.** Caps from the spec: techniques ≤5,
  antiPatterns ≤5, voice examples ≤3 within 20–140 chars and rejecting
  `^[\d\s.,%$£€+-]+$`. `contentVoiceGuidance` composes ONE string:

```
{tone}. Avoid: {avoid joined by "; "}. Examples: {examples joined by " · "}.
```

  Each segment omitted entirely when its source is absent — never an empty
  label. Pin the composition with a test for each combination of present and
  absent segments.

- [ ] **Step 3: Wire into `assembleSpec`,** still gated on
  `proposal === undefined`. Sections with zero surviving rows keep their
  `unavailableDecisions` reason rather than rendering an empty list.

- [ ] **Step 4: Run and commit** — `feat(create-ui-spec): serve corpus judgment into six spec fields`

## Task 5: Fold group-B signals into `designDirection`

**Files:** Modify `src/create-ui-spec-deterministic.ts` + `.test.ts`

- [ ] **Step 1:** Add `styleTags`, `categories`, `mood`, `colorScheme`,
  `typePairing.notes`, `critique` as cited signals in the direction sentence.
  The composed direction is prose from the corpus, so it goes through
  `screenProse` as a whole before being emitted.
- [ ] **Step 2: Fix the template while you are here.** The current
  `Ground this ${productContext} in...` produces
  `"Ground this A login screen. in the matched corpus references"` on 12 of 12
  outputs. Rewrite so the brief is not spliced mid-sentence, and pin it with a
  multi-sentence brief fixture — the existing tests use short noun phrases and
  cannot catch this.
- [ ] **Step 3: Commit** — `fix(create-ui-spec): corpus signals in direction; repair the template`

## Task 6: Truthful surfaces

**Files:** Modify `src/create-ui-spec-mcp.ts`, `src/create-ui-spec-http.ts` (if
it carries the description), `src/tool-contracts.ts`, `src/design-handoff.ts`

- [ ] **Step 1: Tool description.** Replace the "No corpus content … is ever
  returned" promise with the spec's §6 wording. Grep both adapters — the
  promise may appear in more than one place.
- [ ] **Step 2: Leaf annotations.** `data.techniques[].text`,
  `data.antiPatterns[].text`, `data.contentVoiceGuidance`,
  `data.accessibilityConstraints[]` currently read "recipe-owned prose". They
  now carry corpus judgment. Rewrite each, and extend the annotation guard in
  `create-ui-spec-intent-guards.test.ts` to pin the new wording — the existing
  guards cover only the intent and acceptance positions, which is why the
  `designDirection` annotation went stale unnoticed.
- [ ] **Step 3: "Grounded in" rendering.** In `design-handoff.ts`, render the
  corpus evidence ids the spec cites as a distinct line. Do NOT touch
  `citedReferences` (see correction 2). Assert the Sources section no longer
  reads "(no cited references recorded)" while the direction cites ids.
- [ ] **Step 4: Commit** — `docs+contracts: surfaces tell the truth about served corpus judgment`

## Task 7: Verification

- [ ] **Step 1:** `npx tsc --noEmit && npx vitest run && node scripts/dogfood-createuispec.mjs`
  Expected: green, except the known pre-existing `mcp-smoke` "no corpus, no
  credentials" 10s timeout, which fails identically on `main`.
- [ ] **Step 2: Value audit, not a field count.** Run
  `node scripts/audit-spec-output.mjs` over a fresh 10-brief capture. Required:
  zero `broken-grammar`, zero `contradiction`, zero new `CRITICAL`. The
  contrast failures on `colorTokens` are expected to persist — Phase 3 owns
  them, and they must not be reported as regressions here.
- [ ] **Step 3: Full-corpus leak sweep.** Produce a spec for every one of the
  787 entries as the top match and assert no served byte contains any product
  name, title, or image path. This is the test that would have caught the 91
  identity-bearing prose rows.
- [ ] **Step 4: Report by the spec's numbers** — "6 of 13 sections filled,
  4 empty, 1 contradiction closed" — not "the body is filled". Quote measured
  values, per CLAUDE.md.

## Non-goals

- `mono` optional (Phase 2) and derived colour tokens (Phase 3).
- Extracting REJECTION clauses into `rejectedDefaults` — model lane.
- Any new `UiSpec` field or rendered section.
