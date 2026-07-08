# Add Flow Curator Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the SPA `#/add` flow into a clean-ui-native curator workbench with evidence-first screenshots, a session rail, clearer review behavior, accessibility affordances, and browser test coverage.

**Architecture:** Keep the existing vanilla JS SPA and shared `draft` state. Replace only the `#/add` render surface and candidate/status markup in `ui/app.js`, add scoped CSS in `ui/styles.css`, and update browser tests in `src/scripts/ui-browser.test.ts` to lock down the new UX.

**Tech Stack:** TypeScript/Vitest/Playwright for tests; vanilla JavaScript template strings and CSS custom properties for the SPA.

## Global Constraints

- No backend API changes.
- No corpus schema changes.
- No rewrite of capture, auto-fill, commit, or save functions.
- No new frontend framework or build step.
- Reuse the dashboard visual system: Fraunces, Archivo, IBM Plex Mono, `--canvas`, `--surface`, `--hairline`, `--hairline-2`, and `--accent`.
- Rail owns bulk/session actions; review sheet owns single-entry save.
- Candidate checkbox is the primary selection control; selected borders are only visual consequences.
- Add browser coverage for candidate selection, rail action-switching, single save CTA, mobile ordering, and live progress.

---

### Task 1: Browser Tests For Workbench States

**Files:**
- Modify: `src/scripts/ui-browser.test.ts`

**Interfaces:**
- Consumes: existing test server and `/#/add` SPA route.
- Produces: failing tests that require `add-workbench`, `add-session-rail`, `candidate-specimen`, `review-sheet`, and `addProgressLive`.

- [ ] **Step 1: Add capture-candidates stub**

Add this route in the test server before the `/api/capture-url` route:

```ts
if (url.pathname === "/api/capture-candidates" && req.method === "POST") {
  const body = JSON.parse(await readBody(req) || "{}");
  return json(res, 201, {
    batchId: "add-test-batch",
    candidates: [
      {
        id: "candidate-a",
        imagePath: "images-private/candidate-a.png",
        width: 1200,
        height: 800,
        sourceUrl: body.url || "https://example.com",
        sourceName: "Example",
        captureMode: "section",
        viewport: "desktop",
      },
      {
        id: "candidate-b",
        imagePath: "images-private/candidate-b.png",
        width: 390,
        height: 844,
        sourceUrl: body.url || "https://example.com",
        sourceName: "Example",
        captureMode: "viewport",
        viewport: "mobile",
      },
    ],
  });
}
```

- [ ] **Step 2: Add failing candidate selection and rail test**

Add a SPA test that captures a URL, selects a candidate, verifies the rail tally, clicks auto-fill, and checks that the review action appears:

```ts
it("uses a workbench rail for candidate selection and auto-fill actions", async () => {
  openaiConfigured = true;
  const page = await browser!.newPage();
  await page.goto(baseUrl + "/#/add");
  await page.fill("#addCaptureForm input[name='url']", "https://example.com");
  await page.locator("#addCaptureForm button[type='submit']").click();
  await page.waitForSelector(".candidate-specimen");

  expect(await page.locator(".add-workbench").count()).toBe(1);
  expect(await page.locator(".add-session-rail").count()).toBe(1);
  expect(await page.locator(".candidate-specimen").count()).toBe(2);

  await page.locator("[data-candidate-pick='0']").check();
  await expect(page.locator(".add-session-rail")).toContainText("1 selected");
  await page.getByRole("button", { name: /Auto-fill selected/ }).click();
  await page.waitForSelector("[data-candidate-review='0']");
  await expect(page.locator(".add-session-rail")).toContainText("1 tagged");
  await page.close();
});
```

- [ ] **Step 3: Add failing review single-save test**

Add a test proving candidate review has one save CTA and no rail duplicate:

```ts
it("keeps single-entry save inside the review sheet during candidate review", async () => {
  openaiConfigured = true;
  const page = await browser!.newPage();
  await page.goto(baseUrl + "/#/add");
  await page.fill("#addCaptureForm input[name='url']", "https://example.com");
  await page.locator("#addCaptureForm button[type='submit']").click();
  await page.waitForSelector(".candidate-specimen");
  await page.locator("[data-candidate-pick='0']").check();
  await page.getByRole("button", { name: /Auto-fill selected/ }).click();
  await page.waitForSelector("[data-candidate-review='0']");
  await page.locator("[data-candidate-review='0']").click();
  await page.waitForSelector(".review-sheet");

  expect(await page.locator(".review-sheet button[type='submit']", { hasText: /Save entry/ }).count()).toBe(1);
  expect(await page.locator(".add-session-rail button", { hasText: /Save entry/ }).count()).toBe(0);
  await expect(page.locator(".add-session-rail")).toContainText("Back to queue");
  await page.close();
});
```

- [ ] **Step 4: Add failing mobile/live-region test**

Add a test that checks mobile ordering and the polite live region:

```ts
it("uses mobile artifact-before-session ordering and exposes progress live text", async () => {
  const page = await browser!.newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(baseUrl + "/#/add");
  await page.waitForSelector(".add-workbench");

  const order = await page.locator(".source-strip, .add-artifact, .add-session-rail").evaluateAll((els) => els.map((el) => Array.from(el.classList).join(" ")));
  expect(order[0]).toContain("source-strip");
  expect(order[1]).toContain("add-artifact");
  expect(order[2]).toContain("add-session-rail");
  expect(await page.locator("#addProgressLive[aria-live='polite']").count()).toBe(1);
  await page.close();
});
```

- [ ] **Step 5: Run tests and verify RED**

Run: `npm test -- src/scripts/ui-browser.test.ts`

Expected: FAIL because the new workbench classes, rail behavior, and live region do not exist yet.

### Task 2: Workbench Markup And Rail Behavior

**Files:**
- Modify: `ui/app.js`

**Interfaces:**
- Consumes: existing `draft`, `candidateTally()`, `renderCandidateStep()`, `renderCandidateStatusTable()`, `wizardCapture()`, `wizardUpload()`, `wizardAutoTag()`, `autoFillCandidates()`, `commitCandidates()`, `reviewCandidate()`, and `saveDraft()`.
- Produces: `add-workbench`, `source-strip`, `add-artifact`, `add-session-rail`, `review-sheet`, and `addProgressLive` DOM used by tests and CSS.

- [ ] **Step 1: Replace inline candidate cards with specimen classes**

In `renderCandidateStep()`, make each candidate card use `.candidate-specimen`, checkbox-primary selection, and accessible preview controls.

- [ ] **Step 2: Render status table as workbench status**

In `renderCandidateStatusTable()`, preserve existing row actions while making the table fit inside the artifact column and using accessible preview labels.

- [ ] **Step 3: Add session rail helper**

Create a `renderAddSessionRail({ hasImage, hasFields, hasCandidates, reviewing, busy })` helper that computes tallies, progress text, and primary actions. It must not render `Save entry`.

- [ ] **Step 4: Replace `#/add` return template**

Render:

```html
<div class="add-workbench">
  <div class="source-strip">...</div>
  <section class="add-artifact">...</section>
  <aside class="add-session-rail">...</aside>
</div>
<div id="addProgressLive" class="sr-only" aria-live="polite">...</div>
```

Keep the source strip first in DOM order, then artifact, then rail.

- [ ] **Step 5: Keep save inside review sheet**

Render the review form as `.review-sheet`; the only `Save entry` button must be the form submit button.

- [ ] **Step 6: Run tests and verify GREEN for behavior**

Run: `npm test -- src/scripts/ui-browser.test.ts`

Expected: new add-flow tests pass; unrelated failures, if any, must be fixed before proceeding.

### Task 3: Workbench Visual System And Responsive CSS

**Files:**
- Modify: `ui/styles.css`

**Interfaces:**
- Consumes: DOM classes from Task 2.
- Produces: clean-ui-native two-column workbench, sticky rail, candidate specimen cards, review sheet, mobile ordering, and screen-reader utility styles.

- [ ] **Step 1: Add scoped workbench CSS**

Add CSS for `.add-workbench`, `.source-strip`, `.add-artifact`, `.add-session-rail`, `.candidate-specimen`, `.review-sheet`, `.session-stat`, `.session-action`, and `.sr-only`.

- [ ] **Step 2: Add responsive collapse**

At mobile/tablet widths, set `.add-workbench` to one column and use CSS grid/order so `.source-strip` is first, `.add-artifact` second, and `.add-session-rail` third with sticky bottom behavior when practical.

- [ ] **Step 3: Verify browser tests**

Run: `npm test -- src/scripts/ui-browser.test.ts`

Expected: PASS.

### Task 4: Full Verification

**Files:**
- No code changes expected.

**Interfaces:**
- Consumes: completed implementation.
- Produces: verified build/test status.

- [ ] **Step 1: Run full test suite**

Run: `npm test`

Expected: PASS.

- [ ] **Step 2: Run build**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 3: Inspect git diff**

Run: `git diff --stat && git diff --check`

Expected: changed files are limited to the plan, tests, `ui/app.js`, and `ui/styles.css`; `git diff --check` reports no whitespace errors.
