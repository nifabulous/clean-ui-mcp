# WCAG Integrity Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the WCAG citation integrity, migration durability, and live-tagger canonical-input gaps identified in review of `ac2655e`.

**Architecture:** The WCAG registry remains the single authority. The persisted corpus validates IDs through the schema; the migration snapshots raw pre-migration data and validates the transformed corpus; live model output accepts only pre-canonical ID arrays.

**Tech Stack:** TypeScript, Zod, Vitest, local JSON corpus persistence.

## Global Constraints

- Preserve legacy citation extraction solely for the one-time migration.
- Never write a corpus replacement before validating it and preserving the original raw document.
- Do not modify unrelated working-tree files.

---

### Task 1: Schema registry membership

**Files:**
- Modify: `src/schema.ts`
- Test: `src/schema.test.ts`

- [ ] Add a failing corpus-entry test with `wcag: ["9.9.9"]`.
- [ ] Require each `wcag` item to pass `isWcagCriterion` in addition to numeric formatting.
- [ ] Run `npx vitest run src/schema.test.ts`.

### Task 2: Strict live tagger citations

**Files:**
- Modify: `src/tagger.ts`
- Test: `src/tagger.test.ts`

- [ ] Add a failing sanitizer test for a titled or comma-joined model citation.
- [ ] Accept only arrays whose individual string elements are bare registry IDs; drop any risk with no valid canonical IDs.
- [ ] Run `npx vitest run src/tagger.test.ts`.

### Task 3: Durable validated migration

**Files:**
- Modify: `src/persistence.ts`
- Modify: `src/scripts/migrate-wcag-ids.ts`
- Test: `src/scripts/migrate-wcag-ids.test.ts`

- [ ] Extract the migration transform into an importable function and test it directly.
- [ ] Add a raw-document snapshot helper for migrations, validate the transformed `Corpus` before persistence, and retain atomic output.
- [ ] Run `npx vitest run src/scripts/migrate-wcag-ids.test.ts` and `npm run migrate-wcag-ids -- --dry-run`.

### Task 4: Full verification

**Files:**
- Verify only

- [ ] Run `npm run build`, `npm run validate-corpus`, and `npm test`.
- [ ] Inspect the diff and report unrelated pre-existing files separately.
