# Public Product Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconstruct the missing public React/Vite source and ship a modern, accessible homepage, Playground, and evidence-detail experience under `/clean-ui-mcp/`.

**Architecture:** Add a tracked React/Vite application under `site/` while keeping dependencies and scripts in the repository root. The app reads only the tracked publication-safe `site/public/snapshot.json`, uses a focused adapter/search layer, and shares its design-token contract with the curator plan through `docs/design-system.md` and matching CSS custom-property names.

**Tech Stack:** React 19, React Router 7, Vite 7, TypeScript 5.9, MiniSearch 7, Vitest 4, Testing Library, Playwright, CSS custom properties.

## Global Constraints

- Public users may only access publication-approved snapshot data.
- Public code must never call curator mutation APIs.
- Vite development and production must both work at `/clean-ui-mcp/`.
- Initial JavaScript must remain under 150KB gzip, excluding the lazily loaded Playground route.
- LCP must remain below 2.5 seconds and CLS below 0.1 on the agreed mobile profile.
- WCAG 2.2 AA is the minimum accessibility target.
- Light mode uses a pale cool architectural canvas with original layout-region linework.
- Dark mode uses true neutral charcoal surfaces with no navy, violet, green, or neon base tint.
- Authentic corpus screenshots are never recolored.
- Do not add fabricated customers, adoption claims, testimonials, or metrics.
- Run a focused code review and write the required `.zcode` task review artifact after every task; run a holistic branch review before push.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `package.json` / `package-lock.json` | Root scripts and public-app dependencies. | Modify |
| `site/index.html` | Public document shell, metadata, and pre-paint theme bootstrap. | Create |
| `site/vite.config.ts` | `/clean-ui-mcp/` base, build, and test configuration. | Create |
| `site/tsconfig.json` | Browser TypeScript configuration. | Create |
| `site/public/snapshot.json` | Tracked publication-safe build input copied from the current compiled artifact. | Create |
| `site/public/entries/*` | Publication-safe screenshot assets referenced by the tracked snapshot. | Create |
| `site/public/robots.txt` | Search-engine policy. | Create |
| `site/public/sitemap.xml` | Public route discovery. | Create |
| `site/src/main.tsx` | React entry point and router mount. | Create |
| `site/src/app/App.tsx` | Route definitions and lazy route boundaries. | Create |
| `site/src/app/SiteShell.tsx` | Global navigation, footer, mobile menu, and skip link. | Create |
| `site/src/theme/theme.ts` | Theme resolution, persistence, and DOM application. | Create |
| `site/src/data/public-entry.ts` | Public snapshot types and narrow adapter. | Create |
| `site/src/data/load-snapshot.ts` | Snapshot loading and validation. | Create |
| `site/src/search/search.ts` | Search index, filters, stable ranking, and URL serialization. | Create |
| `site/src/components/*` | Buttons, copy action, product preview, evidence cards, filters, image fallback, and states. | Create |
| `site/src/pages/HomePage.tsx` | Proof-led homepage. | Create |
| `site/src/pages/PlaygroundPage.tsx` | Search and results experience. | Create |
| `site/src/pages/EvidencePage.tsx` | Evidence detail and preserved return state. | Create |
| `site/src/pages/InstallPage.tsx` | Install command and MCP client guidance. | Create |
| `site/src/styles/*.css` | Tokens, global rules, layout, components, responsive rules, and motion. | Create |
| `site/src/**/*.test.ts(x)` | Unit and component tests. | Create |
| `site/tests/site-browser.test.ts` | Public end-to-end and accessibility smoke tests. | Create |
| `scripts/check-site-budget.mjs` | Gzip bundle budget enforcement. | Create |
| `.github/workflows/ci.yml` | Public build, browser, routing, and budget checks. | Modify |
| `docs/design-system.md` | Cross-application token and interaction contract. | Create |

---

### Task 1: Reconstruct The Tracked Vite Application

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `site/index.html`
- Create: `site/vite.config.ts`
- Create: `site/tsconfig.json`
- Create: `site/src/main.tsx`
- Create: `site/src/app/App.tsx`
- Create: `site/src/pages/NotFoundPage.tsx`
- Create: `site/src/styles/tokens.css`
- Create: `site/src/styles/global.css`
- Create: `site/src/app/App.test.tsx`

**Interfaces:**
- Produces: `npm run site:dev`, `npm run site:build`, `npm run site:test`.
- Produces: Browser routes rooted at `/clean-ui-mcp/`.
- Consumes: No curator API.

- [ ] **Step 1: Add a failing router/base-path test**

Create `site/src/app/App.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppRoutes } from "./App";

describe("public routes", () => {
  it("renders the homepage at the application root", () => {
    render(<MemoryRouter initialEntries={["/"]}><AppRoutes /></MemoryRouter>);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/design judgment/i);
  });

  it("renders a useful not-found state", () => {
    render(<MemoryRouter initialEntries={["/missing"]}><AppRoutes /></MemoryRouter>);
    expect(screen.getByRole("heading", { name: /page not found/i })).toBeVisible();
  });
});
```

- [ ] **Step 2: Run the test and verify the missing app fails**

Run:

```bash
npx vitest run --config site/vite.config.ts site/src/app/App.test.tsx
```

Expected: FAIL because `site/vite.config.ts` and the React source do not exist.

- [ ] **Step 3: Add root dependencies and scripts**

Add these scripts to `package.json`:

```json
"site:dev": "vite --config site/vite.config.ts",
"site:build": "vite build --config site/vite.config.ts",
"site:preview": "vite preview --config site/vite.config.ts",
"site:test": "vitest run --config site/vite.config.ts",
"site:test:browser": "vitest run site/tests/site-browser.test.ts"
```

Add runtime dependencies at the installed version floors:

```json
"minisearch": "^7.2.0",
"react": "^19.2.7",
"react-dom": "^19.2.7",
"react-router-dom": "^7.18.1"
```

Add development dependencies:

```json
"@testing-library/jest-dom": "^6.9.1",
"@testing-library/react": "^16.3.2",
"@testing-library/user-event": "^14.6.1",
"@types/react": "^19.2.14",
"@types/react-dom": "^19.2.3",
"@vitejs/plugin-react": "^5.1.4",
"jsdom": "^28.0.0",
"vite": "^7.3.6"
```

Run `npm install` to update `package-lock.json` from these exact declarations.

- [ ] **Step 4: Preserve the current publication-safe artifact before the first build**

The first Vite build empties `site/dist`, so preserve its current public inputs first:

```bash
mkdir -p site/public/entries
cp site/dist/snapshot.json site/public/snapshot.json
cp -R site/dist/entries/. site/public/entries/
```

Verify every non-empty `imagePath` in `site/public/snapshot.json` resolves to a regular file under `site/public/entries/`, and fail if a path is absolute, contains `..`, or starts with `images-private/`. The copied artifact is the existing deployed public dataset; do not copy `corpus/entries.json` or `corpus/images-private/`.

- [ ] **Step 5: Add Vite and TypeScript configuration**

Create `site/vite.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  base: "/clean-ui-mcp/",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, sourcemap: true },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: true,
  },
});
```

Create `site/tsconfig.json` with `target: ES2022`, `jsx: react-jsx`, `moduleResolution: Bundler`, `strict: true`, `noEmit: true`, and include `src`, `tests`, and `vite.config.ts`.

- [ ] **Step 6: Add the document shell and pre-paint theme bootstrap**

Create `site/index.html` with canonical metadata and this inline bootstrap before styles/scripts:

```html
<script>
  (() => {
    const saved = localStorage.getItem("clean-ui-theme");
    const theme = saved === "light" || saved === "dark"
      ? saved
      : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
  })();
</script>
```

Mount the app at `<div id="root"></div>` and load `/src/main.tsx` as a module. Use a canonical URL under `/clean-ui-mcp/`; do not retain the old Plausible script as a core dependency.

- [ ] **Step 7: Add the minimal application and neutral tokens**

Create `main.tsx` with `BrowserRouter basename="/clean-ui-mcp"`. Export `AppRoutes` from `App.tsx` so tests can mount routes without a second router. Register Home and Not Found in this task; Task 5 adds the lazy Playground and Evidence routes when their real modules exist.

In `tokens.css`, define the shared names:

```css
:root {
  --canvas: #f3f6fb;
  --surface: #ffffff;
  --surface-raised: #f8fafc;
  --ink: #0b2348;
  --ink-muted: #637089;
  --border: #dbe3ef;
  --focus: #2457d6;
  --success: #287a4d;
  --warning: #986515;
  --danger: #b33a2b;
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 16px;
}

:root[data-theme="dark"] {
  --canvas: #111113;
  --surface: #19191c;
  --surface-raised: #222226;
  --ink: #f4f4f5;
  --ink-muted: #a1a1aa;
  --border: #34343a;
  --focus: #a8c7ff;
  --success: #78a887;
  --warning: #d2a455;
  --danger: #e17a6b;
}
```

- [ ] **Step 8: Run tests and build**

Run:

```bash
npm run site:test -- site/src/app/App.test.tsx
npm run site:build
```

Expected: tests PASS; build creates `site/dist/index.html` whose asset URLs start with `/clean-ui-mcp/`.

- [ ] **Step 9: Review and commit**

Run the required task review, write its approved `.zcode` artifact, then:

```bash
git add package.json package-lock.json site/index.html site/vite.config.ts site/tsconfig.json site/public site/src
git commit -m "feat(site): reconstruct tracked public application"
```

---

### Task 2: Publication-Safe Snapshot Adapter And Search

**Files:**
- Create: `site/src/data/public-entry.ts`
- Create: `site/src/data/load-snapshot.ts`
- Create: `site/src/data/load-snapshot.test.ts`
- Create: `site/src/search/search.ts`
- Create: `site/src/search/search.test.ts`

**Interfaces:**
- Produces: `loadPublicSnapshot(): Promise<PublicSnapshot>`.
- Produces: `createSearch(entries): SearchController`.
- Produces: `parseSearchState(searchParams)` and `serializeSearchState(state)`.
- Consumes: `site/public/snapshot.json`; never `corpus/entries.json`.

- [ ] **Step 1: Write failing snapshot tests**

Test that valid snapshot rows adapt to the public shape, malformed rows are rejected, and image paths never accept `..`, absolute URLs, or `images-private/`.

```ts
it("rejects private image paths", () => {
  expect(() => parsePublicSnapshot({ count: 1, entries: [{ ...fixture, imagePath: "images-private/x.png" }] }))
    .toThrow(/safe public image path/i);
});
```

- [ ] **Step 2: Write failing search tests**

Cover text relevance, category/style/domain/platform filters, stable ID tie-breaking, and URL round trips:

```ts
it("round-trips shareable filters", () => {
  const state = { query: "pricing", categories: ["pricing"], styles: ["minimal"], domains: [], platform: "web" };
  expect(parseSearchState(serializeSearchState(state))).toEqual(state);
});
```

- [ ] **Step 3: Verify both focused suites fail**

Run `npm run site:test -- site/src/data/load-snapshot.test.ts site/src/search/search.test.ts`.

Expected: FAIL because the adapter and search controller do not exist.

- [ ] **Step 4: Verify the preserved public artifact**

Verify `site/public/snapshot.json` contains `count`, `generatedAt`, filter lists, and `entries`; verify `count === entries.length`; and verify every referenced screenshot exists under `site/public/entries/`. The parser accepts only safe relative public filenames (for example `sample-5.png`) and rejects absolute paths, `..`, URL schemes, and `images-private/`.

- [ ] **Step 5: Implement the narrow public types and parser**

Define `PublicEntry`, `PublicSnapshot`, and `SnapshotLoadState`. Validate required strings/arrays/numbers with explicit predicates and map `imagePath` to `${import.meta.env.BASE_URL}entries/${encodeURIComponent(imagePath)}` only after safe-path validation.

- [ ] **Step 6: Implement deterministic search**

Use MiniSearch over `title`, `productName`, `critique`, `steal`, `avoid`, `patternType`, `categories`, and `styleTags`. Apply exact filters after text scoring. Sort equal scores by `id.localeCompare` so URLs and screenshots remain deterministic.

- [ ] **Step 7: Run focused tests**

Run:

```bash
npm run site:test -- site/src/data/load-snapshot.test.ts site/src/search/search.test.ts
```

Expected: PASS with private paths rejected and URL round trips exact.

- [ ] **Step 8: Review and commit**

After task review/artifact:

```bash
git add site/public/snapshot.json site/public/entries site/src/data site/src/search
git commit -m "feat(site): add publication-safe corpus search"
```

---

### Task 3: Shared Theme Contract And Accessible Site Shell

**Files:**
- Create: `docs/design-system.md`
- Create: `site/src/theme/theme.ts`
- Create: `site/src/theme/theme.test.ts`
- Create: `site/src/app/SiteShell.tsx`
- Create: `site/src/app/SiteShell.test.tsx`
- Create: `site/src/components/ThemeToggle.tsx`
- Create: `site/src/styles/shell.css`
- Modify: `site/src/app/App.tsx`

**Interfaces:**
- Produces: `resolveTheme(saved, prefersDark): "light" | "dark"`.
- Produces: `setTheme(theme)` and `getTheme()` using key `clean-ui-theme`.
- Produces: global shell landmarks and mobile-menu focus management.

- [ ] **Step 1: Write failing theme and shell tests**

Test system fallback, explicit persistence, skip-link target, navigation names, menu escape handling, and focus return to the menu trigger.

- [ ] **Step 2: Verify failure**

Run `npm run site:test -- site/src/theme/theme.test.ts site/src/app/SiteShell.test.tsx`.

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Document the cross-app contract**

In `docs/design-system.md`, record the exact light/dark token values from Task 1, font stack, spacing scale `4/8/12/16/24/32/48/64`, radius scale, focus ring `0 0 0 3px color-mix(in srgb, var(--focus) 35%, transparent)`, 44px mobile target, motion durations `150ms/250ms`, and semantic-state rules.

- [ ] **Step 4: Implement theme helpers**

Keep theme logic pure except for `setTheme`. Subscribe to OS changes only while no explicit local choice exists. Set `document.documentElement.dataset.theme` and update the toggle's accessible name.

- [ ] **Step 5: Implement the site shell**

Add `<a className="skip-link" href="#main-content">Skip to content</a>`, semantic header/nav/main/footer landmarks, active-link state, mobile disclosure button with `aria-expanded`, Escape close, route-change close, and focus return.

- [ ] **Step 6: Run tests and keyboard smoke**

Run focused tests, then start `npm run site:dev` and use Playwright to tab through skip link, nav, theme control, and mobile menu at 390px.

Expected: no focus trap; focus remains visible in both themes.

- [ ] **Step 7: Review and commit**

After task review/artifact:

```bash
git add docs/design-system.md site/src/theme site/src/app site/src/components/ThemeToggle.tsx site/src/styles/shell.css
git commit -m "feat(site): add shared theme and accessible shell"
```

---

### Task 4: Build The Proof-Led Homepage And Install Flow

**Files:**
- Create: `site/src/pages/HomePage.tsx`
- Create: `site/src/pages/HomePage.test.tsx`
- Create: `site/src/pages/InstallPage.tsx`
- Create: `site/src/components/ArchitecturalBackdrop.tsx`
- Create: `site/src/components/ProductPreview.tsx`
- Create: `site/src/components/CopyAction.tsx`
- Create: `site/src/components/CopyAction.test.tsx`
- Create: `site/src/styles/home.css`
- Create: `site/src/styles/install.css`
- Modify: `site/src/app/App.tsx`

**Interfaces:**
- Consumes: snapshot counts and representative public entries.
- Produces: primary `/`, secondary `/install`, and clipboard fallback behavior.

- [ ] **Step 1: Write failing homepage contract tests**

Assert one H1, Playground and install actions above the product preview, metric values from the snapshot fixture, evidence-model sections, no customer-logo strip, and backdrop marked `aria-hidden="true"`.

- [ ] **Step 2: Write failing clipboard tests**

Test successful clipboard confirmation and fallback selection when `navigator.clipboard` rejects.

- [ ] **Step 3: Verify failure**

Run `npm run site:test -- site/src/pages/HomePage.test.tsx site/src/components/CopyAction.test.tsx`.

- [ ] **Step 4: Implement the homepage in single-message sections**

Use this order: hero/product preview, evidence-model differentiators, agent connection, two audience use cases, open-source/reliability proof, FAQ, final CTA. Derive counts from snapshot data; use repository version metadata passed through a build constant rather than hard-coded adoption claims.

- [ ] **Step 5: Implement original architectural background**

Build background geometry from CSS/SVG layout-region forms. Hide it from assistive technology, disable pointer events, reduce opacity at 900px, and remove large flank objects below 640px. Do not import Cowrywise assets.

- [ ] **Step 6: Implement install guidance**

Show the canonical npm command and MCP configuration example with copy actions. Link to README/Docs for client-specific details rather than duplicating volatile instructions.

- [ ] **Step 7: Run tests and responsive visual check**

Run focused tests and capture homepage at 1440×1000 and 390×844 in both themes.

Expected: no text overlaps geometry, no horizontal scroll, and the two primary actions remain visible.

- [ ] **Step 8: Review and commit**

After task review/artifact:

```bash
git add site/src/pages site/src/components site/src/styles site/src/app/App.tsx
git commit -m "feat(site): build proof-led homepage and install flow"
```

---

### Task 5: Build Playground And Evidence Detail

**Files:**
- Create: `site/src/pages/PlaygroundPage.tsx`
- Create: `site/src/pages/PlaygroundPage.test.tsx`
- Create: `site/src/pages/EvidencePage.tsx`
- Create: `site/src/pages/EvidencePage.test.tsx`
- Create: `site/src/components/SearchFilters.tsx`
- Create: `site/src/components/EvidenceCard.tsx`
- Create: `site/src/components/EvidenceImage.tsx`
- Create: `site/src/components/AsyncState.tsx`
- Create: `site/src/styles/playground.css`
- Create: `site/src/styles/evidence.css`
- Modify: `site/src/app/App.tsx`

**Interfaces:**
- Consumes: `SearchController`, `PublicSnapshot`, canonical search state.
- Produces: lazy `/playground` and `/evidence/:entryId` routes.

- [ ] **Step 1: Write failing Playground tests**

Test initial results, debounced query, combined filters, removable-filter empty state, result count announcement, canonical URL replacement, and preserved state when opening/closing detail.

- [ ] **Step 2: Write failing evidence tests**

Test decision/steal/avoid/provenance sections, unknown-entry not found, safe image fallback, and agent-prompt copy content.

- [ ] **Step 3: Verify failure**

Run the two focused test files and expect missing-module failures.

- [ ] **Step 4: Implement scannable results**

Each card shows screenshot/fallback, title/product, pattern, platform, tier/score, and one critique excerpt. Full critique text must not render in the results grid. Use native form controls with visible labels.

- [ ] **Step 5: Implement error and empty states**

`AsyncState` supports `loading`, `error`, `empty`, and `ready`. Failed snapshot load offers retry. Empty search lists active filters with remove buttons and three deterministic related-query suggestions.

- [ ] **Step 6: Implement evidence detail and return state**

Use the entry ID route, preserve the originating `location.search`, and return to `/playground?<same params>`. Render structured headings for Decision, Evidence, Steal, Avoid, Accessibility, and Provenance. Use intrinsic image dimensions where available and a wireframe fallback otherwise.

- [ ] **Step 7: Run focused and full public tests**

Run:

```bash
npm run site:test
npm run site:build
```

Expected: PASS; Playground is emitted as a separate lazy chunk.

- [ ] **Step 8: Review and commit**

After task review/artifact:

```bash
git add site/src/pages site/src/components site/src/styles site/src/app/App.tsx
git commit -m "feat(site): add playground and evidence detail"
```

---

### Task 6: Deployment, Accessibility, And Performance Gates

**Files:**
- Create: `site/tests/site-browser.test.ts`
- Create: `site/public/robots.txt`
- Create: `site/public/sitemap.xml`
- Create: `scripts/check-site-budget.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`

**Interfaces:**
- Produces: reproducible `site:build`, base-path browser checks, bundle budget gate.

- [ ] **Step 1: Add failing base-path browser tests**

Start a built-site preview and assert `/clean-ui-mcp/`, `/clean-ui-mcp/playground`, and an evidence route return the app, all requested scripts/styles return 200, and snapshot/image requests contain no 404s.

- [ ] **Step 2: Add accessibility journey assertions**

In the same suite cover keyboard navigation, skip link, mobile menu focus return, result-count live region, theme persistence, reduced motion, and no horizontal overflow at 320px.

- [ ] **Step 3: Add the gzip budget script**

Implement `scripts/check-site-budget.mjs` to read `site/dist/.vite/manifest.json`, collect non-dynamic entry JavaScript, gzip each file with `gzipSync`, sum bytes, print the total, and exit non-zero above `150 * 1024`.

- [ ] **Step 4: Add build metadata and discovery files**

Create static `robots.txt` and sitemap entries for `/clean-ui-mcp/`, `/playground`, and `/install`. Do not enumerate evidence routes until the build generates them from the public snapshot.

- [ ] **Step 5: Wire CI**

After the existing root tests, add:

```yaml
- run: npm run site:test
- run: npm run site:build
- run: npm run site:test:browser
- run: node scripts/check-site-budget.mjs
```

- [ ] **Step 6: Document local development and deployment**

Update README with `npm run site:dev`, the required `http://localhost:5173/clean-ui-mcp/` URL, public snapshot provenance, build/preview commands, and the rule that `site/dist` is generated and ignored.

- [ ] **Step 7: Run the complete public gate**

Run:

```bash
npm run site:test
npm run site:build
npm run site:test:browser
node scripts/check-site-budget.mjs
```

Expected: all tests PASS; every base-path asset returns 200; initial gzip total is at or below 153600 bytes.

- [ ] **Step 8: Review and commit**

After task review/artifact:

```bash
git add site/tests site/public/robots.txt site/public/sitemap.xml scripts/check-site-budget.mjs .github/workflows/ci.yml README.md
git commit -m "test(site): enforce deployment and quality gates"
```

---

## Public Plan Completion Gate

Run:

```bash
npm run site:test
npm run site:build
npm run site:test:browser
node scripts/check-site-budget.mjs
npm test
```

Expected: all public and existing repository tests pass. Then request a holistic review against `docs/superpowers/specs/2026-07-18-unified-product-experience-redesign-design.md`, fix all Critical/Important findings, write the branch review artifact, and only then begin the curator-dashboard plan.
