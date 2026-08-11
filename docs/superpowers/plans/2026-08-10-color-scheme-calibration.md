# Color-Scheme Calibration Packet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create an image-hash-bound human calibration packet and evaluator for the deterministic `colorScheme` detector, without changing corpus data or treating model-generated labels as gold.

**Architecture:** Reuse the existing color-scheme audit report as the immutable detector input. A deterministic selector chooses a small, diverse cohort that includes threshold-near, existing-value, and luminance-tail examples. A standalone HTML reviewer packet emits only `light`, `dark`, or evidence-based `abstain`; the evaluator binds labels to the audit and image hashes, computes confusion/accuracy, and reports whether a configurable calibration gate is met. No command in this plan writes `corpus/entries.json`.

**Tech Stack:** TypeScript, Zod, Node.js filesystem/path APIs, Vitest, standalone HTML/DOM controls, SHA-256 provenance.

## Global Constraints

- Never mutate `corpus/entries.json` or image files.
- Every packet row and human label must bind to the audit artifact and exact image SHA-256.
- The detector’s recorded threshold, margin, max dimension, source, and algorithm version must remain validated by the existing audit schema.
- `abstain` is valid only when the reviewer records a reason; it is excluded from accuracy denominators.
- A passing calibration report is evidence for a later reviewed promotion, not an automatic promotion authorization.
- Private packet/output paths must be outside `corpus/` and must refuse overwrites.

---

### Task 1: Add the calibration contract and deterministic cohort selector

**Files:**
- Create: `src/color-scheme-calibration.ts`
- Test: `src/color-scheme-calibration.test.ts`

**Interfaces:**
- Consumes: `ColorSchemeAuditReport` and `ColorSchemeAuditEntry` from `src/color-scheme-audit.ts`.
- Produces: `ColorSchemeCalibrationPacket`, `ColorSchemeCalibrationLabel`, `ColorSchemeCalibrationReport`, `selectColorSchemeCalibrationEntries`, `buildColorSchemeCalibrationPacket`, `evaluateColorSchemeCalibration`, and Zod schemas for all three artifacts.

- [ ] **Step 1: Write failing contract tests**

  Test that selection is deterministic for the same report and size, contains no duplicate entry IDs, prefers rows closest to `COLOR_SCHEME_THRESHOLD`, includes existing-value and luminance-tail coverage when available, and excludes missing/error rows. Test that packet rows preserve audit image hashes and detector provenance. Test that evaluation rejects unknown IDs, stale image hashes, duplicate labels, and labels for an audit with a different artifact/hash.

  Test metrics for correct, incorrect, and abstained human labels, including a no-label/insufficient case. Test the gate requires `minimumScoredLabels` and `minimumAccuracy`, and never returns `pass` when either condition is unmet.

- [ ] **Step 2: Run the focused tests and verify they fail**

  Run: `npx vitest run src/color-scheme-calibration.test.ts --maxWorkers=1`

  Expected: FAIL because the calibration contract does not yet exist.

- [ ] **Step 3: Implement the contract**

  Define these shapes:

  ```ts
  type ColorSchemeCalibrationLabel = {
    entryId: string;
    imageSha256: string;
    value: "light" | "dark" | "abstain";
    note?: string;
  };

  type ColorSchemeCalibrationPacket = {
    schemaVersion: "1.0";
    artifactType: "color-scheme-calibration-packet";
    artifactId: string;
    auditArtifactId: string;
    auditSha256: string;
    selectionSha256: string;
    detector: ColorSchemeAuditReport["detector"];
    instructions: string[];
    entries: Array<{
      entryId: string;
      imagePath: string;
      imageSha256: string;
      existingColorScheme: string | null;
      detectedColorScheme: "light" | "dark" | null;
      medianLuma: number | null;
      stratum: "threshold-near" | "existing-value" | "luma-tail";
    }>;
  };
  ```

  Hash canonical JSON for `auditSha256` and `selectionSha256`. Select a target size by taking the closest valid rows to the detector threshold, then filling from existing-value and low/high luma tails using stable entry-ID hashing; de-duplicate while preserving deterministic order. The selector must never select missing-image or error rows.

  `evaluateColorSchemeCalibration` must validate exact packet membership and image hashes, compare only non-abstained labels to `detectedColorScheme`, emit a 2×2 light/dark confusion matrix, and return `status: "pass" | "fail" | "insufficient"` with configurable `minimumScoredLabels` and `minimumAccuracy`.

- [ ] **Step 4: Run the focused tests and verify they pass**

  Run: `npx vitest run src/color-scheme-calibration.test.ts --maxWorkers=1`

  Expected: all calibration contract tests pass.

- [ ] **Step 5: Commit the contract**

  ```bash
  git add src/color-scheme-calibration.ts src/color-scheme-calibration.test.ts
  git commit -m "feat(retag): add color-scheme calibration contract"
  ```

### Task 2: Add the private HTML packet renderer

**Files:**
- Create: `src/color-scheme-calibration-html.ts`
- Test: `src/color-scheme-calibration-html.test.ts`

**Interfaces:**
- Consumes: `ColorSchemeCalibrationPacket` and an entry-ID-to-file-URL map.
- Produces: `buildColorSchemeCalibrationHtml(packet, imageUrls): string`.

- [ ] **Step 1: Write failing renderer tests**

  Assert that rendered HTML embeds the correct image URL and SHA-256, uses DM Sans, renders `light`, `dark`, and `abstain` controls plus a required abstention note, contains Copy JSON, Download JSON, Import JSON, and refuses hostile embedded values from breaking the script. Use JSDOM to verify one entry renders and that completed labels can be copied as valid JSON.

- [ ] **Step 2: Run the focused renderer tests and verify they fail**

  Run: `npx vitest run src/color-scheme-calibration-html.test.ts --maxWorkers=1`

  Expected: FAIL because the renderer does not yet exist.

- [ ] **Step 3: Implement the standalone renderer**

  Render one card per packet row with the screenshot on the left and three mutually-exclusive decisions on the right. Require a note for abstain, persist drafts in `localStorage` under the packet hash, and provide Import JSON, Copy JSON, Download JSON, Clear draft, and Next incomplete. The export must be a `color-scheme-calibration-submission` envelope containing packet binding, reviewer ID, sealed timestamp, and labels.

- [ ] **Step 4: Run renderer tests and verify they pass**

  Run: `npx vitest run src/color-scheme-calibration-html.test.ts --maxWorkers=1`

  Expected: all renderer tests pass.

- [ ] **Step 5: Commit the renderer**

  ```bash
  git add src/color-scheme-calibration-html.ts src/color-scheme-calibration-html.test.ts
  git commit -m "feat(retag): add color-scheme calibration reviewer"
  ```

### Task 3: Add packet-generation and evaluation CLIs

**Files:**
- Create: `src/scripts/color-scheme-calibrate.ts`
- Modify: `package.json`
- Test: `src/scripts/color-scheme-calibrate.test.ts`

**Interfaces:**
- Consumes: the existing audit JSON, a corpus path for exact image URL/hash binding, and reviewer submission JSON.
- Produces: private packet JSON/HTML and an immutable calibration report.

- [ ] **Step 1: Write failing CLI contract tests**

  Use a temporary corpus and a small valid audit fixture. Assert `packet` writes JSON/HTML outside the corpus, refuses an output inside corpus or an existing output, and emits a packet whose rows match the audit hashes. Assert `evaluate` validates a completed submission, writes a report, and refuses stale audit/packet/image bindings. Assert the CLI never changes the corpus bytes.

- [ ] **Step 2: Run the focused CLI tests and verify they fail**

  Run: `npx vitest run src/scripts/color-scheme-calibrate.test.ts --maxWorkers=1`

  Expected: FAIL because the CLI and package script do not yet exist.

- [ ] **Step 3: Implement the CLI and package entrypoint**

  Add:

  ```text
  npm run color-scheme-calibrate -- packet --audit <audit.json> --corpus <corpus/entries.json> --json <packet.json> --html <packet.html> [--size 12]
  npm run color-scheme-calibrate -- evaluate --audit <audit.json> --packet <packet.json> --submission <submission.json> --out <calibration.json> [--minimum-labels 12] [--minimum-accuracy 1]
  ```

  Validate audit JSON with `validateColorSchemeAuditReport`, resolve safe image paths, hash the current image bytes, and refuse stale rows. Use immutable `wx` outputs and realpath-aware corpus containment checks. The evaluate command must print the gate status and metrics but never write the corpus.

- [ ] **Step 4: Run CLI tests and the contract typecheck**

  Run: `npx vitest run src/color-scheme-calibration.test.ts src/color-scheme-calibration-html.test.ts src/scripts/color-scheme-calibrate.test.ts --maxWorkers=1`

  Then run: `npm run typecheck:contracts`

  Expected: all focused tests and typecheck pass.

- [ ] **Step 5: Commit the CLI**

  ```bash
  git add src/scripts/color-scheme-calibrate.ts src/scripts/color-scheme-calibrate.test.ts package.json
  git commit -m "feat(retag): add color-scheme calibration CLI"
  ```

### Task 4: Generate the first private packet and document the gate

**Files:**
- Modify: `docs/RETAG_PROGRAM.md`
- Modify: `TODOS.md`
- Private outputs only: `/tmp/clean-ui-color-scheme-calibration-*.json` and `.html`

- [ ] **Step 1: Run the merged audit against the real corpus**

  Run: `npm run color-scheme-audit -- --corpus /Users/olaniyi.oladokun/Downloads/clean-ui-mcp/corpus/entries.json --out /tmp/clean-ui-color-scheme-audit-<unique>.json`

- [ ] **Step 2: Generate a 12-row stratified human packet**

  Run: `npm run color-scheme-calibrate -- packet --audit /tmp/clean-ui-color-scheme-audit-<unique>.json --corpus /Users/olaniyi.oladokun/Downloads/clean-ui-mcp/corpus/entries.json --json /tmp/clean-ui-color-scheme-calibration-<unique>.json --html /tmp/clean-ui-color-scheme-calibration-<unique>.html --size 12`

  Open the HTML privately and label only from the screenshots. Use `abstain` when the visual evidence is genuinely ambiguous; do not import the existing corpus value.

- [ ] **Step 3: Document that promotion is blocked until the packet passes**

  Record the packet/evaluator workflow and the fact that a passing report is still a prerequisite for a separate reviewed promotion artifact. Do not add any calibration labels to the repository in this task.

- [ ] **Step 4: Run focused verification and review the diff**

  Run: `git diff --check`, `npm run typecheck:contracts`, and the three focused Vitest files from Task 3. Confirm the corpus SHA-256 and entry count are unchanged.

- [ ] **Step 5: Commit documentation and request review**

  ```bash
  git add docs/RETAG_PROGRAM.md TODOS.md
  git commit -m "docs(retag): define color-scheme calibration gate"
  ```

