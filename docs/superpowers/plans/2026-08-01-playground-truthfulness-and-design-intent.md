# Playground Truthfulness & Design Intent — Implementation Plan (rev 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `create_ui_spec` reading as broken when it is being honest, and give callers a structured, honored place to state design intent — closing #75, #76, #77, #78, #79.

**Architecture:** Two people partitioned by *critical-path ownership*. Worker 1 owns the core contract, producer, and durable guard tests. Worker 2 owns the site experience, repeatable dogfood script, and model-path design note. There is one implementation gate: S2 must land before T4 can wire the intent controls.

**Tech Stack:** TypeScript (NodeNext ESM), Zod v4, React 19 + Vite, Vitest, Node HTTP loopback server.

> **Rev 3 supersedes rev 2 after plan review.** Rev 1 shipped test code calling helpers that do not exist (`renderWithArtifact`, `artifactFixture`), a `res.spec` access against a function returning `{ envelope, sanitizedEvidence }`, an error-message claim contradicted by the repo, a discovery endpoint whose public/private dichotomy does not exist on the file it targets, and two cross-task contradictions. Rev 2 corrected those but over-specified intent identity/handoff threading, left T3 without concrete TDD, and allowed skipped guard tests to exist as a possible merge artifact. Rev 3 fixes those process risks and uses the faster two-person cut. Findings that changed the design are cited inline as **[R1]/[R2]/[R3]/[R4]**.

## Global Constraints

1. **Honesty invariant.** The product never claims evidence, authority, or a design decision it did not receive or derive. A caller-supplied fact may be echoed *as caller-supplied*. **This includes machine-readable provenance metadata, not just prose** — writing caller text into a position the leaf-classification map annotates as "recipe-owned" is an authority upgrade even when every test passes **[R3]**.
2. **Envelope integrity.** `parseDesignArtifactEnvelope` runs on every produced envelope (`src/create-ui-spec.ts:185`) and again at serve time, so the *re-render* half of the round-trip is guarded by construction. New caller intent must live in `spec.context`, where `semanticSpecSha256` already feeds artifact identity through `ArtifactIdentityInput.semanticSpecSha256` (`src/create-ui-spec-contracts.ts:935-940`). Do **not** add duplicate intent fields to `EnvelopeHandoffSchema` or `ArtifactIdentityInput` unless `parseDesignHandoff` actually consumes them; otherwise a hash can change while the visible spec forgot to honor intent **[R4]**. Every new semantic input needs an explicit collision test proving `spec.context → semanticSpecSha256 → artifactId`.
3. **Do not edit `src/c3/fallback-recipe-v1.json`.** `RECIPE_SHA256` (`src/create-ui-spec-contracts.ts:118`) is enforced fail-closed at `:1087-1090` and re-pinned at `src/c3/fallback-recipe-v1.test.ts:29` and `src/create-ui-spec.test.ts:463-470`.
4. **`SafeErrorMessage` is absolute.** No identifier, path, or corpus token in error text. Regex at `src/create-ui-spec-contracts.ts:181`; case-sensitive, substring-anywhere.
5. **Private mode never enumerates.** `ui-server.ts` is a **private-only surface** — `readerForCreateUiSpec()` hardcodes `new PrivateCorpusReader()` (`src/scripts/ui-server.ts:352-355`), and the comment at `:338-346` states there is no public variant. `CorpusReader` (`src/corpus-reader.ts:67-96`) exposes **no id-listing method**. Any enumeration feature must derive from an explicit reader *capability* defaulting to false — never from a mode string **[R3]**.
6. **No corpus mutation.** Nothing here writes `corpus/entries.json` or `corpus/decisions.json`. Frozen pending C5.
7. **C3 anchor.** `C3_RECIPE` pins by git commit (`src/readiness/checkpoint-policy.ts:476-487`), not live bytes. Editing live copies does not reopen C3. Do not re-anchor here.
8. **TDD**, and write the review artifact after each task (`.zcode/scripts/write-review-artifact`).

---

## Two-person implementation cut

**Use two people.** Three people can work with rev 2's file split, but the honest critical path is still S1→S2. A third worker mostly buys parallel guard/design work while adding review/rebase overhead. Rev 3 keeps the guard work, but folds it into the two-person process.

| | Worker 1 — Contract, producer, guards | Worker 2 — Site, dogfood, design |
|---|---|---|
| **Owns** | `src/create-ui-spec*.ts`, `src/tool-contracts.ts`, `src/scripts/ui-server.ts`, `src/wiring-verification.test.ts`, `src/create-ui-spec-client-bounds.test.ts`, `site/tests/create-ui-spec-fixture.ts`, `docs/superpowers/specs/2026-07-13-*.md`, `src/create-ui-spec-intent-guards.test.ts` | all `site/` **except** `site/tests/create-ui-spec-fixture.ts`, plus `scripts/dogfood-createuispec.mjs` and `docs/superpowers/specs/2026-08-*` |
| **Tasks** | S0, S1, S2, G1 | T1, T2, T3, T4, G2, G3 |
| **Load** | ~3 days, critical path + durable guards | ~2 days, some idle until S2 gate |

Ownership corrections forced by the audit **[R2]**:
- `site/tests/create-ui-spec-fixture.ts` moves to **Worker 1** — it imports `handleCreateUiSpecHttp` from `src/create-ui-spec-http.ts` and *produces real envelope bytes*, so it is a producer-contract fixture that merely lives under `site/`.
- `src/create-ui-spec-client-bounds.test.ts` was owned by nobody; it imports that fixture and asserts on `spec.acceptanceCriteria[0]`. → **Worker 1**.
- `docs/superpowers/specs/2026-07-13-agent-readiness-and-retagging-design.md` → **Worker 1**. `src/tool-contract-docs.test.ts:49-55` is an unconditional drift gate over its generated block (lines 439-631); S2 turns it red. A **second, ungated** hand-written Input table at `:389-405` must also be updated and nothing will catch its omission.
- `src/wiring-verification.test.ts` → **Worker 1** (single contiguous allowlist `Set` at `:135`; two workers appending = guaranteed conflict).
- New guard and dogfood/design files are assigned to one owner each, so the two-person cut still avoids cross-stream edits.

**One gate, not two.** Worker 1's S2 → Worker 2's T4. Rev 1's Gate 1 disappears because the error reword moved into Worker 1 as S0.

**Gate S2 → T4 must hand over three things, not one** **[R2]**: (a) both fields accepted by `CreateUiSpecRequestSchema` and forwarded by both adapters; (b) the exact bounds (`max(120)`, enum members) — `site/src/data/create-ui-spec.ts:74-78,114-140` hand-copies core bounds with no drift gate; (c) **where in the served response the intent appears**, since that is the only user-visible proof it was honored.

### Schedule

```
         day 1         day 2         day 3        day 4        day 5
W1:  S0 ── S1 ────── S2 ─────────── S2 ── G1 ────────
W2:  T1 ── T2 ── T3 ── G2 scaffold ── (gate) T4 ── G2 final/G3
```

S0 and T1 start in hour one. Worker 2 can complete T1/T2/T3 before the gate and scaffold G2 with the currently supported request shape. **S1 and S2 may still be prepared concurrently by Worker 1 on sibling local branches** — they touch different functions (`assembleSpec:727-738` vs `buildEnvelope:894-951`) — but land S1 first, rebase S2 over it, and do not ask for S2 review until S1 is merged **[R2][R4]**.

### Blocked on user decisions (blocks G3 only)

1. **"Saved to the corpus" — evidence or generated-artifact history?** Recommended: separate store; never the `corpus-observation` lane; honor the C5 freeze.
2. **Model determinism** — pin temperature 0 + seed, or split the integrity claim into *deterministic* vs *reproducible given {model, prompt, seed}*?
3. **C3 anchor** — re-anchor before signing, or accept historical-only?

---

## Worker 1 — Contract, Producer, And Guards

**Branch:** `feat/design-intent-inputs`

### Task S0: reword the unresolvable-reference error (#78, core half)

**Files:** Modify `src/create-ui-spec.ts:316`. **No test file needs editing** — the audit found the literal string appears exactly once in the repo and no test pins it; `src/create-ui-spec-mcp.test.ts:766-775` asserts only the error *code* **[R1][R2][R3]**.

- [ ] **Step 1:** Change `invalidInput("all supplied reference tokens could not be resolved")` to:

```ts
throw invalidInput("all supplied reference tokens could not be resolved; omit them to use automatic retrieval");
```

Rev 1 proposed "browse available references and retry". **Rejected** — it promises a listing that does not exist on this private-only surface **[R3]**. Verified against Constraint 4: no `://`, no `/` or `\`, no `node_modules`, no `dist/`, no `private`, no `corpus-`.

- [ ] **Step 2:** `npx vitest run src/create-ui-spec.test.ts src/create-ui-spec-mcp.test.ts` — expect PASS with no test edits.
- [ ] **Step 3:** Commit. `git commit -m "fix(create-ui-spec): point unresolvable-reference callers at automatic retrieval"`

### Task S1: caller constraints become acceptance criteria (#76)

**Files:**
- Modify: `src/create-ui-spec.ts` (`assembleSpec` `:679-793`; criteria block `:727-738`; spec literal `:768`)
- Modify: `src/tool-contracts.ts` leaf-annotation map (`:1009-1014`)
- Test: `src/create-ui-spec.test.ts`

**Schema facts (verified).** `AcceptanceCriterion` manual variant (`src/tool-contracts.ts:522-531`) is `.strict()` with exactly 8 required fields: `id`, `subject`, `assertion`, `expectedOutcome`, `verifier`, `priority`, `evidenceIds`, `manualSteps` (`.min(1)`). `AcceptanceAssertion` (`:486-489`) has 8 members incl. `exists` and `meets-contrast`. `AcceptancePriority` (`:490`) is `["must","should"]` only. `UiSpec`'s superRefine imposes nothing further on `acceptanceCriteria`. Site projection has no count cap **[R1]**.

**Two corrections the audit forced [R3]:**
- **`priority` is `"should"`, not `"must"`.** The caller supplies bare strings with no priority semantics; there is no "unspecified" member, so `should` is the honest floor. Stamping `must` invents a priority the caller never stated.
- **`subject` must make the rendered sentence parse.** `src/design-handoff.ts:403-406` renders `"<subject> <assertion> → <expectedOutcome>"`. With `subject: "caller-supplied constraint"` and `assertion: "exists"` that reads *"caller-supplied constraint exists"* — a claim about nothing. Use the constraint text as the subject.

- [ ] **Step 1: Write the failing test.** Note the real API: `createUiSpecForAdapter` returns `{ envelope, sanitizedEvidence }` (`src/create-ui-spec-contracts.ts:691-694`) — there is no `.spec` — and `deps` is a **function** `deps(corpus, ranked, resolveToken)` (`src/create-ui-spec.test.ts:147`) **[R1]**.

```ts
it("turns each caller constraint into a manual acceptance criterion", async () => {
  const res = await createUiSpecForAdapter(
    {
      productContext: "A settings screen for two-factor setup",
      constraints: ["AA contrast", "primary action always visible"],
    },
    deps([], []),
  );
  const criteria = res.envelope.spec.acceptanceCriteria;
  const ids = criteria.map((c) => c.id);
  expect(ids).toContain("caller-constraint-1");
  expect(ids).toContain("caller-constraint-2");
  expect(ids).toContain("fallback-manual-spec-review"); // recipe criterion survives
  const first = criteria.find((c) => c.id === "caller-constraint-1")!;
  expect(first.verifier).toBe("manual");
  expect(first.priority).toBe("should");        // NOT "must" — caller stated no priority
  expect(first.subject).toBe("AA contrast");
});
```

- [ ] **Step 2:** `npx vitest run src/create-ui-spec.test.ts -t "manual acceptance criterion"` → FAIL (only the recipe criterion exists).

- [ ] **Step 3: Implement.** Rename the existing `:729` result to `recipeCriteria`, append after `:738`, and use the combined array at `:768`:

```ts
// Caller-supplied constraints are FACTS THE CALLER STATED, not invented judgment,
// so echoing them as checkable criteria is inside the honesty invariant. `manual`
// because nothing here can verify them; no evidenceIds because no evidence grounds
// a caller assertion; `should` because the caller stated no priority and there is
// no "unspecified" member of AcceptancePriority.
const callerCriteria = request.constraints.map((text, i) => ({
  id: `caller-constraint-${i + 1}`,
  subject: text,
  assertion: "exists" as const,
  expectedOutcome: `The delivered UI satisfies this caller-stated constraint: ${text}`,
  verifier: "manual" as const,
  priority: "should" as const,
  evidenceIds: [] as string[],
  manualSteps: [`Confirm by inspection that the UI satisfies: ${text}`],
}));

const acceptanceCriteria = [...recipeCriteria, ...callerCriteria];
```

- [ ] **Step 4: Update the leaf-classification annotations — REQUIRED, not optional [R3].** `src/tool-contracts.ts:1009-1014` currently annotates `data.acceptanceCriteria[].subject` as *"recipe-owned subject label"*, `expectedOutcome` as *"recipe-owned expectation prose"*, `manualSteps[]` as *"recipe-owned manual verification steps"*. After this task those positions carry caller prose. The gate returns immediately for the `free-text` class, so **no test will object** — the annotations must be corrected by hand or the product's own provenance record asserts something false. Amend each to note both lanes, e.g. *"recipe-owned label, or caller-supplied constraint text for `caller-constraint-*` rows"*.

- [ ] **Step 5: Record the assembly-rules coverage note [R3].** `assemblyRulesSha256` is a hash of the recipe *file*, and `RECIPE.acceptanceCriteria` holds one entry while an artifact may now carry up to 13. Nothing breaks — the hash never covered the output — but add a comment at the append site stating that `spec.acceptanceCriteria` is no longer fully derivable from the frozen rules.

- [ ] **Step 6:** `npx vitest run src/create-ui-spec.test.ts src/create-ui-spec-contracts.test.ts src/create-ui-spec-client-bounds.test.ts src/c3/ && npm run build`. Note `client-bounds.test.ts:66,112-113` asserts on `acceptanceCriteria[0]`, which stays the recipe criterion because we append — verify, don't assume **[R2]**.

- [ ] **Step 7:** Commit. `git commit -m "feat(create-ui-spec): honor caller constraints as manual acceptance criteria"`

### Task S2: structured design-intent inputs (#79)

**Files:** `src/create-ui-spec-contracts.ts` (request `:204-219`; semantic identity already via `:935-961`; re-derivation `:1046-1051`, `:1099-1106`), `src/tool-contracts.ts` (`CreateUiSpecInput` `:782-794`; leaf annotations), `src/create-ui-spec.ts` (`spec.context` literal `:743-750`), `src/design-handoff.ts` (`renderContextSection` `:426-444`), `src/create-ui-spec-mcp.ts:204`, `src/create-ui-spec-http.ts:237`, `docs/superpowers/specs/2026-07-13-agent-readiness-and-retagging-design.md`.
**Tests:** `src/create-ui-spec-contracts.test.ts`, `src/tool-contracts.test.ts`, `src/create-ui-spec.test.ts`, `src/create-ui-spec-mcp.test.ts`, `src/create-ui-spec-http.test.ts`, `src/tool-contract-docs.test.ts` **[R2]**.

**No new authority lane needed.** `TokenAuthority` already has `"project-constraint"` (`src/tool-contracts.ts:482-484`), gated on `hasConstraints` (`:703-723`) and inert today. Null-token contract (`:653-673`): `colorTokens === null` requires `colorTokenAuthority === "editorial"` **and** an `unavailableDecisions` entry; non-null must have **no** such entry. Flip both atomically or `UiSpec.safeParse` fails.

**Scope: NARROW — decided, not deferred [R3].** Intent is *recorded*, tokens stay `null`. A caller saying "light blue" has not supplied the five required `ColorTokens` members (`:557-563`); synthesizing them from a mood word is invention.

**Intent must surface in `spec.context`, not `envelope.handoff` [R3][R4].** Rev 1 threaded intent through the handoff only. But `site/src/data/create-ui-spec.ts` projects `spec`, never `handoff`, and `src/design-handoff.ts` renders from `spec` — so intent would be accepted, hashed into `artifactId`, and then invisible in the UI, in `design.md`, and everywhere else. `data.context.*` is already the annotated caller-supplied lane (`src/tool-contracts.ts:977`, `:981`), which is the correct home. Add leaf annotations for the new positions.

**Single source of identity truth [R4].** `ArtifactIdentityInput` already contains `semanticSpecSha256`; `parseDesignArtifactEnvelope` recomputes that semantic hash from `env.spec`. Therefore intent should affect identity by changing `spec.context`, not by adding a parallel `colorIntent`/`typeIntent` copy to `ArtifactIdentityInput` or `EnvelopeHandoffSchema`. Do not add those duplicate handoff/identity fields unless `parseDesignHandoff` is changed to consume them for rendering. The guard is the test in Step 3: if `spec.context` is forgotten, both `semanticSpecSha256` and `artifactId` must fail to change.

- [ ] **Step 1: Add the schemas** next to the request contract:

```ts
/** Structured design intent supplied by the CALLER. Never inferred from prose,
 *  never upgraded to corpus evidence. Mirrors MotionIntentSchema's discipline:
 *  explicit, bounded, `.strict()`. */
export const ColorIntentSchema = z.object({
  accentPreference: z.string().trim().min(1).max(120).optional(),
  mood: z.string().trim().min(1).max(120).optional(),
  contrastFloor: z.enum(["AA", "AAA"]).optional(),
}).strict();

export const TypeIntentSchema = z.object({
  voice: z.string().trim().min(1).max(120).optional(),
  density: z.enum(["compact", "regular", "spacious"]).optional(),
}).strict();
```

Add to `CreateUiSpecRequestSchema` as `colorIntent: ColorIntentSchema.optional()` / `typeIntent: TypeIntentSchema.optional()`.

- [ ] **Step 2: Thread the six required layers**, running tests after each. (1) request schema → (2) `CreateUiSpecInput` mirror → (3) `spec.context` + its leaf annotations → (4) producer spec assembly at `src/create-ui-spec.ts:743-750` → (5) `src/design-handoff.ts` context rendering so `design.md` displays the intent → (6) both adapters (`src/create-ui-spec-mcp.ts:204`, `src/create-ui-spec-http.ts:237`) and docs.

  **Do not** add `colorIntent`/`typeIntent` to `ArtifactIdentityInput`, `buildArtifactIdentityInput`, or `EnvelopeHandoffSchema` as a parallel identity lane. Intent identity must flow through `spec.context` into `semanticSpecSha256`, then into the existing artifact identity input. If this proves impossible because `parseDesignHandoff` needs extra non-spec inputs, stop and update the plan before coding.

- [ ] **Step 3: Write the identity-through-spec test** (G1 keeps a broader durable copy, but S2 must not merge without this local proof):

```ts
it("gives two requests differing only in colorIntent distinct artifactIds", async () => {
  const base = { productContext: "A settings screen for two-factor setup" };
  const a = await createUiSpecForAdapter({ ...base, colorIntent: { accentPreference: "light blue" } }, deps([], []));
  const b = await createUiSpecForAdapter({ ...base, colorIntent: { accentPreference: "warm red" } }, deps([], []));
  expect(a.envelope.spec.context.colorIntent).toEqual({ accentPreference: "light blue" });
  expect(b.envelope.spec.context.colorIntent).toEqual({ accentPreference: "warm red" });
  expect(a.envelope.semanticSpecSha256).not.toBe(b.envelope.semanticSpecSha256);
  expect(a.envelope.artifactId).not.toBe(b.envelope.artifactId);
});
```

- [ ] **Step 4: Forward through both adapters.** `src/create-ui-spec-mcp.ts:204` and `src/create-ui-spec-http.ts:237` map fields one-by-one, not by spread; `src/create-ui-spec-mcp.test.ts:586` derives its key set from `CreateUiSpecRequestSchema.shape`.

- [ ] **Step 5: Satisfy both drift gates** — `src/tool-contracts.test.ts:1264-1280` (structural) and `:1287-1340` (behavioural). Add behavioural cases; do not merely make the structural gate pass.

- [ ] **Step 6: Regenerate the tool-contract docs [R2].** `src/tool-contract-docs.test.ts:49-55` compares the generated block (lines 439-631) byte-for-byte against `renderToolContractReference()`. Also hand-update the **ungated** duplicate Input table at `:389-405` of the same file — nothing will catch its omission.

- [ ] **Step 7:** `npm run build && npx vitest run src/`. Confirm `RECIPE_SHA256` unchanged versus `main`.

- [ ] **Step 8: Commit and open the gate** with all three handover items (fields, exact bounds, response location).

### Task G1: durable guard tests for the unguarded positions

**Files:**
- Create: `src/create-ui-spec-intent-guards.test.ts`
- Test-only imports: `src/create-ui-spec.ts`, `src/create-ui-spec-contracts.ts`, `src/design-handoff.ts`, `src/tool-contracts.ts`

**Merge rule [R4]:** The final G1 PR must contain active tests only. A temporary local proof commit may use `it.fails` or `describe.skip` against `main`, but that proof commit must not merge. Before review, every guard below must run as a normal active Vitest test — no `skip`, no `todo`, no remaining expected-failure wrapper.

- [ ] **Step 1: Write active guard tests after S1/S2 land.** Cover the exact gaps the audit found:
  - artifactId distinctness across differing `colorIntent` and differing `typeIntent`
  - semantic-hash distinctness for differing intent, proving intent lives in `spec.context`
  - every caller-constraint `acceptanceCriteria` row renders into a grammatical sentence via `src/design-handoff.ts`
  - leaf-annotation truthfulness for `CREATE_UI_SPEC_FREE_TEXT_LEAVES`, including the `caller-constraint-*` lane

- [ ] **Step 2:** `npx vitest run src/create-ui-spec-intent-guards.test.ts` → PASS with all tests active.

- [ ] **Step 3:** Search for inert guards before committing:

```bash
rg -n "describe\\.skip|it\\.skip|test\\.skip|it\\.todo|test\\.todo|it\\.fails|test\\.fails" src/create-ui-spec-intent-guards.test.ts
```

Expected: no matches.

- [ ] **Step 4:** Commit. `git commit -m "test(create-ui-spec): add durable intent truthfulness guards"`

---

## Worker 2 — Site, Dogfood, And Design

**Branch:** `feat/playground-truthfulness`

**Real test helpers (rev 1 invented two that do not exist) [R1][R2]:** `envelopeFixture(overrides)` `site/src/pages/PlaygroundPage.test.tsx:70`, `renderComposer()` `:242`, `generateSuccessfully(envelope)` `:271`, `successQueue()` `:230`, `fallbackEnvelope()` `:173`. They take the **raw wire envelope**, not `SafeArtifact` — the fallback flag on the wire is `retrieval.fallbackUsed` (`:160-164`). `within`/`screen` are imported at `:21`.

### Task T1: surface the stable hash (#77)

**Files:** Modify `site/src/pages/PlaygroundPage.tsx:805-834`. Test: `site/src/pages/PlaygroundPage.test.tsx`.
`SafeArtifact.semanticSpecSha256` is already parsed and carried (`site/src/data/create-ui-spec.ts:255,516,609`) and currently unrendered — no data-layer change. The existing integrity test `:531-536` uses order-independent `toContain`, so reordering is safe **[R1][R2]**.

- [ ] **Step 1: Failing test**

```tsx
it("leads the integrity panel with the run-stable semantic hash", async () => {
  await generateSuccessfully();
  const region = screen.getByRole("region", { name: /artifact integrity/i });
  const terms = within(region).getAllByRole("term").map((t) => t.textContent ?? "");
  expect(terms[0]).toMatch(/semantic spec sha-256/i);
  expect(within(region).getByText(/include generation time/i)).toBeInTheDocument();
});
```

- [ ] **Step 2:** Run → FAIL (first term is `Artifact`).
- [ ] **Step 3: Implement.** Reorder the `<dl>` at `:809-834` to put `Semantic spec SHA-256` (`artifact.semanticSpecSha256`) first, then `Producer`, then `Artifact`, `Generated at`, and the three byte digests. Replace the note at `:805`:

```tsx
<p className="artifact__note">
  The semantic hash covers the spec's content: regenerate with the same inputs and it is
  identical. The digests below it cover exact bytes and include generation time, so they
  change on every run even when nothing about the design changed.
</p>
```

  Rev 1 wrote *"same **brief** → identical"*. **Corrected to "same inputs"** — S2 records intent in `spec.context`, so two different intents must produce different semantic hashes; the absolute "brief" wording would have been falsified by S2 on day 3 **[R3]**.

- [ ] **Step 4:** `npx vitest run site/src/pages/PlaygroundPage.test.tsx` → PASS.
- [ ] **Step 5:** Commit.

### Task T2: producer-aware disclosure (#75)

**Files:** Modify `site/src/pages/PlaygroundPage.tsx:174-186` (`successLabel`) and the unavailable-fields note at `:739-742`. Test: same test file.

**Root cause (verified).** The honest sentence exists at `:176` but is gated on `evidence.fallbackUsed` = *"retrieval matched nothing"*, not *"no model attached"*. In the normal case (retrieval matches) the user gets "…with 1 warning. Some fields were unavailable," which reads as degradation.

**Two regression traps rev 1 missed [R1][R3]:**
- `:628` asserts `expect(status).toMatch(/fallback/i)` — the replacement clause **must keep the word "fallback"**.
- `:667` asserts `not.toMatch(/fallback/i)` on a non-fallback envelope. The real producer id **`"c3-fallback-v1"` contains "fallback"**, so interpolating `producerVersion` into the status trips it. Do **not** interpolate the id into the status string.
- `envelopeFixture` sets `producerVersion: "create-ui-spec/1.0.0"` (`:149`) while production emits `"c3-fallback-v1"`, so a naive test passes vacuously. The new test must set the production value explicitly.

- [ ] **Step 1: Failing test**

```tsx
it("discloses the deterministic producer even when retrieval succeeded", async () => {
  await generateSuccessfully(envelopeFixture({ producerVersion: "c3-fallback-v1" }));
  const status = screen.getByRole("status").textContent ?? "";
  expect(status).toMatch(/no model attached/i);
  expect(status).toMatch(/declined by design/i);
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.** Replace `successLabel`:

```tsx
/** Producers that consult no model. Color, typography and motion are declined by
 *  these producers as a rule, not because the brief was weak. */
const DETERMINISTIC_PRODUCERS = new Set(["c3-fallback-v1"]);

function successLabel(artifact: SafeArtifact): string {
  const parts: string[] = [];
  const count = artifact.warnings.length + artifact.droppedWarningCount;

  parts.push(
    count > 0
      ? `Generated a design handoff with ${count} ${count === 1 ? "warning" : "warnings"}.`
      : "Generated a complete design handoff.",
  );

  // NOTE: never interpolate producerVersion — "c3-fallback-v1" contains "fallback"
  // and would trip the not.toMatch(/fallback/i) assertion on non-fallback runs.
  if (DETERMINISTIC_PRODUCERS.has(artifact.producerVersion)) {
    parts.push(
      "This is a deterministic scaffold with no model attached. Color, typography and " +
        "motion are declined by design, not missing because of your brief.",
    );
  }

  if (artifact.evidence.fallbackUsed) {
    parts.push(
      "Automatic retrieval matched nothing, so this used the deterministic fallback " +
        "and no corpus evidence grounds it.",
    );
  }

  return parts.join(" ");
}
```

  Check `:629`, `:668`, `:685` (`not.toMatch(/complete design handoff/i)`): the zero-warning branch still emits that phrase, so confirm those fixtures all carry ≥1 warning; if any does not, adjust the first clause rather than the assertion.

- [ ] **Step 4:** `npx vitest run site/` and `npx vitest run --config site/vite.config.ts` → PASS, `:624-629` and `:667` included.
- [ ] **Step 5:** Commit.

### Task T3: reference guidance (#78, UI half)

**Files:** Modify `site/src/pages/PlaygroundPage.tsx` (`failureLabel`, `PlaygroundComposer`, explicit-references field `:477-496`). Test: `site/src/pages/PlaygroundPage.test.tsx`.

Rev 1's autocomplete is **cancelled** — `ui-server.ts` is private-only with no id-listing method (Constraint 5). Instead: on the explicit-references field (`:477-496`), add helper copy linking to `/browse`, and when an explicit-reference submission receives a 400, surface client-authored copy matching S0's remedy. No endpoint, no enumeration, and do not render the server's `error.message`; `site/src/data/create-ui-spec.ts:439-444` deliberately discards it.

- [ ] **Step 1: Failing helper-copy test.**

```tsx
it("points explicit-reference users to browse without enumerating reference ids", () => {
  renderComposer();
  fireEvent.click(screen.getByText(/advanced: explicit reference override/i));
  const hint = screen.getByText(/automatic retrieval off/i);
  expect(hint.textContent ?? "").toMatch(/browse/i);
  const link = within(hint).getByRole("link", { name: /browse/i });
  expect(link.getAttribute("href")).toBe("/browse");
  expect(hint.textContent ?? "").not.toMatch(/corpus-|public-ref-|decision-/i);
});
```

- [ ] **Step 2:** `npx vitest run site/src/pages/PlaygroundPage.test.tsx -t "explicit-reference users"` → FAIL.

- [ ] **Step 3: Failing 400-copy test.**

```tsx
it("gives explicit-reference 400s the automatic-retrieval remedy without rendering server text", async () => {
  installFetch([
    { status: 200, json: { nonce: NONCE } },
    {
      status: 400,
      json: {
        error: {
          code: "INVALID_INPUT",
          message: "server-only-diagnostic missing-reference-token",
          retryable: false,
        },
      },
    },
  ]);
  renderComposer();
  typeBrief();
  fireEvent.click(screen.getByText(/advanced: explicit reference override/i));
  fireEvent.change(screen.getByLabelText(/explicit reference/i), {
    target: { value: "missing-reference-token" },
  });
  fireEvent.click(generateButton());
  await waitFor(() =>
    expect(screen.getByRole("status").textContent ?? "").toMatch(/omit them to use automatic retrieval/i),
  );
  expect(screen.getByRole("status").textContent ?? "").not.toMatch(/missing-reference-token/i);
});
```

- [ ] **Step 4:** `npx vitest run site/src/pages/PlaygroundPage.test.tsx -t "explicit-reference 400s"` → FAIL.

- [ ] **Step 5: Implement.** Track whether the submitted brief had explicit references when setting a failure lifecycle, and pass that fact into client-authored failure copy. Keep server error bodies discarded in `site/src/data/create-ui-spec.ts`.

```tsx
interface FailureLifecycle {
  readonly kind: "failure";
  readonly failure: CreateUiSpecFailure;
  readonly explicitReferences: boolean;
}

function statusLabel(lifecycle: Lifecycle): string {
  // unchanged idle/generating/success cases
  return failureLabel(lifecycle.failure, lifecycle.explicitReferences);
}

function failureLabel(failure: CreateUiSpecFailure, explicitReferences = false): string {
  if (failure.code === "INVALID_INPUT" && explicitReferences) {
    return "The explicit references could not be resolved; omit them to use automatic retrieval.";
  }
  // existing switch body for every other case
}
```

- [ ] **Step 6:** Update the explicit-reference hint to include a `/browse` link and no token examples:

```tsx
<p className="composer__hint" id={id("references-hint")}>
  Up to {MAX_REFERENCE_IDS} public references. Supplying any of these turns automatic
  retrieval off for this run. Find candidates in <Link to="/browse">Browse</Link>.
</p>
```

- [ ] **Step 7:** `npx vitest run site/src/pages/PlaygroundPage.test.tsx` → PASS.

- [ ] **Step 8:** Commit. `git commit -m "fix(site): guide explicit-reference recovery without enumeration"`

### Task T4: intent form fields (#79 UI) — BLOCKED ON THE GATE

After S2 merges: add `colorIntent`/`typeIntent` controls, extend the request builder (`site/src/data/create-ui-spec.ts:153-174`), hand-copy the bounds from the gate handover, and **project the intent from `spec.context` into `SafeArtifact`** so the user can see it was honored. Add tests that (a) request bodies include the fields, (b) over-bound values are rejected locally using the S2 bounds, (c) the rendered artifact displays intent from `spec.context`, and (d) no `envelope.handoff.colorIntent` / `envelope.handoff.typeIntent` path is required by the client.

---

### Task G2: dogfood script

Create `scripts/dogfood-createuispec.mjs` — the harness from this session's manual run, made repeatable: happy paths, validation fail-closed cases, CSRF/origin security cases, and a determinism check comparing `semanticSpecSha256` (stable) against `specSha256` (volatile). Must include a brief carrying **both constraints and intent** — the rev 1 verification exercised neither **[R3]** — and a private-mode body scan asserting zero corpus ids in any response.

### Task G3: model-path design spec — BLOCKED ON THE THREE DECISIONS

Create `docs/superpowers/specs/2026-08-<dd>-create-ui-spec-model-path-design.md`. Design only, no code. Cover: the missing evidence lane (`EvidenceKindSchema` has three members, none fits model output; `recipe-system` is explicitly operator content); a pinned `{provider, baseUrl, apiKey, model}` endpoint reusing the `tagger.ts` pattern and its ban on ambient env-driven model resolution (`src/tagger.ts:360-366`); the fallback floor; the split integrity claim; output storage per decision 1 (recommended: a store separate from `corpus/entries.json`, so model output can never be retrieved later as a `corpus-observation`); and token authority against `TokenAuthority` + the null-token superRefine.

---

## Verification (both workers merged)

- [ ] `npm run build` clean; `npx vitest run` full suite green
- [ ] Readiness gate unchanged both modes: `ok: true`, `{C0 closed, C1 closed, C2 closed, C3-C5 open}`, 0 issues, `ledgerPinScope: tracked`, warnings `["c2-external-qa-unverifiable"]`
- [ ] `RECIPE_SHA256` (`src/create-ui-spec-contracts.ts:118`) unchanged versus `main`
- [ ] `node scripts/dogfood-createuispec.mjs` green, including the constraints+intent brief and the private-mode leak scan
- [ ] Two artifacts differing only in `colorIntent` have different `artifactId` **and** different `semanticSpecSha256`
- [ ] `design.md` for a constrained brief renders caller criteria as grammatical sentences
- [ ] Cross-model `/codex review` on the combined diff — required for contract-bearing changes in this repo
