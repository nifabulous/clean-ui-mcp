# Decision Lab UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the existing Decision Lab screens up to the visual quality of the rest of the curator dashboard while preserving the current single-user upload workflow and all existing API contracts.

**Architecture:** This is a client-only redesign. Keep the current `ui/app.js` Decision Lab route, binder functions, fetch endpoints, and DOM ids/data attributes intact, then replace the rough markup with existing dashboard patterns and add one small zero-dependency markdown renderer for the report brief. Add Decision Lab-specific CSS at the end of `ui/styles.css`, using existing tokens instead of introducing a new visual system.

**Tech Stack:** Vanilla JavaScript SPA in `ui/app.js`, existing dashboard CSS in `ui/styles.css`, Vitest browser smoke tests with Playwright in `src/scripts/ui-browser.test.ts`.

**Design Reference:** `docs/superpowers/specs/2026-07-10-decision-lab-design.md`

## Global Constraints

- No server changes.
- No new runtime dependencies, CDN scripts, build steps, or markdown packages.
- Preserve current endpoints: `GET /api/decisions`, `GET /api/decisions/:id`, `POST /api/decisions`, `PUT /api/decisions/:id`, `POST /api/decision-upload-image`, and `POST /api/decisions/:id/analyze`.
- Preserve current binder selectors: `#decision-setup-form`, `#decision-list`, `#add-direction-btn`, `#analyze-btn`, `#back-to-setup`, `#back-to-builder`, `#export-brief-btn`, `.screen-upload`, `[data-direction-id]`, `[data-remove-screen]`, `[data-rename]`, and `[data-load-decision]`.
- Preserve the current report export behavior: exported file content remains raw markdown from `currentDecision._brief`.
- Render report markdown as safe HTML by escaping content before applying formatting.
- Do not claim real A/B-test results; the UI copy must continue to frame the output as an evidence-grounded pre-launch brief.
- Use existing design tokens: `--canvas`, `--surface`, `--surface-2`, `--ink`, `--ink-2`, `--muted`, `--hairline`, `--hairline-2`, `--accent`, `--pos`, `--warn`, `--neg`, `--display`, `--mono`, and `--radius`.
- Do not use undefined classes such as `.entry-form` or `.muted`.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `ui/app.js` | Add safe inline markdown renderer and replace Decision Lab setup, builder, report, and saved-list markup with existing dashboard patterns. | Modify |
| `ui/styles.css` | Add a scoped Decision Lab section for layout, screen strips, upload dropzones, rendered brief typography, status chips, and responsive behavior. | Modify |
| `src/scripts/ui-browser.test.ts` | Add browser assertions for rendered markdown, redesigned controls, saved-list cards, and responsive-safe report output. | Modify |

---

### Task 1: Browser Tests For The Redesign Contract

**Files:**
- Modify: `src/scripts/ui-browser.test.ts`

**Interfaces:**
- Consumes: Current SPA route `/#/decision-lab`.
- Produces: Regression tests proving the redesigned DOM keeps existing workflow selectors while removing the broken visual contract.

- [ ] **Step 1: Add a reusable report brief fixture and analyze stub**

In `src/scripts/ui-browser.test.ts`, add this near `savedDecisions`:

```ts
const decisionBriefFixture = [
  "# Decision Brief",
  "",
  "## Direction B",
  "",
  "**Lean:** Direction B has stronger hierarchy.",
  "",
  "- The hero copy states the value quickly.",
  "- The CTA is visually dominant.",
  "",
  "| Direction | Evidence |",
  "| --- | --- |",
  "| B | Clear headline |",
  "",
  "---",
  "",
  "<script>window.__decisionBriefXss = true</script>",
].join("\n");
```

Then add this route stub near the existing Decision Lab API stubs:

```ts
if (url.pathname === "/api/decisions/saved-homepage/analyze" && req.method === "POST") {
  return json(res, 200, {
    decision: {
      ...savedDecisions[0],
      analysis: { status: "analyzed", evidenceCoverage: "strong" },
    },
    brief: decisionBriefFixture,
  });
}
```

- [ ] **Step 2: Add a browser test for setup and saved-list visual structure**

Add this test near the existing Decision Lab browser test:

```ts
it("renders Decision Lab setup with dashboard form patterns", async () => {
  const page = await browser!.newPage();
  await page.goto(baseUrl + "/#/decision-lab");

  await page.waitForSelector(".decision-setup .wiz-card");
  expect(await page.locator("#decision-setup-form .field").count()).toBe(6);
  expect(await page.locator("#decision-setup-form .field-row").count()).toBe(3);
  expect(await page.locator("#decision-list .decision-list-card").count()).toBe(1);
  const listText = await page.locator("#decision-list").innerText();
  expect(listText).toContain("2 directions");
  expect(listText).toContain("analyzed");
  expect(await page.locator(".decision-setup .entry-form").count()).toBe(0);
  expect(await page.locator(".decision-setup .muted").count()).toBe(0);

  await page.close();
});
```

- [ ] **Step 3: Add a browser test for builder controls and dropzones**

```ts
it("renders Decision Lab builder with direction cards, screen strips, and dropzones", async () => {
  const page = await browser!.newPage();
  await page.goto(baseUrl + "/#/decision-lab");
  await page.getByText("Saved homepage direction", { exact: true }).click();

  await page.waitForSelector("#analyze-btn");
  expect(await page.locator(".decision-builder .direction-card").count()).toBe(2);
  expect(await page.locator(".decision-builder .screen-strip img").count()).toBe(2);
  expect(await page.locator(".decision-builder .dropzone-screen").count()).toBe(2);
  expect(await page.locator("#analyze-btn").isVisible()).toBe(true);
  expect(await page.locator("#back-to-setup").isVisible()).toBe(true);

  await page.close();
});
```

- [ ] **Step 4: Add a browser test for rendered markdown and XSS safety**

```ts
it("renders the Decision Lab report brief as safe formatted HTML", async () => {
  const page = await browser!.newPage();
  await page.goto(baseUrl + "/#/decision-lab");
  await page.getByText("Saved homepage direction", { exact: true }).click();
  await page.waitForSelector("#analyze-btn");
  await page.locator("#analyze-btn").click();

  await page.waitForSelector(".decision-brief-rendered");
  expect(await page.locator(".decision-brief-rendered h2").innerText()).toContain("Decision Brief");
  expect(await page.locator(".decision-brief-rendered h3").innerText()).toContain("Direction B");
  expect(await page.locator(".decision-brief-rendered strong").innerText()).toContain("Lean:");
  expect(await page.locator(".decision-brief-rendered li").count()).toBe(2);
  expect(await page.locator(".decision-brief-rendered table.decision-table").count()).toBe(1);
  expect(await page.locator(".decision-brief-rendered script").count()).toBe(0);
  expect(await page.evaluate(() => (window as any).__decisionBriefXss)).toBeUndefined();

  await page.close();
});
```

- [ ] **Step 5: Run the focused browser tests and verify failure**

Run:

```bash
npx vitest run src/scripts/ui-browser.test.ts --reporter=dot
```

Expected: FAIL because `.wiz-card`, `.decision-list-card`, `.dropzone-screen`, and `.decision-brief-rendered` do not exist yet, and reports still use `<pre class="decision-brief">`.

- [ ] **Step 6: Commit the failing tests**

```bash
git add src/scripts/ui-browser.test.ts
git commit -m "test(decision-lab): capture UI redesign contract"
```

---

### Task 2: Safe Inline Markdown Renderer

**Files:**
- Modify: `ui/app.js`

**Interfaces:**
- Consumes: Raw markdown string from `currentDecision._brief`.
- Produces: `renderMarkdown(md: string): string`, returning safe HTML for headings, bold, lists, tables, paragraphs, and horizontal rules.

- [ ] **Step 1: Add `renderMarkdown()` after `esc()` in `ui/app.js`**

Find the existing `esc()` helper and add this function immediately after it:

```js
function renderInlineMarkdown(text){
  return esc(text).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function renderMarkdown(md){
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const html = [];
  let i = 0;

  const closeList = () => {
    const last = html[html.length - 1];
    if (last === '<ul-open>') html[html.length - 1] = '</ul>';
    if (last === '<ol-open>') html[html.length - 1] = '</ol>';
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      closeList();
      i += 1;
      continue;
    }
    if (/^-{3,}$/.test(trimmed)) {
      closeList();
      html.push('<hr>');
      i += 1;
      continue;
    }
    if (/^\|.+\|$/.test(trimmed) && /^\|[\s:-]+\|/.test((lines[i + 1] || '').trim())) {
      closeList();
      const header = trimmed.split('|').slice(1, -1).map((c) => `<th>${renderInlineMarkdown(c.trim())}</th>`).join('');
      i += 2;
      const rows = [];
      while (/^\|.+\|$/.test((lines[i] || '').trim())) {
        rows.push(`<tr>${lines[i].trim().split('|').slice(1, -1).map((c) => `<td>${renderInlineMarkdown(c.trim())}</td>`).join('')}</tr>`);
        i += 1;
      }
      html.push(`<table class="decision-table"><thead><tr>${header}</tr></thead><tbody>${rows.join('')}</tbody></table>`);
      continue;
    }
    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = heading[1].length + 1;
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }
    const bullet = trimmed.match(/^-\s+(.+)$/);
    if (bullet) {
      if (html[html.length - 1] !== '<ul-open>') {
        closeList();
        html.push('<ul>');
        html.push('<ul-open>');
      }
      html.splice(html.length - 1, 0, `<li>${renderInlineMarkdown(bullet[1])}</li>`);
      i += 1;
      continue;
    }
    const ordered = trimmed.match(/^\d+\.\s+(.+)$/);
    if (ordered) {
      if (html[html.length - 1] !== '<ol-open>') {
        closeList();
        html.push('<ol>');
        html.push('<ol-open>');
      }
      html.splice(html.length - 1, 0, `<li>${renderInlineMarkdown(ordered[1])}</li>`);
      i += 1;
      continue;
    }

    closeList();
    html.push(`<p>${renderInlineMarkdown(trimmed)}</p>`);
    i += 1;
  }
  closeList();
  return html.filter((line) => line !== '<ul-open>' && line !== '<ol-open>').join('');
}
```

- [ ] **Step 2: Run a quick lint-style syntax check**

Run:

```bash
node --check ui/app.js
```

Expected: PASS.

- [ ] **Step 3: Commit the renderer**

```bash
git add ui/app.js
git commit -m "feat(decision-lab): render brief markdown safely"
```

---

### Task 3: Redesign Setup And Saved Decisions

**Files:**
- Modify: `ui/app.js`
- Modify: `ui/styles.css`

**Interfaces:**
- Consumes: Existing `bindDecisionSetup()` and `loadDecisionList()` behavior.
- Produces: Setup view using `.wiz-card`, `.field`, `.field-row`, `.step-title`, `.step-sub`, `.card`, and `.chip`.

- [ ] **Step 1: Replace `renderDecisionSetup()` markup**

Replace the whole `renderDecisionSetup()` function with:

```js
function renderDecisionSetup() {
  return `
    <div class="decision-setup">
      <section class="wiz-card decision-setup-card">
        <div class="card-head">
          <div>
            <h2 class="step-title">Decision Lab</h2>
            <p class="step-sub">Compare two or three competing designs before you ship. Get an evidence-grounded brief, not a verdict.</p>
          </div>
        </div>
        <form id="decision-setup-form" class="decision-form">
          <div class="field">
            <label>Title</label>
            <input type="text" name="title" placeholder="Choose the homepage direction" required>
          </div>
          <div class="field-row">
            <div class="field">
              <label>Target user</label>
              <input type="text" name="targetUser" placeholder="First-time visitors" required>
            </div>
            <div class="field">
              <label>Business goal</label>
              <input type="text" name="businessGoal" placeholder="Make the value prop clear in 10s" required>
            </div>
          </div>
          <div class="field-row">
            <div class="field">
              <label>Primary KPI</label>
              <input type="text" name="primaryKpi" placeholder="Trial starts" required>
            </div>
            <div class="field">
              <label>Platform <span class="opt">optional</span></label>
              <select name="platform"><option value="">Any</option><option value="web">Web</option><option value="mobile">Mobile</option><option value="tablet">Tablet</option></select>
            </div>
          </div>
          <div class="field-row">
            <div class="field">
              <label>Constraints <span class="opt">optional</span></label>
              <input type="text" name="constraints" placeholder="Must use existing color system">
            </div>
            <div class="field decision-scope-field">
              <label>Scope</label>
              <input type="text" value="Single screen comparison" disabled>
            </div>
          </div>
          <button type="submit" class="btn primary decision-primary">Create decision</button>
        </form>
      </section>
      <div id="decision-list" class="decision-list"></div>
    </div>`;
}
```

- [ ] **Step 2: Replace saved decision list markup in `loadDecisionList()`**

Replace the `container.innerHTML = ...` assignment inside `loadDecisionList()` with:

```js
container.innerHTML = `
  <div class="decision-list-head">
    <h3>Saved decisions</h3>
    <span class="eyebrow">${data.decisions.length} total</span>
  </div>
  <div class="decision-list-grid">
    ${data.decisions.map(d => {
      const analyzed = !!d.analysis;
      const dirs = `${d.directions.length} direction${d.directions.length===1?'':'s'}`;
      const status = analyzed ? '<span class="chip decision-chip strong">analyzed</span>' : '<span class="chip decision-chip">draft</span>';
      return `<a class="card decision-list-card" data-load-decision="${d.id}" href="#/decision-lab">
        <div>
          <div class="decision-list-title">${esc(d.title)}</div>
          <div class="decision-list-meta">${esc(d.context?.targetUser || 'No target user')} · ${esc(d.context?.primaryKpi || 'No KPI')}</div>
        </div>
        <div class="decision-list-actions">
          <span class="chip decision-chip">${dirs}</span>
          ${status}
        </div>
      </a>`;
    }).join('')}
  </div>`;
```

- [ ] **Step 3: Add setup/list CSS**

Append this section to the end of `ui/styles.css`:

```css
/* -- Decision Lab ---------------------------------------------------------- */
.decision-setup,
.decision-builder,
.decision-report {
  max-width: 960px;
}
.decision-form {
  display: grid;
  gap: 14px;
}
.decision-primary {
  justify-content: center;
  width: 100%;
}
.decision-scope-field input:disabled {
  color: var(--muted);
  background: var(--surface-2);
}
.decision-list {
  margin-top: 18px;
}
.decision-list-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin: 22px 0 10px;
}
.decision-list-head h3 {
  font-family: var(--display);
  font-size: 16px;
  font-weight: 600;
}
.decision-list-grid {
  display: grid;
  gap: 10px;
}
.decision-list-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  color: inherit;
  text-decoration: none;
  margin-bottom: 0;
}
.decision-list-card:hover {
  border-color: var(--hairline-2);
  background: var(--surface-2);
}
.decision-list-title {
  font-size: 13px;
  font-weight: 650;
}
.decision-list-meta {
  margin-top: 4px;
  color: var(--muted);
  font: 11px/1.45 var(--mono);
}
.decision-list-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.decision-chip {
  cursor: default;
}
.decision-chip.strong {
  color: var(--pos);
  border-color: transparent;
  background: var(--pos-soft);
}
```

- [ ] **Step 4: Run focused browser tests**

Run:

```bash
npx vitest run src/scripts/ui-browser.test.ts --reporter=dot
```

Expected: The setup/list test passes. Builder/report tests still fail until later tasks.

- [ ] **Step 5: Commit setup/list redesign**

```bash
git add ui/app.js ui/styles.css src/scripts/ui-browser.test.ts
git commit -m "feat(decision-lab): redesign setup and saved decisions"
```

---

### Task 4: Redesign Builder View

**Files:**
- Modify: `ui/app.js`
- Modify: `ui/styles.css`

**Interfaces:**
- Consumes: Existing `bindDecisionBuilder()` selectors.
- Produces: Direction cards with screen strips, upload dropzones, context summary, and stable actions.

- [ ] **Step 1: Replace `renderDecisionBuilder()` markup**

Replace the whole `renderDecisionBuilder(decision)` function with:

```js
function renderDecisionBuilder(decision) {
  const ready = decision.directions.length >= 2 && decision.directions.every((dir) => dir.screens.length > 0);
  const dirCards = decision.directions.map((dir, i) => {
    const label = String.fromCharCode(65 + i);
    const screens = dir.screens.length ? dir.screens.map(s =>
      `<img src="/api/image?path=${encodeURIComponent(s.imageRef)}" alt="${esc(dir.name)} screen">`
    ).join('') : '<div class="screen-empty">No screen uploaded yet</div>';
    return `<article class="card direction-card">
      <div class="card-head">
        <div class="direction-title">
          <span class="chip dir-badge">Direction ${label}</span>
          <input type="text" value="${esc(dir.name)}" data-rename="${dir.id}" aria-label="Direction ${label} name">
        </div>
      </div>
      <div class="screen-strip">${screens}</div>
      <label class="dropzone dropzone-screen">
        <span class="dz-title">${dir.screens.length ? 'Upload another screen' : 'Upload a screenshot'}</span>
        <span class="dz-sub">PNG, JPG, or WebP</span>
        <input type="file" accept="image/png,image/jpeg,image/webp" data-direction-id="${dir.id}" class="screen-upload">
      </label>
      <button class="btn ghost" data-remove-screen="${dir.id}" ${dir.screens.length ? '' : 'disabled'}>Remove last screen</button>
    </article>`;
  }).join('');

  return `
    <div class="decision-builder">
      <section class="card decision-context-card">
        <div class="card-head">
          <div>
            <div class="eyebrow">Decision brief setup</div>
            <h3>${esc(decision.title)}</h3>
          </div>
          <button class="btn ghost" id="back-to-setup">New decision</button>
        </div>
        <div class="decision-context-meta">
          <span>Target: ${esc(decision.context.targetUser)}</span>
          <span>Goal: ${esc(decision.context.businessGoal)}</span>
          <span>KPI: ${esc(decision.context.primaryKpi)}</span>
        </div>
      </section>
      <div class="directions-toolbar">
        ${decision.directions.length < 3 ? `<button class="btn" id="add-direction-btn">Add direction</button>` : '<span class="eyebrow">Maximum 3 directions</span>'}
      </div>
      <div id="directions-grid" class="directions-grid">${dirCards}</div>
      <button class="btn primary decision-analyze" id="analyze-btn" ${ready ? '' : 'disabled title="Need 2 directions with at least 1 screen each"'}>Analyze</button>
    </div>`;
}
```

- [ ] **Step 2: Add builder CSS**

Append after the Decision Lab setup CSS:

```css
.decision-context-card h3 {
  font-family: var(--display);
  font-size: 18px;
  font-weight: 600;
}
.decision-context-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
  color: var(--ink-2);
  font: 11.5px/1.45 var(--mono);
}
.directions-toolbar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  margin: 2px 0 12px;
}
.directions-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 16px;
}
.direction-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.direction-title {
  display: grid;
  gap: 8px;
  width: 100%;
}
.direction-title input {
  width: 100%;
  height: 34px;
  border: 1px solid var(--hairline-2);
  border-radius: 7px;
  background: var(--surface);
  color: var(--ink);
  padding: 0 10px;
  font: 600 13px/1 var(--sans);
}
.direction-title input:focus {
  border-color: var(--accent);
  outline: 3px solid var(--accent-soft);
}
.dir-badge {
  width: fit-content;
  cursor: default;
}
.screen-strip {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding-bottom: 2px;
  min-height: 104px;
}
.screen-strip img,
.screen-empty {
  width: 160px;
  height: 100px;
  flex: 0 0 auto;
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  background: var(--surface-2);
}
.screen-strip img {
  object-fit: cover;
}
.screen-empty {
  display: grid;
  place-items: center;
  color: var(--muted);
  font: 11px/1.4 var(--mono);
  text-align: center;
  padding: 10px;
}
.dropzone-screen {
  position: relative;
  padding: 16px;
  cursor: pointer;
}
.dropzone-screen input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}
.decision-analyze {
  width: 100%;
  justify-content: center;
  margin-top: 16px;
}
.decision-analyze:disabled,
.direction-card .btn:disabled {
  opacity: .45;
  cursor: not-allowed;
}
```

- [ ] **Step 3: Run focused browser tests**

Run:

```bash
npx vitest run src/scripts/ui-browser.test.ts --reporter=dot
```

Expected: Setup/list and builder tests pass. Report test still fails until Task 5.

- [ ] **Step 4: Commit builder redesign**

```bash
git add ui/app.js ui/styles.css
git commit -m "feat(decision-lab): redesign direction builder"
```

---

### Task 5: Redesign Report View

**Files:**
- Modify: `ui/app.js`
- Modify: `ui/styles.css`

**Interfaces:**
- Consumes: `currentDecision._brief`, `decision.analysis.evidenceCoverage`, and existing export button behavior.
- Produces: Report card that renders markdown as formatted safe HTML while keeping raw markdown export.

- [ ] **Step 1: Replace `renderDecisionReport()` markup**

Replace the whole `renderDecisionReport(decision)` function with:

```js
function renderDecisionReport(decision) {
  const brief = decision._brief || '';
  const coverage = decision.analysis?.evidenceCoverage;
  const coverageChip = coverage
    ? `<span class="chip decision-chip coverage-${esc(coverage)}">${esc(coverage)} evidence</span>`
    : '';
  return `
    <div class="decision-report">
      <section class="card decision-report-card">
        <div class="card-head">
          <div>
            <div class="eyebrow">Decision brief</div>
            <h3>${esc(decision.title)}</h3>
          </div>
          <div class="decision-report-actions">
            ${coverageChip}
            <button class="btn ghost" id="back-to-builder">Back to directions</button>
            <button class="btn primary" id="export-brief-btn">Export brief (.md)</button>
          </div>
        </div>
        <div class="decision-brief-rendered">${renderMarkdown(brief)}</div>
      </section>
    </div>`;
}
```

- [ ] **Step 2: Add report CSS**

Append after the Decision Lab builder CSS:

```css
.decision-report-card h3 {
  font-family: var(--display);
  font-size: 18px;
  font-weight: 600;
}
.decision-report-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.coverage-strong {
  color: var(--pos);
  border-color: transparent;
  background: var(--pos-soft);
}
.coverage-limited {
  color: var(--warn);
  border-color: transparent;
  background: var(--warn-soft);
}
.coverage-unavailable {
  color: var(--neg);
  border-color: transparent;
  background: var(--neg-soft);
}
.decision-brief-rendered {
  max-width: 760px;
  color: var(--ink-2);
  font-size: 13px;
  line-height: 1.6;
}
.decision-brief-rendered h2,
.decision-brief-rendered h3,
.decision-brief-rendered h4 {
  font-family: var(--display);
  color: var(--ink);
  font-weight: 600;
}
.decision-brief-rendered h2 {
  font-size: 18px;
  margin: 20px 0 8px;
}
.decision-brief-rendered h3 {
  font-size: 16px;
  margin: 18px 0 8px;
}
.decision-brief-rendered h4 {
  font-size: 14px;
  margin: 16px 0 6px;
}
.decision-brief-rendered p {
  margin: 8px 0;
}
.decision-brief-rendered ul,
.decision-brief-rendered ol {
  margin: 8px 0;
  padding-left: 20px;
}
.decision-brief-rendered li {
  margin: 4px 0;
}
.decision-brief-rendered strong {
  color: var(--ink);
  font-weight: 650;
}
.decision-brief-rendered hr {
  border: 0;
  border-top: 1px solid var(--hairline);
  margin: 20px 0;
}
.decision-table {
  width: 100%;
  border-collapse: collapse;
  margin: 12px 0;
  font-size: 12px;
}
.decision-table th,
.decision-table td {
  border: 1px solid var(--hairline);
  padding: 8px 10px;
  text-align: left;
  vertical-align: top;
}
.decision-table th {
  background: var(--surface-2);
  color: var(--ink);
  font-weight: 650;
}
```

- [ ] **Step 3: Run focused browser tests**

Run:

```bash
npx vitest run src/scripts/ui-browser.test.ts --reporter=dot
```

Expected: All Decision Lab UI redesign browser tests pass.

- [ ] **Step 4: Commit report redesign**

```bash
git add ui/app.js ui/styles.css
git commit -m "feat(decision-lab): render redesigned report brief"
```

---

### Task 6: Responsive Polish And Final Verification

**Files:**
- Modify: `ui/styles.css`

**Interfaces:**
- Consumes: Redesigned setup, builder, and report markup.
- Produces: Responsive behavior that avoids overflow and keeps controls usable on narrow screens.

- [ ] **Step 1: Add responsive CSS**

Append after the Decision Lab report CSS:

```css
@media (max-width: 720px) {
  .decision-setup,
  .decision-builder,
  .decision-report {
    max-width: none;
  }
  .decision-list-card,
  .decision-report-actions {
    align-items: flex-start;
    flex-direction: column;
  }
  .decision-list-actions {
    justify-content: flex-start;
  }
  .directions-grid {
    grid-template-columns: 1fr;
  }
  .screen-strip img,
  .screen-empty {
    width: 148px;
    height: 94px;
  }
  .decision-report-actions .btn,
  .decision-analyze,
  .decision-primary {
    width: 100%;
    justify-content: center;
  }
}
```

- [ ] **Step 2: Run syntax and browser verification**

Run:

```bash
node --check ui/app.js
npx vitest run src/scripts/ui-browser.test.ts --reporter=dot
```

Expected: Both commands pass.

- [ ] **Step 3: Run the impacted unit/browser suite**

Run:

```bash
npx vitest run src/scripts/ui-browser.test.ts src/scripts/ui-server.test.ts src/decision-lab.test.ts src/decisions.test.ts src/schema.test.ts
```

Expected: All listed suites pass.

- [ ] **Step 4: Run the production build**

Run:

```bash
npm run build
```

Expected: TypeScript build completes successfully.

- [ ] **Step 5: Manual browser QA**

Run:

```bash
npm run ui
```

Manual checks:

1. Open `http://localhost:3131/#/decision-lab`.
2. Confirm the setup view visually matches the Add Entry wizard card style.
3. Create a homepage comparison decision.
4. Upload one screenshot to Direction A and one screenshot to Direction B.
5. Confirm thumbnails render in horizontal screen strips and no inline borders use `var(--border)`.
6. Run analysis if a provider is configured.
7. Confirm the report renders headings, bold text, lists, tables, and horizontal rules as formatted HTML.
8. Confirm export downloads the raw markdown brief.
9. Resize to a narrow viewport around 390px wide and confirm controls stack without text overlap.

- [ ] **Step 6: Commit responsive polish**

```bash
git add ui/styles.css
git commit -m "fix(decision-lab): polish responsive redesign"
```

---

## Self-Review

**Spec coverage:** This plan covers the UI portion of the Decision Lab spec: setup, direction importer, comparison report, evidence coverage chip, report export, and responsive behavior. It intentionally does not add Figma, multi-screen flow methodology, MCP tools, server changes, or analysis changes.

**Placeholder scan:** No TBD/TODO/fill-later placeholders remain. Each task includes concrete selectors, code, commands, and expected outcomes.

**Type and selector consistency:** The plan preserves the existing binder selectors and endpoint names, so the UI redesign should not break the current workflow. The new CSS uses scoped `.decision-*` classes and existing global patterns.

**Known implementation caution:** The analyze button should only be disabled when there are fewer than two directions or a direction has no uploaded screen. The saved-decision browser fixture already has two directions with one screen each, so the report test should reach the redesigned report through the real click path.
