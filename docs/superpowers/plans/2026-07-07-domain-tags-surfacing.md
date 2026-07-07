# Domain Tags Surfacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make business/product subject tags such as `integrations` visible and editable so integration pages do not look like generic settings captures.

**Architecture:** Keep `patternType`, `categories`, and `components` unchanged. Use the existing `domainTags` schema axis for page subject, tighten the extraction prompt around Integrations, and surface `domainTags` in add/review/edit flows.

**Tech Stack:** TypeScript, Zod schema, Vitest, browser-free SPA JavaScript.

## Global Constraints

- Do not add `integrations` to `Category`; product subject belongs in `domainTags`.
- Existing entries with no `domainTags` must continue to load.
- Tests must cover the Integrations settings case before implementation.

---

### Task 1: Integrations Domain Regression

**Files:**
- Modify: `src/tagger.test.ts`
- Modify: `src/embeddings.test.ts`

**Interfaces:**
- Consumes: `sanitizeTaggerPayload(parsed).domainTags`.
- Produces: regression coverage for `domainTags:["integrations"]`.

- [x] **Step 1: Write failing tests for integrations domain extraction and embedding text**
- [x] **Step 2: Run focused tests and confirm the UI/prompt gap**
- [x] **Step 3: Tighten tagger prompt calibration for Settings / Integrations**
- [x] **Step 4: Run focused tests and confirm pass**

### Task 2: UI And CLI Surfacing

**Files:**
- Modify: `ui/app.js`
- Modify: `ui/classic-app.js`
- Modify: `src/scripts/add-entry.ts`
- Modify: `src/scripts/review-draft.ts`

**Interfaces:**
- Consumes: optional `entry.domainTags?: string[]`.
- Produces: visible/editable `domainTags` in add classification, classic detail/edit, CLI add, and draft review.

- [x] **Step 1: Add `domainTags` to draft defaults and mapped entry shapes**
- [x] **Step 2: Show `domainTags` in the add-flow classification JSON**
- [x] **Step 3: Add classic UI search/display/edit support for `domainTags`**
- [x] **Step 4: Add CLI add/review prompts for `DomainTag.options`**
- [x] **Step 5: Run focused tests, full tests, build, and diff checks**
