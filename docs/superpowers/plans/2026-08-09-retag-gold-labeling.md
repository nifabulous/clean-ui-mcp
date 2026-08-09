# Retag Gold Labeling Lane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create an image-hash-bound, human-only gold-labeling lane for the five retag fields that can produce independent submissions without silently converting unknown or unscorable observations into canonical labels.

**Architecture:** Reuse the existing frozen 40-entry C2 selection as the stratified screen sample, but create a separate retag-gold submission contract because the C2 packet does not cover `mood` or `visual.typePairing` and uses a different taxonomy. A pure TypeScript contract validates field status/value semantics, image hashes, complete coverage, and reviewer envelopes; a CLI builds local packets and validates reviewer submissions. No private images, reviewer judgments, or generated packets are committed.

**Tech Stack:** TypeScript, Zod, Vitest, existing corpus loader and SHA-256 utilities, `tsx` CLI scripts.

## Global Constraints

- Gold labels are human observations only; no model output may populate or repair a missing label.
- Every label binds to the exact corpus image SHA-256 and the frozen selection artifact hash.
- Every field supports `present`, `none`, `abstain`, and `oov`; `oov` is quarantine evidence, not a canonical value.
- `visual.typePairing` may be `present` only when a font is supported by DOM evidence; screenshot-only uncertainty is `abstain`.
- `mood` remains open-text in this first lane; the lane records notes and does not invent a closed mood vocabulary.
- Reviewer submissions are independent and must carry explicit actor/role metadata; a single-operator pass is marked non-independent.
- Generated packets and reviewer files stay outside tracked `eval/` artifacts because they contain private paths and human judgments.

---

### Task 1: Define and test the retag-gold contract

**Files:**
- Create: `src/retag-gold.ts`
- Test: `src/retag-gold.test.ts`

**Interfaces:**
- Consumes: current schema vocabularies, the frozen selection entry IDs and image hashes.
- Produces: `RETAG_GOLD_FIELDS`, `RetagGoldSelectionSchema`, `RetagGoldSubmissionSchema`, `validateRetagGoldSubmission`, and `toGoldLabels`.

- [ ] **Step 1: Write failing tests** for valid `present`/`none`/`abstain`/`oov` fields, required abstention notes, closed-vocabulary OOV capture, complete field coverage, duplicate IDs, stale image hashes, wrong selection hashes, and type-pairing DOM evidence requirements.
- [ ] **Step 2: Run the focused test and confirm it fails** because the contract exports do not exist.
- [ ] **Step 3: Implement the minimal Zod schemas and pure validators**. Closed fields use current `Component`, `DomainTag`, and `colorScheme` values; OOV values are stored separately; `mood` and `typePairing` retain their field-specific shapes.
- [ ] **Step 4: Run the focused test and confirm all contract tests pass.**
- [ ] **Step 5: Refactor only after green** so the CLI and evaluator consume one contract rather than duplicating validation.

### Task 2: Build the packet and submission validator CLI

**Files:**
- Create: `src/scripts/retag-gold.ts`
- Modify: `package.json`
- Test: `src/scripts/retag-gold.test.ts`
- Create: `docs/RETAG_GOLD_LANE.md`

**Interfaces:**
- Consumes: `eval/c2/label-integrity/selection.json`, local `corpus/entries.json`, and local image files.
- Produces: `npm run retag-gold -- packet --out <local-packet.json>` and `npm run retag-gold -- validate --submission <reviewer.json>`.

- [ ] **Step 1: Write failing CLI tests** for packet generation, missing-image failure, selection/image hash drift, incomplete submissions, and valid independent submission validation.
- [ ] **Step 2: Run the focused CLI tests and confirm they fail** because the command and packet builder do not exist.
- [ ] **Step 3: Implement packet generation** with relative local image paths, all five field stubs, allowed vocabularies, selection/corpus hashes, and no model-generated values.
- [ ] **Step 4: Implement strict submission validation** that refuses missing fields, duplicate entries, unknown closed values without `oov`, stale image hashes, wrong actor roles, and unmarked single-operator reuse.
- [ ] **Step 5: Add the package script and operator documentation** covering two independent passes, abstention, OOV flags, DOM evidence, output paths, and the prohibition on committing private packets.
- [ ] **Step 6: Run the focused CLI tests and confirm green.**

### Task 3: Bind gold output to retag evaluation

**Files:**
- Modify: `src/retag-eval.ts`
- Test: `src/retag-eval.test.ts`
- Modify: `src/scripts/retag-shadow.ts`
- Test: `src/scripts/retag-shadow.test.ts`

**Interfaces:**
- Consumes: validated retag-gold submissions.
- Produces: normalized `GoldLabel[]` plus per-field OOV/abstain counts that cannot satisfy canonical exact-match metrics.

- [ ] **Step 1: Write failing tests** proving OOV labels are excluded from canonical precision/recall, counted separately, and cannot unlock promotion without a non-empty canonical gold evaluation.
- [ ] **Step 2: Run the tests and confirm the OOV assertions fail.**
- [ ] **Step 3: Add OOV-aware metrics and wire the validated submission conversion into the shadow score artifact.**
- [ ] **Step 4: Run retag evaluation, shadow, and promotion tests.**

### Task 4: Produce the first local packet and review checklist

**Files:**
- Create locally only: `eval/retag-gold/packet-v1.json`, `eval/retag-gold/gold-reviewer.json`, `eval/retag-gold/qa-reviewer.json`
- Modify: `docs/RETAG_GOLD_LANE.md` only if the real packet reveals an operator issue.

- [ ] **Step 1: Build the packet from the current 40-entry frozen selection.**
- [ ] **Step 2: Verify every image path and SHA-256 before labeling.**
- [ ] **Step 3: Have two humans label independently; do not use model drafts as a starting point.**
- [ ] **Step 4: Validate both submissions and export the normalized gold labels.**
- [ ] **Step 5: Do not start corpus retagging until the report shows field-level coverage, OOV/dispute counts, and adjudication status.**

## Verification Commands

```bash
npm run typecheck:contracts
npx vitest run src/retag-gold.test.ts src/scripts/retag-gold.test.ts src/retag-eval.test.ts
npm run retag-gold -- packet --out /tmp/retag-gold-packet-v1.json
npm run retag-gold -- validate --submission /tmp/gold-reviewer.json
```

## Self-review

- The plan reuses the existing selection but does not reuse the C2 submission schema because the target fields and taxonomy differ.
- Private images, paths, and reviewer judgments remain local; only code, tests, and the operator contract are committed.
- No model call is part of packet creation or validation.
- OOV and abstain are represented explicitly and never treated as canonical positives.
