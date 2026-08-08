# Verifier Abstain Diagnosis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every model-lane abstain a machine-readable cause and call site, then re-measure the committed cohort read-only to find out what `not positively confirmed` actually means.

**Architecture:** Three additive changes to `src/scripts/verify-corpus.ts`. `parseVerifyResponse` stamps a cause on each field at parse time (the `failClosed` Proxy takes the absent-key cause as a parameter, so the three return sites report three different causes). `decideFieldVerdict` carries that cause onto the `FieldVerdict` and appends the model's own reason to the reason string. `buildRunReport` prints a breakdown. A `--diagnose` flag bypasses both resume skips while forcing dry-run, and takes an explicit `--only-ids` list so the run measures the cohort rather than the first N entries in corpus order.

**Tech Stack:** TypeScript (ES modules, `.js` import specifiers), Node `parseArgs`, vitest.

## Global Constraints

Copied verbatim from `docs/superpowers/specs/2026-08-08-verifier-abstain-diagnosis-design.md`.

- **Governing invariant:** a diagnosis run produces measurement and nothing else — no verdict LOGIC changes, `corpus/entries.json` is byte-identical, no schema change.
- "No verdict logic changes" means: for a given parsed response, every branch returns the same `verdict` it returns today. Only the reason string and the new `cause`/`site`/`firstCause` fields differ.
- The cause is **not persisted** to the corpus. `provenance.verifyAttempts` is `.passthrough()` (`src/schema.ts:652-655`), so promoting it later is one line — but this plan writes nothing.
- `--diagnose` REQUIRES `--only-ids` and fails loudly when absent. `--only-ids` without `--diagnose` is an error, not a no-op. There is no invocation that re-measures the full corpus by accident.
- An id in `--only-ids` that is not in the corpus fails loudly rather than being silently skipped.
- No prompt change. No new or re-enabled detectors. No corpus backfill.
- TDD: failing test first, then implementation, then commit. Every task.
- Corpus isolation: tests never write to the real `corpus/entries.json`. Use the `--corpus` seam (`:1175`) or the existing test-path injection.
- Review artifact after every task, before the next commit — `.zcode/scripts/write-review-artifact` (see `CLAUDE.md`). The git hook blocks otherwise.

### Known-failing baseline (measured on `fb055fa`, 2026-08-08)

`npm test` is **not green on this branch point**: 3 failed files / 3 failed tests of 3648. All three predate this work and none touches `src/scripts/verify-corpus.ts`. Do not "fix" them here, and do not read them as regressions.

| test | failure | note |
|---|---|---|
| `src/mcp-smoke.test.ts` | `STALE BUILD: the compiled server under test is older than its sources` | Environmental. `npm run build` clears it — Task 7 step 1 runs the build anyway, so this one should be green by the end. |
| `src/tagger.test.ts:1042` | expected `{ thinkingBudget: 0 }`, received `{ thinkingLevel: 'MINIMAL' }` | Real drift in the Gemini thinking-config shape. Unrelated. |
| `src/readiness/tracked-artifacts-readiness.test.ts:435` and `:468` | `corpus-hash-mismatch:phase0-20260714` | Reads real data; the corpus has drifted from the pinned phase0 hash. Relevant context for Task 7 step 3, where a cohort id may no longer resolve. |

A run at the end of this branch must show **exactly these**, minus `mcp-smoke` once the build is current. Any fourth failure is this work's, and stops the branch review.

---

## File Structure

| file | responsibility | change |
|---|---|---|
| `src/scripts/verify-corpus.ts` | the verifier CLI and its pure helpers | modify — all production changes land here; the module already owns parse, decide, report, and `main` |
| `src/scripts/verify-corpus.test.ts` | its tests | modify — all new tests land here alongside the existing suite |
| `docs/verifier-abstain-diagnosis.md` | the run's output document | create (Task 7) |

No new modules. Every change is inside functions that already exist, and splitting `verify-corpus.ts` is explicitly out of scope — it is large, but restructuring it is unrelated to this goal and would make the diff unreviewable against the invariant.

---

### Task 1: Characterization test pinning today's verdict logic

This task adds **no production code**. It writes the guard that every later task is checked against. It must pass on unmodified `main` — that is what makes it a characterization test rather than a wish.

**Files:**
- Test: `src/scripts/verify-corpus.test.ts`

**Interfaces:**
- Consumes: `decideFieldVerdict(field, tier, parsed)` and `ParsedField` as they exist today.
- Produces: nothing consumed by later tasks. Later tasks must keep this test green.

- [ ] **Step 1: Write the characterization test**

Append to `src/scripts/verify-corpus.test.ts`:

```ts
describe("decideFieldVerdict — verdict logic characterization (governing invariant)", () => {
  // Every (tier x parsed-state) combination the function can see, with the
  // verdict it returns TODAY. Later tasks add `cause`, `site` and richer reason
  // strings; if any of them moves a VERDICT, this table fails.
  const PARSED_STATES: Array<{ name: string; parsed: ParsedField }> = [
    { name: "confirmed", parsed: { confirmed: true, contradicted: false } },
    { name: "contradicted", parsed: { confirmed: false, contradicted: true } },
    { name: "neither", parsed: { confirmed: false, contradicted: false } },
    { name: "confirmed with assertions", parsed: { confirmed: true, contradicted: false, assertions: ["a", "b"] } },
    { name: "contradicted with assertions", parsed: { confirmed: false, contradicted: true, assertions: ["a"] } },
    { name: "neither with assertions", parsed: { confirmed: false, contradicted: false, assertions: ["a"] } },
    { name: "confirmed with empty assertions", parsed: { confirmed: true, contradicted: false, assertions: [] } },
    { name: "contradicted with empty assertions", parsed: { confirmed: false, contradicted: true, assertions: [] } },
    { name: "neither with empty assertions", parsed: { confirmed: false, contradicted: false, assertions: [] } },
  ];

  const EXPECTED: Record<VerifierTier, Record<string, FieldVerdict["verdict"]>> = {
    gated: {
      "confirmed": "gate",
      "contradicted": "gate",
      "neither": "gate",
      "confirmed with assertions": "gate",
      "contradicted with assertions": "gate",
      "neither with assertions": "gate",
      "confirmed with empty assertions": "gate",
      "contradicted with empty assertions": "gate",
      "neither with empty assertions": "gate",
    },
    prose: {
      // Prose gates FIRST on an empty assertion list — before the contradicted
      // check — so an empty list gates even when contradicted is true.
      "confirmed": "gate",
      "contradicted": "gate",
      "neither": "gate",
      "confirmed with assertions": "pass",
      "contradicted with assertions": "contradicted",
      "neither with assertions": "abstain",
      "confirmed with empty assertions": "gate",
      "contradicted with empty assertions": "gate",
      "neither with empty assertions": "gate",
    },
    mechanical: {
      "confirmed": "pass",
      "contradicted": "contradicted",
      "neither": "abstain",
      "confirmed with assertions": "pass",
      "contradicted with assertions": "contradicted",
      "neither with assertions": "abstain",
      "confirmed with empty assertions": "pass",
      "contradicted with empty assertions": "contradicted",
      "neither with empty assertions": "abstain",
    },
    factual: {
      "confirmed": "pass",
      "contradicted": "contradicted",
      "neither": "abstain",
      "confirmed with assertions": "pass",
      "contradicted with assertions": "contradicted",
      "neither with assertions": "abstain",
      "confirmed with empty assertions": "pass",
      "contradicted with empty assertions": "contradicted",
      "neither with empty assertions": "abstain",
    },
    soft: {
      "confirmed": "pass",
      "contradicted": "contradicted",
      "neither": "abstain",
      "confirmed with assertions": "pass",
      "contradicted with assertions": "contradicted",
      "neither with assertions": "abstain",
      "confirmed with empty assertions": "pass",
      "contradicted with empty assertions": "contradicted",
      "neither with empty assertions": "abstain",
    },
    a11y: {
      "confirmed": "pass",
      "contradicted": "contradicted",
      "neither": "abstain",
      "confirmed with assertions": "pass",
      "contradicted with assertions": "contradicted",
      "neither with assertions": "abstain",
      "confirmed with empty assertions": "pass",
      "contradicted with empty assertions": "contradicted",
      "neither with empty assertions": "abstain",
    },
  };

  for (const [tier, byState] of Object.entries(EXPECTED) as Array<[VerifierTier, Record<string, FieldVerdict["verdict"]>]>) {
    for (const { name, parsed } of PARSED_STATES) {
      it(`${tier} / ${name} -> ${byState[name]}`, () => {
        expect(decideFieldVerdict("someField", tier, parsed).verdict).toBe(byState[name]);
      });
    }
  }
});
```

Add `VerifierTier`, `FieldVerdict`, `ParsedField`, and `decideFieldVerdict` to the file's existing import from `./verify-corpus.js` if any are missing.

- [ ] **Step 2: Run it and confirm it passes on unmodified code**

Run: `npx vitest run src/scripts/verify-corpus.test.ts -t "verdict logic characterization"`
Expected: PASS, 54 tests.

If a case FAILS, do not edit the production code. The table is wrong — read the branch in `decideFieldVerdict` (`:318-344`) and correct the expectation. The table's job is to describe reality, not to improve it.

- [ ] **Step 3: Verify `VerifierTier` covers exactly the six tiers used**

Run: `grep -n "VerifierTier" src/verify-tiers.ts src/scripts/verify-corpus.ts | head`
Expected: the union is `mechanical | factual | prose | soft | a11y | gated`. If a seventh tier exists, add its block to `EXPECTED` — a missing tier silently drops that branch from the guard.

- [ ] **Step 4: Commit**

```bash
git add src/scripts/verify-corpus.test.ts
git commit -m "test(verify): characterize decideFieldVerdict's verdict logic before changing it

The abstain-cause work touches every branch of decideFieldVerdict. The governing
invariant is that no VERDICT moves — only reason strings and new fields. This
table pins all six tiers against all nine parsed states so a moved branch fails
loudly instead of being noticed in a run report weeks later."
```

- [ ] **Step 5: Write the task review artifact**

```bash
.zcode/scripts/write-review-artifact --type task --result approved --reviewer agent \
  --base-sha $(git rev-parse HEAD^) --head-sha $(git rev-parse HEAD) \
  --branch feat/verifier-abstain-diagnosis
```

---

### Task 2: Cause taxonomy at parse time

**Files:**
- Modify: `src/scripts/verify-corpus.ts:255-316` (`ParsedField`, `failClosed`, `parseVerifyResponse`)
- Test: `src/scripts/verify-corpus.test.ts`

**Interfaces:**
- Produces:
  - `export type AbstainCause = "response-unparseable" | "response-not-object" | "field-absent" | "field-not-object" | "verdict-missing" | "verdict-unrecognised" | "model-abstained" | "corroboration-split" | "corroboration-error"`
  - `export type VerifyCallSite = "initial" | "corroborate" | "reverify"`
  - `ParsedField` gains `cause?: AbstainCause` and `rawVerdict?: string`
  - `failClosed(out: Record<string, ParsedField>, absentCause: AbstainCause)`
- Consumes: nothing from Task 1.

Note on the spec: `verdict-unrecognised` is **not** a branch that exists today — `parseVerifyResponse` currently maps any unrecognised verdict string to `{ confirmed: false, contradicted: false }` and discards the literal. This task adds that branch. After it lands, the taxonomy is one cause per branch.

- [ ] **Step 1: Write the failing tests**

Append to `src/scripts/verify-corpus.test.ts`:

```ts
describe("parseVerifyResponse — abstain cause taxonomy", () => {
  it("tags every field response-unparseable when the JSON does not parse", () => {
    const parsed = parseVerifyResponse("this is not json {{{");
    expect(parsed.layout).toEqual({ confirmed: false, contradicted: false, cause: "response-unparseable" });
    expect(parsed.mood.cause).toBe("response-unparseable");
  });

  it("tags every field response-not-object when the payload is a bare scalar", () => {
    const parsed = parseVerifyResponse("42");
    expect(parsed.layout.cause).toBe("response-not-object");
  });

  it("tags an absent key field-absent when other keys parsed fine", () => {
    const parsed = parseVerifyResponse(JSON.stringify({ layout: { verdict: "confirmed" } }));
    expect(parsed.layout.confirmed).toBe(true);
    expect(parsed.layout.cause).toBeUndefined();
    expect(parsed.mood.cause).toBe("field-absent");
  });

  it("tags a present-but-scalar field value field-not-object", () => {
    const parsed = parseVerifyResponse(JSON.stringify({ layout: "yes" }));
    expect(parsed.layout.cause).toBe("field-not-object");
  });

  it("tags a field with no verdict key verdict-missing", () => {
    const parsed = parseVerifyResponse(JSON.stringify({ layout: { reason: "hard to say" } }));
    expect(parsed.layout.cause).toBe("verdict-missing");
    expect(parsed.layout.reason).toBe("hard to say");
  });

  it("tags an unrecognised verdict string verdict-unrecognised and keeps the literal", () => {
    const parsed = parseVerifyResponse(JSON.stringify({ layout: { verdict: "partially confirmed" } }));
    expect(parsed.layout.cause).toBe("verdict-unrecognised");
    expect(parsed.layout.rawVerdict).toBe("partially confirmed");
    expect(parsed.layout.confirmed).toBe(false);
    expect(parsed.layout.contradicted).toBe(false);
  });

  it("tags an explicit abstain model-abstained and keeps the model's reason", () => {
    const parsed = parseVerifyResponse(JSON.stringify({
      layout: { verdict: "abstain", reason: "cannot determine from one screenshot" },
    }));
    expect(parsed.layout.cause).toBe("model-abstained");
    expect(parsed.layout.reason).toBe("cannot determine from one screenshot");
  });

  it("leaves confirmed and contradicted fields with no cause", () => {
    const parsed = parseVerifyResponse(JSON.stringify({
      a: { verdict: "confirmed" },
      b: { verdict: "contradicted" },
    }));
    expect(parsed.a.cause).toBeUndefined();
    expect(parsed.b.cause).toBeUndefined();
  });

  it("still honours the legacy confirmed-boolean shape with no verdict key", () => {
    const parsed = parseVerifyResponse(JSON.stringify({ layout: { confirmed: true } }));
    expect(parsed.layout.confirmed).toBe(true);
    expect(parsed.layout.cause).toBeUndefined();
  });

  it("surfaces an empty object as field-absent on every field", () => {
    const parsed = parseVerifyResponse("{}");
    expect(parsed.layout.cause).toBe("field-absent");
    expect(parsed.anythingElse.cause).toBe("field-absent");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/scripts/verify-corpus.test.ts -t "abstain cause taxonomy"`
Expected: FAIL — `cause` is `undefined` on every assertion, and `rawVerdict` does not exist on `ParsedField`.

- [ ] **Step 3: Add the types**

In `src/scripts/verify-corpus.ts`, immediately above `export type ParsedField` (`:255`):

```ts
/**
 * WHY an abstain happened, one value per physical branch. Six of these are
 * defects with cheap fixes; only `model-abstained` is evidence about the model
 * lane's ceiling, and only for it does the model's own `reason` text exist.
 * The two `corroboration-*` values are set in `verifyEntry`, not at parse time.
 */
export type AbstainCause =
  | "response-unparseable"
  | "response-not-object"
  | "field-absent"
  | "field-not-object"
  | "verdict-missing"
  | "verdict-unrecognised"
  | "model-abstained"
  | "corroboration-split"
  | "corroboration-error";

/** WHICH of an entry's up-to-three vision calls produced a verdict. */
export type VerifyCallSite = "initial" | "corroborate" | "reverify";
```

- [ ] **Step 4: Extend `ParsedField`**

Replace the type body at `:255-260`:

```ts
export type ParsedField = {
  confirmed: boolean;
  contradicted: boolean;
  assertions?: string[];
  reason?: string;
  /** Set only when the field is neither confirmed nor contradicted. */
  cause?: AbstainCause;
  /** The literal verdict string, kept only for `verdict-unrecognised`. */
  rawVerdict?: string;
};
```

- [ ] **Step 5: Parameterize `failClosed`**

Replace `failClosed` at `:270-281`:

```ts
function failClosed(
  out: Record<string, ParsedField>,
  absentCause: AbstainCause,
): Record<string, ParsedField> {
  return new Proxy(out, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && !(prop in target)) {
        return { confirmed: false, contradicted: false, cause: absentCause };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
```

The parameter is what separates the three cases: the two whole-response failures pass an EMPTY `out`, so every key hits the default and reports the response-level cause; the normal return passes a populated `out`, so only genuinely missing keys report `field-absent`.

- [ ] **Step 6: Update the three `failClosed` call sites and the per-field branch**

Replace `parseVerifyResponse` at `:283-316`:

```ts
export function parseVerifyResponse(raw: string): Record<string, ParsedField> {
  const out: Record<string, ParsedField> = {};
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return failClosed(out, "response-unparseable");
  }
  if (typeof parsed !== "object" || parsed === null) return failClosed(out, "response-not-object");
  for (const [field, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) {
      out[field] = { confirmed: false, contradicted: false, cause: "field-not-object" };
      continue;
    }
    const v = value as Record<string, unknown>;
    const assertions = Array.isArray(v.assertions)
      ? v.assertions.filter((a): a is string => typeof a === "string")
      : undefined;
    // The three-way verdict, with the legacy confirmed-boolean shape as a
    // fallback: a `verdict` string wins; otherwise an explicit `confirmed: true`
    // still counts as confirmed.
    const rawVerdict = typeof v.verdict === "string" ? (v.verdict as string) : undefined;
    const verdict = rawVerdict ?? (v.confirmed === true ? "confirmed" : undefined);
    const confirmed = verdict === "confirmed";
    const contradicted = verdict === "contradicted";
    // A field that is neither gets a cause naming WHICH silence this was.
    const cause: AbstainCause | undefined = confirmed || contradicted
      ? undefined
      : verdict === undefined
        ? "verdict-missing"
        : verdict === "abstain"
          ? "model-abstained"
          : "verdict-unrecognised";
    out[field] = {
      confirmed,
      contradicted,
      ...(assertions !== undefined ? { assertions } : {}),
      ...(typeof v.reason === "string" ? { reason: v.reason } : {}),
      ...(cause !== undefined ? { cause } : {}),
      ...(cause === "verdict-unrecognised" && rawVerdict !== undefined ? { rawVerdict } : {}),
    };
  }
  return failClosed(out, "field-absent");
}
```

- [ ] **Step 7: Run the new tests**

Run: `npx vitest run src/scripts/verify-corpus.test.ts -t "abstain cause taxonomy"`
Expected: PASS, 10 tests.

- [ ] **Step 8: Run the characterization guard and the full file**

Run: `npx vitest run src/scripts/verify-corpus.test.ts`
Expected: PASS. The Task 1 table must still be green — this task changed no verdict.

- [ ] **Step 9: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add src/scripts/verify-corpus.ts src/scripts/verify-corpus.test.ts
git commit -m "feat(verify): name the seven parse-time abstain causes

failClosed's Proxy manufactured {confirmed:false,contradicted:false} for any
absent key, so an unparseable whole response, a silently dropped field, and a
genuine refusal were indistinguishable. failClosed now takes the absent-key cause
as a parameter, which is what separates the three return sites: the two
whole-response failures pass an empty map so every key reports the response-level
cause, while the normal return only tags genuinely missing keys.

Adds one branch that did not exist: an unrecognised verdict string was previously
mapped to the same neutral state as a missing verdict and the literal discarded.
It is now verdict-unrecognised and keeps the string."
```

- [ ] **Step 11: Write the task review artifact**

```bash
.zcode/scripts/write-review-artifact --type task --result approved --reviewer agent \
  --base-sha $(git rev-parse HEAD^) --head-sha $(git rev-parse HEAD) \
  --branch feat/verifier-abstain-diagnosis
```

---

### Task 3: Carry cause and site onto the verdict

**Files:**
- Modify: `src/scripts/verify-corpus.ts:56-69` (`FieldVerdict`), `:318-344` (`decideFieldVerdict`)
- Test: `src/scripts/verify-corpus.test.ts`

**Interfaces:**
- Consumes: `AbstainCause`, `VerifyCallSite`, `ParsedField.cause`, `ParsedField.rawVerdict` from Task 2.
- Produces: `decideFieldVerdict(field: string, tier: VerifierTier, parsed: ParsedField, site: VerifyCallSite): FieldVerdict` — **`site` is required, not defaulted**, so the compiler forces every call site in Task 4 to declare which call it came from. `FieldVerdict` gains `cause?: AbstainCause`, `site?: VerifyCallSite`, `firstCause?: AbstainCause`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("decideFieldVerdict — cause and site on abstains", () => {
  it("carries the parsed cause and the declared site", () => {
    const v = decideFieldVerdict("layout", "factual", { confirmed: false, contradicted: false, cause: "field-absent" }, "initial");
    expect(v.verdict).toBe("abstain");
    expect(v.cause).toBe("field-absent");
    expect(v.site).toBe("initial");
  });

  it("appends the model's reason to the abstain reason string", () => {
    const v = decideFieldVerdict("layout", "factual", {
      confirmed: false, contradicted: false, cause: "model-abstained", reason: "cannot determine from one screenshot",
    }, "initial");
    expect(v.reason).toBe("not positively confirmed — cannot determine from one screenshot");
  });

  it("names the offending literal for an unrecognised verdict", () => {
    const v = decideFieldVerdict("layout", "factual", {
      confirmed: false, contradicted: false, cause: "verdict-unrecognised", rawVerdict: "maybe",
    }, "reverify");
    expect(v.reason).toBe('not positively confirmed — verdict "maybe"');
    expect(v.site).toBe("reverify");
  });

  it("keeps the bare reason string when the model gave no reason", () => {
    const v = decideFieldVerdict("layout", "factual", { confirmed: false, contradicted: false, cause: "field-absent" }, "initial");
    expect(v.reason).toBe("not positively confirmed");
  });

  it("carries cause and site on a prose abstain too", () => {
    const v = decideFieldVerdict("critique", "prose", {
      confirmed: false, contradicted: false, assertions: ["a"], cause: "model-abstained", reason: "unclear",
    }, "corroborate");
    expect(v.verdict).toBe("abstain");
    expect(v.cause).toBe("model-abstained");
    expect(v.site).toBe("corroborate");
    expect(v.reason).toBe("not positively confirmed — unclear");
  });

  it("sets no cause on a pass, a contradiction, or a gate", () => {
    expect(decideFieldVerdict("layout", "factual", { confirmed: true, contradicted: false }, "initial").cause).toBeUndefined();
    expect(decideFieldVerdict("layout", "factual", { confirmed: false, contradicted: true }, "initial").cause).toBeUndefined();
    expect(decideFieldVerdict("layout", "gated", { confirmed: false, contradicted: false }, "initial").cause).toBeUndefined();
    expect(decideFieldVerdict("critique", "prose", { confirmed: false, contradicted: false, assertions: [] }, "initial").cause).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/scripts/verify-corpus.test.ts -t "cause and site on abstains"`
Expected: FAIL — `decideFieldVerdict` takes three arguments; a TypeScript error on the fourth.

- [ ] **Step 3: Extend `FieldVerdict`**

Add to the type at `:56-69`, after `source`:

```ts
  /** WHY an abstain happened. Set on abstains only. */
  cause?: AbstainCause;
  /** WHICH vision call produced this verdict. Set alongside `cause`. */
  site?: VerifyCallSite;
  /**
   * For a prose field that abstained TWICE, the cause of the FIRST ask. The
   * re-produce pass overwrites `cause`, and recording only the survivor would
   * hide every first-ask cause behind a re-produce that failed differently.
   */
  firstCause?: AbstainCause;
```

- [ ] **Step 4: Rewrite `decideFieldVerdict`**

Replace `:318-344`:

```ts
/** The one place an abstain verdict is built, so cause/site can never diverge. */
function abstainVerdict(field: string, parsed: ParsedField, site: VerifyCallSite): FieldVerdict {
  const cause = parsed.cause ?? "verdict-missing";
  const detail = cause === "verdict-unrecognised" && parsed.rawVerdict !== undefined
    ? ` — verdict "${parsed.rawVerdict}"`
    : parsed.reason !== undefined && parsed.reason !== ""
      ? ` — ${parsed.reason}`
      : "";
  return { field, verdict: "abstain", reason: `not positively confirmed${detail}`, cause, site };
}

export function decideFieldVerdict(
  field: string,
  tier: VerifierTier,
  parsed: ParsedField,
  site: VerifyCallSite,
): FieldVerdict {
  if (tier === "gated") {
    return { field, verdict: "gate", reason: "no single screenshot can confirm this claim" };
  }
  if (tier === "prose") {
    const assertions = parsed.assertions ?? [];
    if (assertions.length === 0) {
      return { field, verdict: "gate", reason: "no checkable assertions enumerated — vacuous confirmation refused" };
    }
    if (parsed.contradicted) {
      return { field, verdict: "contradicted", reason: "the image positively disagrees with a recorded assertion" };
    }
    return parsed.confirmed
      ? { field, verdict: "pass", reason: `${assertions.length} assertion(s) confirmed` }
      : abstainVerdict(field, parsed, site);
  }
  if (parsed.contradicted) {
    return { field, verdict: "contradicted", reason: "the image positively disagrees with the recorded claim" };
  }
  return parsed.confirmed
    ? { field, verdict: "pass", reason: "positively confirmed against the image" }
    : abstainVerdict(field, parsed, site);
}
```

- [ ] **Step 5: Fix the now-broken call sites so the file compiles**

Four calls need a fourth argument. Pass the literal that matches the call each one came from:

- `:564` (initial combined ask) → `"initial"`
- `:603` (corroboration re-ask) → `"corroborate"`
- `:662` (post-re-produce re-verify) → `"reverify"`

At each of those three sites, also give the defensive fallback literal a cause so an abstain can never carry `verdict-missing` by accident. Change every occurrence of:

```ts
parsed[field] ?? { confirmed: false, contradicted: false }
```

to:

```ts
parsed[field] ?? { confirmed: false, contradicted: false, cause: "field-absent" }
```

(applies to `parsed`, `reParsed` at `:603`, and `reParsed` at `:662`).

- [ ] **Step 6: Update the Task 1 characterization test's call signature**

The table calls `decideFieldVerdict("someField", tier, parsed)`. Add the site:

```ts
expect(decideFieldVerdict("someField", tier, parsed, "initial").verdict).toBe(byState[name]);
```

Only the call changes. **No expected verdict changes.** If adding the argument makes a verdict move, stop — the invariant is broken and the cause is in Step 4, not in the table.

- [ ] **Step 7: Run the new tests, then the whole file**

Run: `npx vitest run src/scripts/verify-corpus.test.ts -t "cause and site on abstains"`
Expected: PASS, 6 tests.

Run: `npx vitest run src/scripts/verify-corpus.test.ts`
Expected: PASS. The characterization table stays green.

- [ ] **Step 8: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. A remaining error naming `decideFieldVerdict` means a call site was missed in Step 5 — that is the compiler doing its job, not a problem to route around with a default parameter.

- [ ] **Step 9: Commit**

```bash
git add src/scripts/verify-corpus.ts src/scripts/verify-corpus.test.ts
git commit -m "feat(verify): carry abstain cause and call site onto the verdict

decideFieldVerdict discarded the model's own per-field reason, which the prompt
already requests and parseVerifyResponse already captures. Abstains now carry the
cause, the call site, and the model's reason appended to the reason string.

site is a required parameter rather than a defaulted one so the compiler forces
each of the three call sites to declare which vision call it came from — a
default would have silently labelled the corroboration and re-verify asks as
initial, which is exactly the confusion this exists to remove."
```

- [ ] **Step 10: Write the task review artifact**

```bash
.zcode/scripts/write-review-artifact --type task --result approved --reviewer agent \
  --base-sha $(git rev-parse HEAD^) --head-sha $(git rev-parse HEAD) \
  --branch feat/verifier-abstain-diagnosis
```

---

### Task 4: Runner-set causes and the prose `firstCause`

**Files:**
- Modify: `src/scripts/verify-corpus.ts:594-599`, `:610-615`, `:645-670`
- Test: `src/scripts/verify-corpus.test.ts`

**Interfaces:**
- Consumes: `AbstainCause`, `VerifyCallSite`, `FieldVerdict.firstCause` from Tasks 2–3.
- Produces: nothing new. Two hand-built abstains gain causes; prose abstains gain `firstCause`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("verifyEntry — runner-set abstain causes", () => {
  it("tags a corroboration split corroboration-split", async () => {
    // First ask contradicts, second ask confirms -> the split IS the finding.
    const responses = [
      JSON.stringify({ "visual.accentColor": { verdict: "contradicted" } }),
      JSON.stringify({ "visual.accentColor": { verdict: "confirmed" } }),
    ];
    let call = 0;
    const out = await verifyEntry(entryWithAccent(), fixtureImagePath(), {
      now: () => "2026-08-08T00:00:00.000Z",
      callVision: async () => responses[call++] ?? "{}",
      reproduce: async (e) => e,
      detectors: false,
    });
    const v = out.verdicts.find((x) => x.field === "visual.accentColor");
    expect(v?.verdict).toBe("abstain");
    expect(v?.cause).toBe("corroboration-split");
  });

  it("tags a corroboration call that threw corroboration-error", async () => {
    let call = 0;
    const out = await verifyEntry(entryWithAccent(), fixtureImagePath(), {
      now: () => "2026-08-08T00:00:00.000Z",
      callVision: async () => {
        if (call++ === 0) return JSON.stringify({ "visual.accentColor": { verdict: "contradicted" } });
        throw new Error("upstream 503");
      },
      reproduce: async (e) => e,
      detectors: false,
    });
    const v = out.verdicts.find((x) => x.field === "visual.accentColor");
    expect(v?.verdict).toBe("abstain");
    expect(v?.cause).toBe("corroboration-error");
  });

  it("records firstCause and cause separately when a prose field abstains twice for different reasons", async () => {
    let call = 0;
    const out = await verifyEntry(entryWithCritique(), fixtureImagePath(), {
      now: () => "2026-08-08T00:00:00.000Z",
      callVision: async () => {
        // Initial ask: the model dropped the field entirely -> field-absent.
        if (call++ === 0) return JSON.stringify({ someOtherField: { verdict: "confirmed" } });
        // Re-verify after re-produce: an explicit refusal -> model-abstained.
        return JSON.stringify({ critique: { verdict: "abstain", assertions: ["a"], reason: "still unclear" } });
      },
      reproduce: async (e) => e,
      detectors: false,
    });
    const v = out.verdicts.find((x) => x.field === "critique");
    expect(v?.firstCause).toBe("field-absent");
    expect(v?.cause).toBe("model-abstained");
    expect(v?.site).toBe("reverify");
  });
});
```

Build `entryWithAccent()`, `entryWithCritique()` and `fixtureImagePath()` from the fixtures the existing `verifyEntry` tests in this file already use — reuse them rather than writing new ones, and point `fixtureImagePath()` at the existing test image so `imageSha256Of` can read real bytes.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/scripts/verify-corpus.test.ts -t "runner-set abstain causes"`
Expected: FAIL — `cause` and `firstCause` are `undefined` on all three.

- [ ] **Step 3: Tag the corroboration-error abstain**

At `:594-599`, add the cause and site to the object:

```ts
        decided.set(field, {
          field,
          verdict: "abstain",
          reason: `model contradiction could not be corroborated: ${err instanceof Error ? err.message : String(err)}`,
          source: "vision",
          cause: "corroboration-error",
          site: "corroborate",
        });
```

- [ ] **Step 4: Tag the corroboration-split abstain**

At `:610-615`:

```ts
        decided.set(field, {
          field,
          verdict: "abstain",
          reason: "model disagreed with itself across two fresh asks (contradicted, then confirmed) — neither verdict is corroborated",
          source: "vision",
          cause: "corroboration-split",
          site: "corroborate",
        });
```

- [ ] **Step 5: Carry `firstCause` through the re-produce path**

In the `failedProse` loop (`:657-663`), capture the pre-re-produce cause before overwriting the entry in `decided`:

```ts
      for (const field of failedProse) {
        const firstCause = decided.get(field)?.cause;
        if (!reFields.includes(field)) {
          decided.set(field, {
            field,
            verdict: "gate",
            reason: "re-production wrote no value for this field",
            ...(firstCause !== undefined ? { firstCause } : {}),
          });
          continue;
        }
        const reVerdict = decideFieldVerdict(field, "prose", reParsed[field] ?? { confirmed: false, contradicted: false, cause: "field-absent" }, "reverify");
        decided.set(field, { ...reVerdict, ...(firstCause !== undefined ? { firstCause } : {}) });
```

Leave the rest of the loop body (`:664` onwards — the pass-writes-the-reproduced-value branch and the contradicted branch) exactly as it is.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/scripts/verify-corpus.test.ts -t "runner-set abstain causes"`
Expected: PASS, 3 tests.

Run: `npx vitest run src/scripts/verify-corpus.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: no errors.

```bash
git add src/scripts/verify-corpus.ts src/scripts/verify-corpus.test.ts
git commit -m "feat(verify): tag the two runner-set abstains and keep the prose first cause

The corroboration split and the corroboration error are built directly in
verifyEntry rather than through decideFieldVerdict, so they were the two abstains
the taxonomy could not see. Both now carry a cause and the corroborate site.

decideFieldVerdict runs twice for a prose field that first abstained, and the
re-produce pass overwrote the cause. Recording only the survivor hid every
first-ask cause behind a re-produce that failed for a different reason, so the
first-ask cause is preserved as firstCause."
```

- [ ] **Step 8: Write the task review artifact**

```bash
.zcode/scripts/write-review-artifact --type task --result approved --reviewer agent \
  --base-sha $(git rev-parse HEAD^) --head-sha $(git rev-parse HEAD) \
  --branch feat/verifier-abstain-diagnosis
```

---

### Task 5: `--diagnose` and `--only-ids`

**Files:**
- Modify: `src/scripts/verify-corpus.ts:415-420` (`VerifyEntryDeps`), `:447-453` (per-field pending), `:1143-1177` (`main` args + selection), `:1329` (the `verifyEntry` call)
- Test: `src/scripts/verify-corpus.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 2–4.
- Produces: `VerifyEntryDeps` gains `diagnose?: boolean`; `main` accepts `--diagnose` and `--only-ids`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("--only-ids selection", () => {
  it("selects exactly the listed ids, in a corpus whose first-N-by-order set differs", () => {
    // The fixture is built so an order-based selection CANNOT pass: the ids we
    // ask for are the LAST two, and the first two are also image-bearing and
    // unprocessed, so `selectPending(...).slice(0, 2)` would return them instead.
    const entries = [
      entryFixture({ id: "first" }), entryFixture({ id: "second" }),
      entryFixture({ id: "third" }), entryFixture({ id: "fourth" }),
    ];
    expect(selectByIds(entries, ["third", "fourth"]).map((e) => e.id)).toEqual(["third", "fourth"]);
    expect(selectPending(entries, VERIFIER_VERSION).slice(0, 2).map((e) => e.id)).toEqual(["first", "second"]);
  });

  it("throws naming every unknown id rather than skipping it", () => {
    const entries = [entryFixture({ id: "first" })];
    expect(() => selectByIds(entries, ["first", "nope", "alsoNope"]))
      .toThrow(/unknown entry id\(s\): nope, alsoNope/);
  });

  it("throws when a listed entry has no image path", () => {
    const entries = [entryFixture({ id: "first", image: undefined })];
    expect(() => selectByIds(entries, ["first"])).toThrow(/no image path: first/);
  });

  it("preserves the order of the id list, not corpus order", () => {
    const entries = [entryFixture({ id: "a" }), entryFixture({ id: "b" })];
    expect(selectByIds(entries, ["b", "a"]).map((e) => e.id)).toEqual(["b", "a"]);
  });
});

describe("verifyEntry — diagnose bypasses the per-field resume skip", () => {
  it("re-queues a field already stamped at the current version", async () => {
    const entry = entryFixture({ id: "e1" });
    entry.provenance = {
      taggedBy: "auto",
      verifyAttempts: { layout: { verifierVersion: VERIFIER_VERSION, verifiedAt: "2026-08-07" } },
    };
    const asked: string[] = [];
    await verifyEntry(entry, fixtureImagePath(), {
      now: () => "2026-08-08T00:00:00.000Z",
      callVision: async (prompt) => { asked.push(prompt); return "{}"; },
      reproduce: async (e) => e,
      detectors: false,
      diagnose: true,
    });
    expect(asked.join("\n")).toContain("layout");
  });

  it("still skips that field without the flag", async () => {
    const entry = entryFixture({ id: "e1" });
    entry.provenance = {
      taggedBy: "auto",
      verifyAttempts: { layout: { verifierVersion: VERIFIER_VERSION, verifiedAt: "2026-08-07" } },
    };
    const asked: string[] = [];
    await verifyEntry(entry, fixtureImagePath(), {
      now: () => "2026-08-08T00:00:00.000Z",
      callVision: async (prompt) => { asked.push(prompt); return "{}"; },
      reproduce: async (e) => e,
      detectors: false,
    });
    expect(asked.join("\n")).not.toContain("- layout:");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/scripts/verify-corpus.test.ts -t "only-ids selection"`
Expected: FAIL — `selectByIds` is not exported.

- [ ] **Step 3: Add `selectByIds`**

Directly below `selectPending` (`:821`):

```ts
/**
 * Select entries by EXPLICIT id, in the order given. `--limit` cannot select a
 * cohort: `main` slices `selectPending` by corpus order, and with the resume
 * skip bypassed that returns every image-bearing entry — measured 0 of 50
 * positional matches against the committed report. An unknown id throws rather
 * than being silently dropped, the same rule `--retriage` applies.
 */
export function selectByIds(entries: readonly CorpusEntryT[], ids: readonly string[]): CorpusEntryT[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new Error(`--only-ids: unknown entry id(s): ${missing.join(", ")}`);
  }
  const selected = ids.map((id) => byId.get(id) as CorpusEntryT);
  const noImage = selected.filter((e) => !e.image?.path).map((e) => e.id);
  if (noImage.length > 0) {
    throw new Error(`--only-ids: entries with no image path: ${noImage.join(", ")}`);
  }
  return selected;
}
```

- [ ] **Step 4: Thread `diagnose` through `VerifyEntryDeps`**

At `:415-420`, add to the interface:

```ts
  /**
   * Bypass the per-field resume skip so an already-processed cohort can be
   * re-measured. Only ever set by `--diagnose`, which also forces dry-run, so
   * the bypass can never reach a corpus write.
   */
  diagnose?: boolean;
```

At `:436` (beside `const detectorsEnabled = deps.detectors ?? true;`):

```ts
  const diagnose = deps.diagnose ?? false;
```

At `:452`, replace the skip clause:

```ts
        && (diagnose || !alreadyProcessedAtVersion(entry, field, VERIFIER_VERSION)),
```

The unreadable-image path at `:512` sets `pending = []` unconditionally and is left alone: the cohort's images are all readable, so it is a no-op here, and widening it would let a diagnosis run re-ask on an image it could not read.

- [ ] **Step 5: Run the verifyEntry tests**

Run: `npx vitest run src/scripts/verify-corpus.test.ts -t "diagnose bypasses"`
Expected: PASS, 2 tests.

- [ ] **Step 6: Add the flags and the selection branch in `main`**

In the `parseArgs` options block (`:1146-1162`), add:

```ts
      "diagnose": { type: "boolean", default: false },
      "only-ids": { type: "string" },
```

Replace `:1164` and `:1177`:

```ts
  const diagnose = values.diagnose === true;
  const onlyIdsRaw = values["only-ids"];
  // The flag matrix is exhaustive on purpose: there is no invocation that
  // re-measures the full corpus by accident, and no invocation where
  // --only-ids is silently ignored.
  if (diagnose && (onlyIdsRaw === undefined || onlyIdsRaw.trim() === "")) {
    throw new Error("--diagnose requires --only-ids: a diagnosis run must name the entries it re-measures");
  }
  if (!diagnose && onlyIdsRaw !== undefined) {
    throw new Error("--only-ids requires --diagnose: it has no effect on a normal run");
  }
  // --diagnose IMPLIES --dry-run. One flag, so no half-set state exists where
  // the resume bypass is active and the corpus write is not gated.
  const dryRun = values["dry-run"] === true || diagnose;
```

```ts
  const onlyIds = onlyIdsRaw ? onlyIdsRaw.split(",").map((s) => s.trim()).filter(Boolean) : null;
  const pending = onlyIds
    ? selectByIds(entries, onlyIds)
    : selectPending(entries, VERIFIER_VERSION).slice(0, Number.isFinite(limit) && limit > 0 ? limit : undefined);
```

At the `verifyEntry` call (`:1329-1336`), add `diagnose,` to the deps object.

- [ ] **Step 7: Prove the corpus is untouched**

```ts
describe("--diagnose leaves the corpus byte-identical", () => {
  it("writes nothing even though it re-processes stamped fields", async () => {
    // Corpus isolation: a temp --corpus file, NEVER corpus/entries.json.
    const tmp = join(tmpdir(), `verify-diagnose-${process.pid}.json`);
    writeFileSync(tmp, JSON.stringify({ entries: [stampedEntryFixture()] }, null, 2));
    const before = readFileSync(tmp);
    await runMainWith(["--diagnose", "--only-ids", "e1", "--corpus", tmp, "--detectors", "off"]);
    expect(readFileSync(tmp).equals(before)).toBe(true);
  });
});
```

If `main` is not directly invocable from the test file, drive the same assertion through a child process:

```bash
node dist/scripts/verify-corpus.js --diagnose --only-ids e1 --corpus "$TMP" --detectors off
```

and compare `shasum` before and after. Either form is acceptable; what must not happen is asserting the flag *implies* dry-run by reading the flag instead of the file.

- [ ] **Step 8: Run everything, typecheck, wiring**

Run: `npx vitest run src/scripts/verify-corpus.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npx vitest run src/wiring-verification.test.ts`
Expected: PASS. `selectByIds` is a new export with a production caller in `main`, so it should pass — but `src/scripts/` is excluded from that test's guarantee, so also confirm by hand that `main` calls it.

- [ ] **Step 9: Commit**

```bash
git add src/scripts/verify-corpus.ts src/scripts/verify-corpus.test.ts
git commit -m "feat(verify): --diagnose re-measures a named cohort without writing

--limit cannot select the cohort. main slices selectPending by corpus order, and
with the resume skip bypassed selectPending returns every image-bearing entry, so
--limit 50 takes the first 50 in corpus order — measured 0 of 50 positional
matches against the committed report, and 2 entries differing in set membership.
selectByIds takes the ids explicitly and throws on an unknown one.

--diagnose implies dry-run and requires --only-ids; --only-ids without --diagnose
is an error. There is no invocation that re-measures the full corpus by accident,
and none where the resume bypass is active while the corpus write is not gated.
The byte-identical test reads the file rather than the flag."
```

- [ ] **Step 10: Write the task review artifact**

```bash
.zcode/scripts/write-review-artifact --type task --result approved --reviewer agent \
  --base-sha $(git rev-parse HEAD^) --head-sha $(git rev-parse HEAD) \
  --branch feat/verifier-abstain-diagnosis
```

---

### Task 6: Abstain-cause breakdown in the run report

**Files:**
- Modify: `src/scripts/verify-corpus.ts:861-897` (inside `buildRunReport`)
- Test: `src/scripts/verify-corpus.test.ts`

**Interfaces:**
- Consumes: `FieldVerdict.cause`, `.site`, `.firstCause` from Tasks 3–4.
- Produces: report lines. Nothing downstream consumes them programmatically.

- [ ] **Step 1: Write the failing test**

```ts
describe("buildRunReport — abstain cause breakdown", () => {
  const report = () => buildRunReport({
    entries: 1,
    verdictsByEntry: {
      e1: [
        { field: "layout", verdict: "abstain", reason: "x", source: "vision", cause: "field-absent", site: "initial" },
        { field: "mood", verdict: "abstain", reason: "x", source: "vision", cause: "model-abstained", site: "initial" },
        { field: "critique", verdict: "abstain", reason: "x", source: "vision", cause: "model-abstained", site: "reverify", firstCause: "field-absent" },
        { field: "visual.dominantColors", verdict: "pass", reason: "detector", source: "detector" },
      ],
    },
  } as never, { dryRun: true, verifierVersion: "verifier-v1" });

  it("counts each cause once, by cause and not by firstCause", () => {
    const text = report();
    expect(text).toContain("Abstain causes — 3 total");
    expect(text).toMatch(/model-abstained\s+2/);
    expect(text).toMatch(/field-absent\s+1/);
  });

  it("sums to the reported abstain count", () => {
    const text = report();
    const total = Number(/Abstain causes — (\d+) total/.exec(text)![1]);
    const counted = [...text.matchAll(/^ {2}\S+\s+(\d+)\b/gm)].reduce((a, m) => a + Number(m[1]), 0);
    expect(counted).toBe(total);
  });

  it("breaks the causes down by call site", () => {
    expect(report()).toMatch(/initial 2/);
    expect(report()).toMatch(/reverify 1/);
  });

  it("reports prose first causes in their own line, outside the total", () => {
    expect(report()).toContain("Prose first causes (not counted in the total above): field-absent 1");
  });

  it("prints nothing when there are no abstains", () => {
    const text = buildRunReport({
      entries: 1,
      verdictsByEntry: { e1: [{ field: "layout", verdict: "pass", reason: "x", source: "vision" }] },
    } as never, { dryRun: true, verifierVersion: "verifier-v1" });
    expect(text).not.toContain("Abstain causes");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/scripts/verify-corpus.test.ts -t "abstain cause breakdown"`
Expected: FAIL — the report contains no such block.

- [ ] **Step 3: Implement the breakdown**

Inside the existing verdict loop at `:868-883`, accumulate alongside the detector stats:

```ts
  const causeStats = new Map<string, { total: number; bySite: Map<string, number> }>();
  const firstCauseStats = new Map<string, number>();
```

and inside the inner `for (const v of verdicts)`:

```ts
      if (v.verdict === "abstain" && v.cause !== undefined) {
        const s = causeStats.get(v.cause) ?? { total: 0, bySite: new Map<string, number>() };
        s.total += 1;
        const site = v.site ?? "initial";
        s.bySite.set(site, (s.bySite.get(site) ?? 0) + 1);
        causeStats.set(v.cause, s);
      }
      // firstCause is reported SEPARATELY and never added to the total —
      // counting a prose abstain twice is the obvious way this table goes wrong.
      if (v.firstCause !== undefined) {
        firstCauseStats.set(v.firstCause, (firstCauseStats.get(v.firstCause) ?? 0) + 1);
      }
```

After the detector lines (`:897`), emit:

```ts
  const causeTotal = [...causeStats.values()].reduce((a, s) => a + s.total, 0);
  if (causeTotal > 0) {
    lines.push("");
    lines.push(`Abstain causes — ${causeTotal} total`);
    for (const [cause, s] of [...causeStats.entries()].sort((a, b) => b[1].total - a[1].total)) {
      const sites = [...s.bySite.entries()].sort().map(([site, n]) => `${site} ${n}`).join(", ");
      lines.push(`  ${cause.padEnd(22)} ${String(s.total).padStart(4)}  (${sites})`);
    }
    if (firstCauseStats.size > 0) {
      const firsts = [...firstCauseStats.entries()].sort().map(([c, n]) => `${c} ${n}`).join(", ");
      lines.push(`Prose first causes (not counted in the total above): ${firsts}`);
    }
  }
```

- [ ] **Step 4: Run the tests and the whole file**

Run: `npx vitest run src/scripts/verify-corpus.test.ts -t "abstain cause breakdown"`
Expected: PASS, 5 tests.

Run: `npx vitest run src/scripts/verify-corpus.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: no errors.

```bash
git add src/scripts/verify-corpus.ts src/scripts/verify-corpus.test.ts
git commit -m "feat(verify): report the abstain-cause breakdown by cause and call site

The run report printed 306 abstains and no way to tell an unparseable response
from a dropped field from a genuine refusal. The breakdown counts each abstain
once by its cause, splits each cause by call site, and reports prose first causes
on a separate line that is explicitly NOT added to the total — double-counting a
prose abstain is the obvious way this table goes wrong, so a test pins the sum."
```

- [ ] **Step 6: Write the task review artifact**

```bash
.zcode/scripts/write-review-artifact --type task --result approved --reviewer agent \
  --base-sha $(git rev-parse HEAD^) --head-sha $(git rev-parse HEAD) \
  --branch feat/verifier-abstain-diagnosis
```

---

### Task 7: Run the diagnosis and write the output document

This task runs the measurement and applies the spec's pre-registered decision rule. It writes no production code.

**Files:**
- Create: `docs/verifier-abstain-diagnosis.md`

**Interfaces:**
- Consumes: everything from Tasks 2–6.
- Produces: the document, and the decision that follows from it.

- [ ] **Step 1: Build, then extract the cohort id list from the committed report**

```bash
npm run build
grep '^## ' verify-report.md | cut -c4- | paste -sd, - > /tmp/cohort-ids.txt
wc -l /tmp/cohort-ids.txt && head -c 200 /tmp/cohort-ids.txt
```

Expected: one line, 50 comma-separated ids beginning `origin-origin-2,origin-origin-3,`.

- [ ] **Step 2: Snapshot the corpus hash before the run**

```bash
shasum -a 256 corpus/entries.json | tee /tmp/corpus-before.txt
```

- [ ] **Step 3: Run the diagnosis**

```bash
npm run verify -- --detectors on --diagnose --only-ids "$(cat /tmp/cohort-ids.txt)"
```

Expected: an `Abstain causes` block in the printed report. Cost ≈160 model calls.

If it exits on `--only-ids: unknown entry id(s): …`, the corpus has changed since the committed report. Do **not** delete the offending ids — record which ones and how many, then re-run with the remainder. A shrinking cohort is itself a finding about corpus churn and belongs in the document.

- [ ] **Step 4: Prove the corpus was not written**

```bash
shasum -a 256 corpus/entries.json | diff - /tmp/corpus-before.txt && echo "UNCHANGED"
```

Expected: `UNCHANGED`. If this fails, stop and treat it as a Critical defect in Task 5 — the governing invariant is broken and no result from this run is usable.

- [ ] **Step 5: Write `docs/verifier-abstain-diagnosis.md`**

Include, in this order:

1. Run header — resolved model, image detail, sampling, date, and the exact `--only-ids` list, so the run is re-executable.
2. The `Abstain causes` block verbatim from the report.
3. Per-field cause split.
4. The prose `firstCause` line.
5. Every `model-abstained` reason string, **verbatim**, grouped by field. Do not paraphrase or summarize them into categories before quoting them — the clustering in step 6 has to be checkable against the raw strings.
6. **Rule 1 (defects, absolute):** list every cause with n ≥ 10. Each one is to be fixed regardless of its share. Causes below 10 are listed and left.
7. **Rule 2 (lane headroom, reason-text):** classify the `model-abstained` reasons into "cannot determine from one screenshot" / hedging / empty-or-restates-the-claim, and state the resulting decision. Both rules can fire; neither is conditional on the other.
8. The stated limit: the model flips 14–18% between identical runs, so this run's abstain count will not equal 244 and this is a rate over these entries, not a per-verdict autopsy of the committed report.

- [ ] **Step 6: Commit**

```bash
git add docs/verifier-abstain-diagnosis.md
git commit -m "docs(verify): the abstain-cause breakdown and what it decides

Runs the pre-registered rules from the spec against the measured causes. Rule 1
(any defect cause at n>=10 gets fixed, share-independent) and Rule 2 (classify
the model's own reason texts) are applied separately, as specified — neither is
conditional on the other."
```

- [ ] **Step 7: Branch review and push**

```bash
npm test 2>&1 | tee /tmp/branch-suite.txt | tail -5
grep -E "^ ?FAIL" /tmp/branch-suite.txt
npx tsc --noEmit
```

Expected: `src/tagger.test.ts` and `src/readiness/tracked-artifacts-readiness.test.ts` only — the known-failing baseline above, with `mcp-smoke` now green because Task 7 step 1 rebuilt `dist/`. **A `FAIL` naming any other file is this work's and stops the branch review.** Do not proceed to the artifact until the list matches.

```bash
.zcode/scripts/write-review-artifact --type branch --result approved --reviewer agent \
  --base-sha fb055fa --head-sha $(git rev-parse HEAD) \
  --branch feat/verifier-abstain-diagnosis
git push -u origin feat/verifier-abstain-diagnosis
```

The branch gate rejects an artifact whose `headSha` is not `git rev-parse HEAD`, so write it after the last commit, not before.

---

## Self-review

**Spec coverage.** Cause taxonomy → Task 2. Call site → Tasks 3–4. Prose `firstCause` → Task 4. Code changes 1–3 → Tasks 2, 3, 6. Run mode and the `--limit` defect → Task 5. Pre-registered decision rule → Task 7 steps 5–6. Output document → Task 7. Testing section: characterization → Task 1; seven parse causes → Task 2 (ten tests, covering all seven plus the legacy shape, the empty object, and the no-cause case); two corroboration causes → Task 4; byte-identical → Task 5 step 7; `--only-ids` against a differing corpus order → Task 5 step 1; unknown id → Task 5 step 1; call sites → Task 3; prose two causes → Task 4; breakdown sums → Task 6.

**Not covered, deliberately.** The spec's "entry-level all-servable-fields-absent signature" is reported by the per-cause breakdown plus the site split rather than as a separate line: an unparseable response tags every field `response-unparseable`, which is already distinguishable from per-field `field-absent`. If the run shows `field-absent` clustering at entry granularity, add the entry-level line then — adding it now would be a report feature with no reader.

**Type consistency.** `AbstainCause` and `VerifyCallSite` are declared once in Task 2 and used unchanged in Tasks 3, 4, 6. `decideFieldVerdict`'s fourth parameter is `site: VerifyCallSite`, required, in Tasks 3, 4, 5. `selectByIds(entries, ids)` is declared in Task 5 step 3 and called in Task 5 step 6. `abstainVerdict` is module-private and used only inside `decideFieldVerdict`.
