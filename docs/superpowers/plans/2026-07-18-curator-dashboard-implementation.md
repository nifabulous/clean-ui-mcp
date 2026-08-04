# Curator Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the existing vanilla JavaScript curator console into a true dashboard product while preserving all existing workflows, selectors, APIs, and persistence protections.

**Architecture:** Keep `index-2.html`, `ui/app.js`, and `ui/styles.css` as the dashboard SPA. Introduce the shared token names from the public plan, reorganize navigation around Dashboard/Library/Curation/Insights/System, replace the current overview with an actionable dashboard, and progressively restyle existing modules without rewriting the router or server contracts.

**Tech Stack:** Existing vanilla JavaScript hash-routed SPA, CSS custom properties, Node HTTP UI server, TypeScript aggregation helpers where server changes are justified, Vitest, Playwright.

## Global Constraints

- Preserve existing curator endpoint request and response shapes unless a task explicitly adds a narrowly scoped read-only endpoint.
- Preserve persistence write protection, snapshot recovery, mutation serialization, same-origin enforcement, SSRF controls, duplicate checks, and provider behavior.
- Preserve browser-test workflow selectors for Add entry, bulk import, capture, entry editing, and Decision Lab.
- Do not migrate the curator SPA to React or introduce a client build step.
- Dashboard widgets may display only metrics derived from existing data or a tested read-only endpoint.
- WCAG 2.2 AA is the minimum accessibility target.
- Light mode uses the shared architectural-light tokens; dark mode uses true neutral charcoal tokens.
- The dashboard must remain fully usable with JavaScript/CSS served from `/static/` by the existing UI server.
- Desktop is the complete curation environment; mobile supports monitoring, search, inspection, lightweight review, and safe quick-add actions.
- Run a focused code review and write the required `.zcode` task review artifact after every task; run a holistic branch review before push.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `index-2.html` | Semantic dashboard shell, skip link, navigation landmarks, top bar, drawer, and live regions. | Modify |
| `ui/styles.css` | Shared tokens, true themes, dashboard shell, components, module styles, responsive rules. | Modify |
| `ui/app.js` | Navigation, theme, dashboard rendering, drill-down links, detail focus, and workflow states. | Modify |
| `src/scripts/ui-browser.test.ts` | Dashboard, theme, accessibility, responsive, and preserved-workflow tests. | Modify |
| `docs/design-system.md` | Shared contract produced by the public plan; curator implementation notes. | Modify |
| `.github/workflows/ci.yml` | Cross-surface browser and accessibility checks. | Modify |

---

### Task 1: Apply Shared Tokens And True Theme Behavior

**Files:**
- Modify: `index-2.html`
- Modify: `ui/styles.css`
- Modify: `ui/app.js`
- Modify: `src/scripts/ui-browser.test.ts`
- Modify: `docs/design-system.md`

**Interfaces:**
- Consumes: token contract from `docs/design-system.md`.
- Produces: `window.cleanUiTheme = { getTheme, setTheme, clearTheme }` for testable theme behavior.
- Persists: local storage key `clean-ui-theme`.

- [ ] **Step 1: Add failing browser tests for both themes**

Add tests that set OS preference, verify the initial `data-theme`, toggle theme, reload, and assert the explicit choice persists without a flash. Assert dark computed `--canvas` is `#111113` and contains no blue/green base hue.

```ts
it("persists an explicit neutral dark theme", async () => {
  const page = await browser!.newPage({ colorScheme: "light" });
  await page.goto(baseUrl + "/");
  await page.getByRole("button", { name: /switch to dark theme/i }).click();
  await page.reload();
  expect(await page.locator("html").getAttribute("data-theme")).toBe("dark");
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim())).toBe("#111113");
  await page.close();
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run `npx vitest run src/scripts/ui-browser.test.ts -t "theme"`.

Expected: FAIL because the dashboard has no approved theme controller/tokens.

- [ ] **Step 3: Add pre-paint resolution to `index-2.html`**

Insert the same synchronous resolver used by `site/index.html` before the stylesheet link. Add a theme button with an accessible name and stable `#themeToggle` ID to the top bar.

- [ ] **Step 4: Replace the legacy token block**

Map the existing component aliases to the shared tokens so incremental module migration does not break:

```css
:root {
  --canvas:#f3f6fb; --surface:#ffffff; --surface-2:#f8fafc;
  --ink:#0b2348; --ink-2:#637089; --muted:#7b879a;
  --hairline:#e5eaf1; --hairline-2:#dbe3ef;
  --focus:#2457d6; --pos:#287a4d; --warn:#986515; --neg:#b33a2b;
}
:root[data-theme="dark"] {
  --canvas:#111113; --surface:#19191c; --surface-2:#222226;
  --ink:#f4f4f5; --ink-2:#c4c4ca; --muted:#a1a1aa;
  --hairline:#2b2b30; --hairline-2:#34343a;
  --focus:#a8c7ff; --pos:#78a887; --warn:#d2a455; --neg:#e17a6b;
}
```

Remove the old teal `--accent`; map action emphasis to `--ink` and focus/links to `--focus`. Preserve distinct semantic status colors.

- [ ] **Step 5: Implement theme controller and OS subscription**

Expose pure `getTheme`/`setTheme` behavior, update `aria-label`, and subscribe to OS theme changes only when local storage has no explicit choice.

- [ ] **Step 6: Run focused tests and contrast smoke**

Run the theme browser tests. Inspect Dashboard, Entries, Add, and Decision Lab in both themes for invisible borders, text, focus, and status labels.

Expected: theme tests PASS and no base dark token is chromatically tinted.

- [ ] **Step 7: Review and commit**

After task review/artifact:

```bash
git add index-2.html ui/styles.css ui/app.js src/scripts/ui-browser.test.ts docs/design-system.md
git commit -m "feat(dashboard): add shared light and dark themes"
```

---

### Task 2: Rebuild The Semantic Dashboard Shell And Navigation

**Files:**
- Modify: `index-2.html`
- Modify: `ui/app.js`
- Modify: `ui/styles.css`
- Modify: `src/scripts/ui-browser.test.ts`

**Interfaces:**
- Produces navigation groups: Dashboard, Library, Curation, Insights, System.
- Preserves all route IDs: `overview`, `entries`, `add`, `bulk`, `sources`, `capture`, `search`, `embeddings`, `compare`, `quality`, `settings`, `decision-lab`.

- [ ] **Step 1: Add failing shell tests**

Assert semantic `header`, `nav`, `main`, skip link, active-route `aria-current="page"`, visible Dashboard label, global search, quick Add action, and mobile drawer Escape/focus return.

- [ ] **Step 2: Verify failure**

Run `npx vitest run src/scripts/ui-browser.test.ts -t "dashboard shell"`.

Expected: FAIL because the existing shell lacks the approved landmarks/grouping/focus contract.

- [ ] **Step 3: Restructure the navigation configuration**

Use:

```js
const NAV = [
  { group:'', items:[{ id:'overview', label:'Dashboard', icon:'overview' }] },
  { group:'Library', items:[
    { id:'entries', label:'Entries', icon:'entries' },
    { id:'search', label:'Search', icon:'search' },
    { id:'compare', label:'Compare', icon:'gitcompare' },
  ]},
  { group:'Curation', items:[
    { id:'add', label:'Add entry', icon:'plus' },
    { id:'capture', label:'Capture triage', icon:'circle' },
    { id:'quality', label:'Review queue', icon:'star' },
    { id:'bulk', label:'Bulk import', icon:'bulk' },
  ]},
  { group:'Insights', items:[
    { id:'embeddings', label:'Analytics', icon:'nodes' },
    { id:'sources', label:'Sources', icon:'circle' },
    { id:'decision-lab', label:'Decision Lab', icon:'gitcompare' },
  ]},
  { group:'System', items:[{ id:'settings', label:'Health & settings', icon:'gear' }] },
];
```

Do not rename route IDs, because links/tests and existing state rely on them.

- [ ] **Step 4: Implement semantic shell and active state**

Add skip link, nav label, `aria-current`, route-announcement live region, global-search label, and a top-bar title/description. Remove decorative duplicate status chrome from the fixed bottom bar; move concise health access into the shell.

- [ ] **Step 5: Implement responsive drawer behavior**

At 900px and below, make sidebar a modal drawer with `aria-modal`, focus containment, Escape close, backdrop close, route-change close, and focus return. Keep the bottom nav limited to Dashboard, Entries, Add, and More.

- [ ] **Step 6: Run tests**

Run the focused shell tests plus the existing hash-route test.

Expected: PASS; `#/settings` and every legacy route still render without a full reload.

- [ ] **Step 7: Review and commit**

After task review/artifact:

```bash
git add index-2.html ui/app.js ui/styles.css src/scripts/ui-browser.test.ts
git commit -m "feat(dashboard): rebuild application shell and navigation"
```

---

### Task 3: Replace Overview With The Actionable Dashboard Home

**Files:**
- Modify: `ui/app.js`
- Modify: `ui/styles.css`
- Modify: `src/scripts/ui-browser.test.ts`

**Interfaces:**
- Consumes: `E`, `agg`, and `HEALTH` already loaded by `loadAll()`.
- Produces: drill-down URLs with filters encoded in the existing hash/query convention.
- Produces no fabricated activity data.

- [ ] **Step 1: Add failing dashboard tests**

Assert health banner, four KPI cards, work queue, coverage gaps, recent entries/activity fallback, analytics link, and that clicking a KPI navigates to Entries with an appropriate filter.

```ts
it("drills from image coverage to filtered entries", async () => {
  const page = await browser!.newPage();
  await page.goto(baseUrl + "/#/overview");
  await page.getByRole("link", { name: /image coverage/i }).click();
  expect(page.url()).toContain("#/entries");
  expect(page.url()).toContain("image=");
  await page.close();
});
```

- [ ] **Step 2: Verify failure**

Run the dashboard-focused browser tests.

Expected: FAIL because the current Overview has static KPI cards and distributions but no dashboard queues/drill-down contract.

- [ ] **Step 3: Define verified dashboard selectors**

Derive:

- Entries, score/tier distribution, platform counts, image coverage from `agg`.
- Snapshot and embedding health from `HEALTH`.
- Draft count from `E.filter(x => x.reviewStatus === 'draft')`.
- Capture queue from `captureBatches` only after it is loaded; otherwise render an unavailable/loading state.
- Duplicate/failed-tag values only if existing APIs expose them; otherwise omit those cards.
- Recent activity as recent entries when no audited activity log exists; label it "Recent entries," not "Recent activity."

- [ ] **Step 4: Render the dashboard grid**

Replace the `page('overview', ...)` markup with semantic linked KPI cards, health banner, verified trend/distribution visualization, work queue, coverage gaps, and recent entries. Every card must have an accessible name and destination.

- [ ] **Step 5: Implement unavailable and partial states**

If `HEALTH` fails, show "Health data unavailable" with retry while rendering corpus metrics. If corpus entries fail, show the existing safe empty/loading state and do not display `0` as if it were verified.

- [ ] **Step 6: Run tests and inspect at target widths**

Run focused dashboard tests. Capture 1440×1000, 1024×768, 390×844 in both themes.

Expected: no clipped cards, no invented metrics, and first mobile viewport exposes health plus the most actionable KPIs.

- [ ] **Step 7: Review and commit**

After task review/artifact:

```bash
git add ui/app.js ui/styles.css src/scripts/ui-browser.test.ts
git commit -m "feat(dashboard): add actionable corpus overview"
```

---

### Task 4: Modernize Library Results And Accessible Master-Detail

**Files:**
- Modify: `ui/app.js`
- Modify: `ui/styles.css`
- Modify: `index-2.html`
- Modify: `src/scripts/ui-browser.test.ts`

**Interfaces:**
- Preserves: gallery/list toggle, filters, pagination, favorites, selection, bulk bar, rename, compare, edit, and image fallback.
- Produces: focus-safe detail drawer and URL/restoration state.

- [ ] **Step 1: Add failing preservation and accessibility tests**

Test gallery/list toggle, filter persistence, scroll retention, drawer `role="dialog"`, focus entry, Escape close, focus return, no hover-only buttons, and existing selection/bulk actions.

- [ ] **Step 2: Verify failure**

Run `npx vitest run src/scripts/ui-browser.test.ts -t "entry library"`.

Expected: accessibility/focus assertions fail against the current sticky detail rail.

- [ ] **Step 3: Restyle filters and result cards**

Use the shared neutral tokens, 44px mobile controls, visible selected states, concise card summaries, and authentic screenshots. Keep the delegated image-error fallback and current IDs/data attributes.

- [ ] **Step 4: Upgrade detail rail to an accessible drawer**

On open, set dialog semantics, label it from `#detailTitle`, remember the trigger, focus the close button, trap focus, close on Escape, restore trigger focus, and preserve results scroll. On mobile, use a full-height sheet; on desktop, retain resizable master-detail behavior.

- [ ] **Step 5: Preserve search/filter state in the hash**

Encode supported filters and view mode without changing the route ID. Parse them on entry and update with `history.replaceState` so Back returns to the same result state.

- [ ] **Step 6: Run old and new library tests**

Run the entire `specimen-ledger SPA` block and new entry-library tests.

Expected: existing selectors/actions pass; drawer focus and return-state tests pass.

- [ ] **Step 7: Review and commit**

After task review/artifact:

```bash
git add index-2.html ui/app.js ui/styles.css src/scripts/ui-browser.test.ts
git commit -m "feat(dashboard): modernize entry library and detail"
```

---

### Task 5: Apply The Dashboard System To Curation And Decision Lab

**Files:**
- Modify: `ui/app.js`
- Modify: `ui/styles.css`
- Modify: `src/scripts/ui-browser.test.ts`
- Reference: `docs/superpowers/plans/2026-07-10-decision-lab-ui-redesign.md`

**Interfaces:**
- Preserves all existing Add/capture/bulk/Decision Lab selectors and endpoint contracts.
- Adds consistent page headers, step states, inline validation, busy/error/success presentation.

- [ ] **Step 1: Add failing visual-contract tests**

For Add, Capture triage, Bulk import, Quality/Review queue, Sources, Settings, and Decision Lab, assert the shared `.module-header`, `.module-section`, `.state-banner`, and `.action-row` patterns while retaining their canonical existing form/button selectors.

- [ ] **Step 2: Add long-running-state tests**

Stub slow auto-fill/analyze requests and assert the triggering button is disabled, duplicate submission is blocked, elapsed/progress text is announced, and the user can recover after failure without losing inputs.

- [ ] **Step 3: Verify failure**

Run the focused new tests plus existing Add and bulk browser suites.

Expected: new shared-pattern assertions fail; existing workflows remain the behavioral baseline.

- [ ] **Step 4: Apply shared module composition**

Refactor the markup strings for every listed module to produce consistent headers, sections, fields, action rows, and state banners. Keep IDs, `name` attributes, data attributes, binder selectors, and endpoint calls unchanged.

- [ ] **Step 5: Complete Decision Lab presentation**

Use the already-written Decision Lab plan as a constrained reference for safe formatted reports and dashboard patterns, but reconcile it with the approved neutral themes and current code before implementation. Do not blindly apply stale line numbers or duplicate completed behavior.

- [ ] **Step 6: Run all curator browser tests**

Run:

```bash
npx vitest run src/scripts/ui-browser.test.ts
npx vitest run src/scripts/ui-server.test.ts src/decision-lab.test.ts src/decisions.test.ts
```

Expected: all existing workflows and new state assertions PASS.

- [ ] **Step 7: Review and commit**

After task review/artifact:

```bash
git add ui/app.js ui/styles.css src/scripts/ui-browser.test.ts
git commit -m "feat(dashboard): unify curation workflows"
```

---

### Task 6: Cross-Surface Accessibility, Responsive, And Regression Gates

**Files:**
- Modify: `src/scripts/ui-browser.test.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`
- Create: `docs/ux-qa-checklist.md`

**Interfaces:**
- Produces: a repeatable dashboard QA matrix and CI regression coverage.
- Consumes: public-plan build/test commands.

- [ ] **Step 1: Add the dashboard viewport/theme matrix**

Parameterize browser smoke coverage for Dashboard, Entries, Add, Capture, and Decision Lab across 1440×1000, 1024×768, and 390×844 in light and dark themes. Assert no horizontal overflow and no obscured primary action.

- [ ] **Step 2: Add keyboard and reduced-motion coverage**

Test skip link, sidebar navigation, mobile drawer, result filters, detail drawer, forms, dialogs, focus return, status announcements, and reduced-motion computed styles.

- [ ] **Step 3: Add automated accessibility scanning**

Add `@axe-core/playwright` at version `4.10.2`. Scan representative stable states on Dashboard, Entries, Add, Playground, and evidence detail. Configure only documented false-positive exclusions and explain each exclusion inline.

- [ ] **Step 4: Write the manual QA checklist**

Create `docs/ux-qa-checklist.md` covering both themes, keyboard-only flows, VoiceOver/NVDA smoke, 200% zoom, 320px layout, slow network, failed image, offline snapshot, failed mutation, long-running provider call, and destructive confirmation.

- [ ] **Step 5: Wire CI without duplicating browsers**

Keep the existing Chromium install. Run root tests, public site tests/build/browser/budget, and the combined accessibility matrix. Do not add a second browser installation step.

- [ ] **Step 6: Run the complete repository gate**

Run:

```bash
npm run build
npm run validate-corpus
npm test
npm run site:test
npm run site:build
npm run site:test:browser
node scripts/check-site-budget.mjs
```

Expected: all commands PASS; public and curator base routes load; required axe scans have zero violations; no target viewport has horizontal overflow.

- [ ] **Step 7: Review and commit**

After task review/artifact:

```bash
git add package.json package-lock.json src/scripts/ui-browser.test.ts .github/workflows/ci.yml README.md docs/ux-qa-checklist.md
git commit -m "test(ui): add cross-surface experience gates"
```

---

## Curator Plan Completion Gate

Run the full command set from Task 6, then manually verify:

1. Homepage → Playground → evidence detail → prompt copy.
2. Dashboard → filtered Entries → detail → return with state preserved.
3. Add/capture → auto-fill → review → save.
4. Decision Lab setup → comparison → report.
5. Theme selection persists across both applications.
6. `http://localhost:5173/clean-ui-mcp/` and direct Playground routes load without 404s.

Request a holistic review against both implementation plans and the approved design specification. Fix all Critical/Important findings, rerun the full gate, write the branch review artifact, and then use the finishing-a-development-branch skill for merge/push options.
