# Component Taxonomy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a schema-backed `components` taxonomy so rich screenshots can describe visible UI building blocks such as KPI cards, charts, report lists, and sidebars separately from high-level categories.

**Architecture:** `categories` remains the product-pattern axis; `components` becomes a controlled multi-tag evidence axis. The tagger extracts components during Pass 1, the API exposes the vocabulary, the UI renders it in classification, and search/embeddings include it for retrieval.

**Tech Stack:** TypeScript, Zod schema, Vitest, browser-free SPA JavaScript.

## Global Constraints

- Keep `components` controlled and schema-validated, not free text.
- Do not migrate existing corpus entries manually; default old entries to `[]`.
- Preserve existing `categories`, `styleTags`, and `patternType` semantics.
- Add tests before implementation changes.

---

### Task 1: Schema And Server Vocabulary

**Files:**
- Modify: `src/schema.ts`
- Modify: `src/schema.test.ts`
- Modify: `src/scripts/ui-server.ts`

**Interfaces:**
- Produces: `Component` Zod enum and optional/defaulted `components: string[]` on `CorpusEntry`.
- Produces: `/api/schema.components`.

- [x] **Step 1: Write failing schema/API tests**
- [x] **Step 2: Run focused tests and confirm failure**
- [x] **Step 3: Add `Component` enum, default `components`, and expose options**
- [x] **Step 4: Run focused tests and confirm pass**

### Task 2: Tagger Extraction

**Files:**
- Modify: `src/tagger.ts`
- Modify: `src/tagger.test.ts`

**Interfaces:**
- Consumes: `Component.options`.
- Produces: `TaggerOutput.components`, sanitized to known values.

- [x] **Step 1: Write failing tagger tests for component sanitization and prompt/output**
- [x] **Step 2: Run focused tests and confirm failure**
- [x] **Step 3: Add prompt field, sanitizer field, and output propagation**
- [x] **Step 4: Run focused tests and confirm pass**

### Task 3: Retrieval And UI Surfacing

**Files:**
- Modify: `src/corpus.ts`
- Modify: `src/embeddings.ts`
- Modify: `src/corpus.test.ts`
- Modify: `src/embeddings.test.ts`
- Modify: `ui/app.js`
- Modify: `ui/classic-app.js`

**Interfaces:**
- Consumes: optional/defaulted `entry.components`.
- Produces: component-aware keyword search, embedding text, and review display.

- [x] **Step 1: Write failing retrieval tests for component terms**
- [x] **Step 2: Run focused tests and confirm failure**
- [x] **Step 3: Include components in search/embedding documents**
- [x] **Step 4: Render components in Add/edit classification displays**
- [x] **Step 5: Run focused tests, then full test/build verification**
