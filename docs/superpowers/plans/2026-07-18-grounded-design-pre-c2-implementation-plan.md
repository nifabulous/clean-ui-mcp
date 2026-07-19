# Grounded Design Workspace — Pre-C2 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove uncleared corpus material from the public site, establish typed live-site source-snapshot and crawl-policy contracts, and redefine C2 evaluation around safe, implementation-useful `DESIGN.md` decisions.

**Architecture:** This plan establishes contracts and safety boundaries without implementing the hosted generator. The public site becomes corpus-free and uses an empty synthetic snapshot until the later Playground plan replaces search with brief-to-`DESIGN.md`; new pure modules define `DesignSourceSnapshot`, deterministic `SOURCE-DESIGN.md`, representative route planning, cookie policy, and C2 evaluation fixtures. Existing Playwright capture, DOM-signal, SSRF, and robots code remains the execution substrate and is not duplicated here.

**Tech Stack:** TypeScript 5.9, Zod 4, Vitest 4, React/Vite site, Playwright capture contracts, Node.js ESM scripts.

## Global Constraints

- The private corpus, private screenshots, entry IDs, source identities learned from the corpus, image paths, critiques, and embeddings must never enter public static assets.
- `DesignSourceSnapshot` describes observed source behavior; `UiSpec`/`DESIGN.md` prescribes target behavior. Neither substitutes for the other.
- Initial website inspection is public, same-origin, bounded, unauthenticated, non-mutating, and provenance-complete.
- Raw pasted passwords, cookies, session tokens, and authorization headers are rejected.
- Essential first-party cookies may exist only inside one ephemeral capture context; third-party cookies are blocked.
- Project inspection cannot write to the global corpus. Curator Scout is a later plan and must use quarantine plus explicit maintainer acceptance.
- C2 evaluates evidence usefulness and safety. It does not implement the hosted generator or publish the corpus.
- Do not modify or ingest `src/GBP movement.xlsx` or the unrelated untracked plan files already present in the worktree.
- Do not bypass the repository review hook. Resolve the missing review artifact for the pre-existing branch HEAD before attempting commits.

## Program decomposition

This is plan 1 of the approved program. Later plans, each independently reviewed, are:

1. Hosted project/revision persistence, export, deletion, and retention.
2. Private retrieval aggregation, `UiSpec`, deterministic `DESIGN.md`, and publication gate.
3. Playground creation/revision experience and managed-credit execution.
4. Specification-aware critique and Decision Lab `DecisionRecord`/`DECISION.md` integration.
5. Maintainer-only Curator Scout, quarantine, opportunity queue, and contribution review.
6. Authenticated user-controlled capture, live drift monitoring, BYOK, framework adapters, and end-user suggestions.

---

### Task 1: Enforce the public static-asset boundary

**Files:**
- Create: `scripts/check-public-site-boundary.mjs`
- Create: `scripts/check-public-site-boundary.test.mjs`
- Modify: `package.json`
- Modify: `site/public/snapshot.json`
- Delete: `site/public/entries/**`
- Modify: `site/src/data/public-entry.test.ts`
- Modify: `site/src/pages/PlaygroundPage.test.tsx`
- Modify: `site/tests/site-browser.test.ts`

**Interfaces:**
- Consumes: tracked filesystem paths beneath `site/public/`.
- Produces: `checkPublicSiteBoundary(root): { ok: true }`; executable `npm run check-public-site-boundary`; a valid zero-entry synthetic snapshot.

- [ ] **Step 1: Write the failing boundary tests**

Create `scripts/check-public-site-boundary.test.mjs`:

```js
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkPublicSiteBoundary } from "./check-public-site-boundary.mjs";

const roots = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "clean-ui-public-boundary-"));
  roots.push(root);
  mkdirSync(join(root, "site/public"), { recursive: true });
  writeFileSync(join(root, "site/public/snapshot.json"), JSON.stringify({
    count: 0,
    generatedAt: "2026-07-18T00:00:00.000Z",
    categories: [],
    styleTags: [],
    entries: [],
  }));
  return root;
}

describe("public site disclosure boundary", () => {
  it("accepts a corpus-free synthetic snapshot", () => {
    expect(checkPublicSiteBoundary(fixture())).toEqual({ ok: true });
  });

  it("rejects public entry image directories", () => {
    const root = fixture();
    mkdirSync(join(root, "site/public/entries"));
    writeFileSync(join(root, "site/public/entries/private.png"), "private");
    expect(() => checkPublicSiteBoundary(root)).toThrow(/site\/public\/entries/);
  });

  it("rejects a non-empty browser-downloadable corpus snapshot", () => {
    const root = fixture();
    writeFileSync(join(root, "site/public/snapshot.json"), JSON.stringify({
      count: 1,
      generatedAt: "2026-07-18T00:00:00.000Z",
      categories: ["dashboard"],
      styleTags: ["minimal"],
      entries: [{ id: "private-entry", critique: "private critique" }],
    }));
    expect(() => checkPublicSiteBoundary(root)).toThrow(/entries must be empty/);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run scripts/check-public-site-boundary.test.mjs`

Expected: FAIL because `check-public-site-boundary.mjs` does not exist.

- [ ] **Step 3: Implement the boundary checker**

Create `scripts/check-public-site-boundary.mjs`:

```js
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function checkPublicSiteBoundary(root) {
  const publicRoot = resolve(root, "site/public");
  const entryRoot = resolve(publicRoot, "entries");
  if (existsSync(entryRoot) && readdirSync(entryRoot, { recursive: true }).length > 0) {
    throw new Error("site/public/entries must not contain corpus assets");
  }

  const snapshotPath = resolve(publicRoot, "snapshot.json");
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
  if (!Array.isArray(snapshot.entries) || snapshot.entries.length !== 0 || snapshot.count !== 0) {
    throw new Error("site/public/snapshot.json entries must be empty until a separately cleared collection exists");
  }
  return { ok: true };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  checkPublicSiteBoundary(process.cwd());
  process.stdout.write("public site boundary: PASS\n");
}
```

Add to root `package.json`:

```json
"check-public-site-boundary": "node scripts/check-public-site-boundary.mjs"
```

Prepend it to the root `build` script:

```json
"build": "npm run check-public-site-boundary && npm run generate-references && tsc"
```

- [ ] **Step 4: Remove the disclosed bundle and install the synthetic snapshot**

Run:

```bash
git rm -r site/public/entries
```

Replace `site/public/snapshot.json` with exactly:

```json
{
  "count": 0,
  "generatedAt": "2026-07-18T00:00:00.000Z",
  "categories": [],
  "styleTags": [],
  "entries": []
}
```

Do not copy, move, or retain the deleted images elsewhere under a tracked public path.

- [ ] **Step 5: Update public-site tests for the intentional empty state**

In `site/src/data/public-entry.test.ts`, add:

```ts
it("accepts the corpus-free synthetic snapshot", () => {
  expect(parsePublicSnapshot({
    count: 0,
    generatedAt: "2026-07-18T00:00:00.000Z",
    categories: [],
    styleTags: [],
    entries: [],
  }).entries).toEqual([]);
});
```

Replace tests in `site/src/pages/PlaygroundPage.test.tsx` and `site/tests/site-browser.test.ts` that require a real entry image/evidence route with assertions that the Playground renders its safe empty state and no request path starts with `/entries/`. Preserve loading, error, URL-state, accessibility, and responsive tests.

- [ ] **Step 6: Run the focused and build gates**

Run:

```bash
npx vitest run scripts/check-public-site-boundary.test.mjs site/src/data/public-entry.test.ts site/src/pages/PlaygroundPage.test.tsx
npm run check-public-site-boundary
npm --prefix site run build
npm run build
```

Expected: all tests pass; the checker prints `public site boundary: PASS`; no built asset contains `/entries/` or a corpus entry.

- [ ] **Step 7: Review and commit**

Review the complete task diff, write the required task-review artifact, then run:

```bash
git add package.json scripts/check-public-site-boundary.mjs scripts/check-public-site-boundary.test.mjs site/public/snapshot.json site/src/data/public-entry.test.ts site/src/pages/PlaygroundPage.test.tsx site/tests/site-browser.test.ts
git commit -m "fix(site): remove uncleared public corpus bundle"
```

---

### Task 2: Define source-snapshot contracts and deterministic rendering

**Files:**
- Create: `src/design-source/contracts.ts`
- Create: `src/design-source/contracts.test.ts`
- Create: `src/design-source/render.ts`
- Create: `src/design-source/render.test.ts`

**Interfaces:**
- Consumes: sanitized observations from later capture/adaptation code.
- Produces: `DesignSourceSnapshotSchema`, `DesignSourceSnapshot`, `renderSourceDesign(snapshot): string`.

- [ ] **Step 1: Write failing contract tests**

Create `src/design-source/contracts.test.ts` with one complete fixture and these assertions:

```ts
import { describe, expect, it } from "vitest";
import { DesignSourceSnapshotSchema } from "./contracts.js";

export const validSourceSnapshot = {
  schemaVersion: "1.0",
  artifactType: "design-source-snapshot",
  artifactId: "source_acme_001",
  projectId: "project_001",
  source: { kind: "user-supplied-public-reference", origin: "https://example.com", startingUrls: ["https://example.com/"] },
  capturedAt: "2026-07-18T00:00:00.000Z",
  crawl: { maxRoutes: 25, sameOrigin: true, authenticated: false, mutationAllowed: false },
  coverage: [{ url: "https://example.com/", status: "inspected", reason: "user-supplied", archetype: "landing-page", viewports: ["desktop", "mobile"] }],
  foundations: {
    colors: [{ id: "color.canvas", value: "#ffffff", role: "canvas", confidence: "high", evidenceIds: ["dom:home:color:0"] }],
    typography: [], spacing: [], radii: [], shadows: [], layout: [],
  },
  components: [],
  responsiveFindings: [],
  accessibility: [],
  motion: [],
  voice: [],
  evidence: [{ id: "dom:home:color:0", kind: "dom-signal", route: "https://example.com/", summary: "Computed body background", basis: "dom-grounded" }],
  limitations: [],
};

describe("DesignSourceSnapshotSchema", () => {
  it("accepts a provenance-complete public source snapshot", () => {
    expect(DesignSourceSnapshotSchema.parse(validSourceSnapshot)).toEqual(validSourceSnapshot);
  });

  it("rejects authenticated or mutating initial captures", () => {
    expect(() => DesignSourceSnapshotSchema.parse({ ...validSourceSnapshot, crawl: { ...validSourceSnapshot.crawl, authenticated: true } })).toThrow();
    expect(() => DesignSourceSnapshotSchema.parse({ ...validSourceSnapshot, crawl: { ...validSourceSnapshot.crawl, mutationAllowed: true } })).toThrow();
  });

  it("rejects findings whose evidence IDs do not resolve", () => {
    const broken = structuredClone(validSourceSnapshot);
    broken.foundations.colors[0].evidenceIds = ["missing"];
    expect(() => DesignSourceSnapshotSchema.parse(broken)).toThrow(/evidence/i);
  });
});
```

- [ ] **Step 2: Run the tests and verify failure**

Run: `npx vitest run src/design-source/contracts.test.ts`

Expected: FAIL because the contract module does not exist.

- [ ] **Step 3: Implement strict schemas**

Create `src/design-source/contracts.ts`. Use strict Zod objects and these exact discriminators:

```ts
import { z } from "zod";

const Url = z.string().url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol));
const Confidence = z.enum(["low", "medium", "high"]);
const EvidenceId = z.string().min(1);
const EvidenceRef = z.object({
  id: EvidenceId,
  kind: z.enum(["dom-signal", "screenshot-observation", "css-declaration", "machine-inference", "public-content"]),
  route: Url,
  summary: z.string().min(1),
  basis: z.enum(["visible", "dom-grounded", "declared", "inferred"]),
}).strict();
const Finding = z.object({ id: z.string().min(1), value: z.string().min(1), role: z.string().min(1), confidence: Confidence, evidenceIds: z.array(EvidenceId).min(1) }).strict();

export const DesignSourceSnapshotSchema = z.object({
  schemaVersion: z.literal("1.0"),
  artifactType: z.literal("design-source-snapshot"),
  artifactId: z.string().min(1),
  projectId: z.string().min(1),
  source: z.object({ kind: z.literal("user-supplied-public-reference"), origin: Url, startingUrls: z.array(Url).min(1) }).strict(),
  capturedAt: z.string().datetime(),
  crawl: z.object({ maxRoutes: z.number().int().min(1).max(30), sameOrigin: z.literal(true), authenticated: z.literal(false), mutationAllowed: z.literal(false) }).strict(),
  coverage: z.array(z.object({ url: Url, status: z.enum(["inspected", "skipped", "blocked", "duplicate", "failed"]), reason: z.string().min(1), archetype: z.string().min(1).nullable(), viewports: z.array(z.enum(["desktop", "tablet", "mobile"])) }).strict()).min(1),
  foundations: z.object({ colors: z.array(Finding), typography: z.array(Finding), spacing: z.array(Finding), radii: z.array(Finding), shadows: z.array(Finding), layout: z.array(Finding) }).strict(),
  components: z.array(Finding),
  responsiveFindings: z.array(Finding),
  accessibility: z.array(Finding),
  motion: z.array(Finding),
  voice: z.array(Finding),
  evidence: z.array(EvidenceRef),
  limitations: z.array(z.string().min(1)),
}).strict().superRefine((snapshot, ctx) => {
  const ids = new Set(snapshot.evidence.map((item) => item.id));
  const groups = [...Object.values(snapshot.foundations), snapshot.components, snapshot.responsiveFindings, snapshot.accessibility, snapshot.motion, snapshot.voice];
  for (const finding of groups.flat()) for (const id of finding.evidenceIds) if (!ids.has(id)) ctx.addIssue({ code: "custom", message: `unresolved evidence ID: ${id}` });
});

export type DesignSourceSnapshot = z.infer<typeof DesignSourceSnapshotSchema>;
```

- [ ] **Step 4: Write deterministic renderer tests**

Create `src/design-source/render.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { validSourceSnapshot } from "./contracts.test.js";
import { renderSourceDesign } from "./render.js";

describe("renderSourceDesign", () => {
  it("is byte-deterministic and distinguishes observation from prescription", () => {
    const first = renderSourceDesign(validSourceSnapshot);
    const second = renderSourceDesign(structuredClone(validSourceSnapshot));
    expect(first).toBe(second);
    expect(first).toContain("# SOURCE-DESIGN.md");
    expect(first).toContain("Observed source, not target design authority");
    expect(first).toContain("https://example.com/");
    expect(first).toContain("#ffffff");
  });
});
```

- [ ] **Step 5: Implement the renderer**

Create `src/design-source/render.ts` with a pure renderer that parses first, sorts findings by ID, and emits these sections in fixed order: Source, Coverage, Foundations, Components, Responsive Behavior, Accessibility, Declared Motion, Voice, Limitations, Evidence Index. Escape pipe characters and normalize newlines to `\n`. End with exactly one newline.

The heading and warning must be exactly:

```ts
const lines = [
  "# SOURCE-DESIGN.md",
  "",
  "> Observed source, not target design authority. A UiSpec must explicitly retain, adapt, or reject these observations.",
];
```

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
npx vitest run src/design-source/contracts.test.ts src/design-source/render.test.ts
npm run typecheck:contracts
```

Expected: all tests pass and typecheck is clean.

- [ ] **Step 7: Review and commit**

After task review approval:

```bash
git add src/design-source/contracts.ts src/design-source/contracts.test.ts src/design-source/render.ts src/design-source/render.test.ts
git commit -m "feat(design-source): define source snapshot artifact"
```

---

### Task 3: Build the bounded representative crawl planner

**Files:**
- Create: `src/design-source/crawl-policy.ts`
- Create: `src/design-source/crawl-policy.test.ts`
- Modify: `src/ssrf.ts`
- Modify: `src/ssrf.test.ts`

**Interfaces:**
- Consumes: user starting URL and discovered public links.
- Produces: `planRepresentativeCrawl(input): CrawlPlan`; reusable same-origin URL normalization.

- [ ] **Step 1: Write crawl-policy tests**

Cover these exact cases in `src/design-source/crawl-policy.test.ts`:

```ts
expect(planRepresentativeCrawl({ startUrl: "https://example.com/app", discoveredUrls: [
  "https://example.com/", "https://example.com/pricing?utm_source=x", "https://other.test/", "https://example.com/api/users", "https://example.com/logout",
] }).routes.map((route) => route.url)).toEqual(["https://example.com/app", "https://example.com/", "https://example.com/pricing"]);

expect(planRepresentativeCrawl({ startUrl: "https://example.com", discoveredUrls: Array.from({ length: 40 }, (_, index) => `https://example.com/page-${index}`) }).routes).toHaveLength(25);

expect(() => planRepresentativeCrawl({ startUrl: "https://example.com", discoveredUrls: [], cookie: "session=secret" })).toThrow(/raw credentials are not accepted/);
```

Also assert fragments and tracking parameters are stripped, same-origin is enforced, non-HTML extensions are excluded, destructive route names are blocked, duplicate canonical URLs collapse, the user-supplied route is first, and every skipped URL has a reason.

- [ ] **Step 2: Verify the tests fail**

Run: `npx vitest run src/design-source/crawl-policy.test.ts src/ssrf.test.ts`

Expected: FAIL because the crawl-policy module does not exist.

- [ ] **Step 3: Implement the pure planner**

Define:

```ts
export type CrawlPlanInput = {
  startUrl: string;
  discoveredUrls: readonly string[];
  maxRoutes?: number;
  includeUrls?: readonly string[];
  excludeUrls?: readonly string[];
  cookie?: string;
  authorization?: string;
  password?: string;
};

export type CrawlPlan = {
  origin: string;
  maxRoutes: number;
  routes: Array<{ url: string; reason: "user-supplied" | "discovered" | "user-included" }>;
  skipped: Array<{ url: string; reason: "cross-origin" | "non-html" | "destructive" | "excluded" | "duplicate" | "budget" }>;
};
```

`planRepresentativeCrawl` defaults to 25 and caps at 30. Deny paths matching `/(logout|signout|delete|remove|purchase|checkout|invite|admin)(\/|$)/i`, extensions matching `/\.(?:zip|pdf|png|jpe?g|gif|webp|svg|mp4|mp3|json|xml)$/i`, and `/api/` paths. Retain only same-origin `http`/`https` URLs. Remove fragments and query keys beginning `utm_` plus `gclid`, `fbclid`, and `ref`.

Any non-empty credential field throws `Raw credentials are not accepted; continue with public routes only`.

- [ ] **Step 4: Tighten hosted SSRF semantics without breaking local curator capture**

Keep the existing CLI/local-curator localhost allowance. Export a new `assertSafeHostedCaptureTarget(rawUrl)` from `src/ssrf.ts` that has no localhost bypass and always rejects private, loopback, link-local, CGNAT, benchmark, protocol-assignment, and metadata addresses. Add tests proving `assertSafeCaptureTarget("http://localhost:3000")` remains valid for local curator use while `assertSafeHostedCaptureTarget` rejects it.

- [ ] **Step 5: Run focused security tests**

Run:

```bash
npx vitest run src/design-source/crawl-policy.test.ts src/ssrf.test.ts
```

Expected: all canonicalization, credential rejection, destructive-path, budget, and hosted-SSRF tests pass.

- [ ] **Step 6: Review and commit**

After task review approval:

```bash
git add src/design-source/crawl-policy.ts src/design-source/crawl-policy.test.ts src/ssrf.ts src/ssrf.test.ts
git commit -m "feat(design-source): plan bounded public crawls"
```

---

### Task 4: Define ephemeral cookie and consent policy

**Files:**
- Create: `src/design-source/session-policy.ts`
- Create: `src/design-source/session-policy.test.ts`

**Interfaces:**
- Consumes: cookie metadata and normalized consent actions from a later browser adapter.
- Produces: `decideCookie(cookie): "allow-session-first-party" | "block"`; `chooseConsentAction(actions): ConsentDecision`.

- [ ] **Step 1: Write failing policy tests**

```ts
expect(decideCookie({ requestOrigin: "https://example.com", cookieDomain: "example.com", essential: true })).toBe("allow-session-first-party");
expect(decideCookie({ requestOrigin: "https://example.com", cookieDomain: "tracker.test", essential: false })).toBe("block");
expect(chooseConsentAction(["Accept all", "Reject non-essential", "Preferences"])).toEqual({ kind: "click", label: "Reject non-essential" });
expect(chooseConsentAction(["Accept all"])).toEqual({ kind: "stop", reason: "no safe rejection action" });
```

Also test case-insensitive variants (`Reject all`, `Necessary only`, `Decline optional`) and prove an ambiguous button such as `Continue` does not count as rejection.

- [ ] **Step 2: Verify failure**

Run: `npx vitest run src/design-source/session-policy.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the pure decisions**

`decideCookie` allows only explicitly essential cookies whose domain equals the request hostname or is its parent domain; everything else returns `block`. `chooseConsentAction` selects the first label matching `/^(reject (?:all|non-essential)|necessary only|decline optional)$/i`; without one it returns the typed stop decision. Do not implement browser clicking or cookie persistence in this task.

- [ ] **Step 4: Run tests and typecheck**

Run:

```bash
npx vitest run src/design-source/session-policy.test.ts
npm run typecheck:contracts
```

Expected: PASS.

- [ ] **Step 5: Review and commit**

After task review approval:

```bash
git add src/design-source/session-policy.ts src/design-source/session-policy.test.ts
git commit -m "feat(design-source): define ephemeral session policy"
```

---

### Task 5: Add C2 design-handoff gold contracts and deterministic scoring

**Files:**
- Create: `eval/design-handoff-labels.json`
- Create: `scripts/design-handoff-scorer.mjs`
- Create: `scripts/design-handoff-scorer.test.mjs`
- Create: `eval/design-handoff-fixtures/briefs.json`
- Modify: `package.json`

**Interfaces:**
- Consumes: sanitized candidate `UiSpec`-shaped evaluation output and human-authored gold labels.
- Produces: `scoreDesignHandoff(output, label)` and `npm run test:design-handoff-quality`.

- [ ] **Step 1: Write scorer tests before labels**

Create `scripts/design-handoff-scorer.test.mjs` with a valid output containing global direction, two screen blueprints, acceptance criteria, assumptions, authority lanes, source decisions, and no private identifiers. Assert a perfect result:

```js
expect(scoreDesignHandoff(validOutput, label)).toEqual({
  complete: true,
  requiredSectionCoverage: 1,
  requiredDecisionCoverage: 1,
  acceptanceCriterionCoverage: 1,
  unsupportedClaimCount: 0,
  forbiddenDisclosureCount: 0,
  unresolvedEvidenceCount: 0,
});
```

Add mutations proving the score fails for: missing screen state, missing mobile rule, absent acceptance criterion, unsupported source claim, private product/entry/path marker, unresolved evidence ID, source observation presented as target authority, and an inaccessible URL described as inspected.

- [ ] **Step 2: Verify the scorer test fails**

Run: `npx vitest run scripts/design-handoff-scorer.test.mjs`

Expected: FAIL because the scorer does not exist.

- [ ] **Step 3: Implement the deterministic scorer**

Create `scripts/design-handoff-scorer.mjs`. It must not call a model. Compute exact-set coverage from label arrays; validate evidence membership; scan serialized output against label-specific `forbiddenClaims` and `privateMarkers`; and require every source decision to use one of `retain`, `adapt`, or `reject` with a non-empty rationale.

Export:

```js
export function scoreDesignHandoff(output, label) {
  // Return the seven fields asserted in the tests. `complete` is true only
  // when all three coverage values are 1 and all four violation counts are 0.
}
```

- [ ] **Step 4: Add the stratified brief and label set**

`eval/design-handoff-fixtures/briefs.json` contains exactly 12 synthetic briefs: marketing, SaaS dashboard, fintech, mobile, onboarding, dense operations, sparse evidence, conflicting references, inaccessible URL, multi-page public site, cookie banner, and derivative named-reference request. Use fictitious product names and `example.com` URLs only.

`eval/design-handoff-labels.json` uses `labelVersion: 1`. Each label declares required sections, decisions, screen states, acceptance criteria, permitted authority lanes, forbidden claims, private markers, source coverage expectation, and whether motion may be DOM-grounded.

- [ ] **Step 5: Wire the offline gate**

Add:

```json
"test:design-handoff-quality": "vitest run scripts/design-handoff-scorer.test.mjs"
```

Do not add live provider calls or costs to the default test suite.

- [ ] **Step 6: Run the C2-focused gates**

Run:

```bash
npm run test:design-handoff-quality
npx vitest run scripts/critique-quality-scorer.test.mjs src/tool-contracts.test.ts
npm run typecheck:contracts
```

Expected: all deterministic gates pass.

- [ ] **Step 7: Review and commit**

After task review approval:

```bash
git add eval/design-handoff-labels.json eval/design-handoff-fixtures/briefs.json scripts/design-handoff-scorer.mjs scripts/design-handoff-scorer.test.mjs package.json
git commit -m "test(c2): define grounded design handoff gold gate"
```

---

### Task 6: Realign readiness authority and verify the pre-C2 boundary

**Files:**
- Modify: `docs/superpowers/specs/2026-07-13-agent-readiness-and-retagging-design.md`
- Modify: `docs/superpowers/plans/2026-07-14-agent-readiness-phase-0-1c-implementation-plan.md`
- Modify: `docs/AGENT_READINESS_STATUS.md`
- Modify: `quality-contracts/agent-readiness/checkpoint-approvals-v2.json` only if the append-only governance process requires a new checkpoint approval; never mutate existing approval objects.

**Interfaces:**
- Consumes: approved grounded-workspace spec and Tasks 1–5 verification evidence.
- Produces: explicit C2 scope/acceptance authority and a reviewed pre-C2 handoff.

- [ ] **Step 1: Amend C2 authority without silently changing C1**

Add an amendment section to the parent design and implementation plan that references `docs/superpowers/specs/2026-07-18-grounded-design-workspace-design.md` and states:

```markdown
C2 evaluates whether gold evidence supports safe, coherent, implementation-ready UiSpec decisions and live-source migration decisions. C2 does not implement hosted synthesis, persist customer projects, publish the private corpus, or permit project inspection to ingest corpus entries. Existing C1 tool-contract bytes remain historical authority; any executable contract change follows the repository checkpoint process rather than editing prior approvals.
```

- [ ] **Step 2: Update readiness status truthfully**

Keep C2 open. Record Tasks 1–5 as pre-C2 foundations with their exact commit SHAs and test results. Record the hosted generator, Playground conversion, Decision Lab integration, Curator Scout, authenticated capture, BYOK, and framework adapters as future plans, not completed work.

- [ ] **Step 3: Run the complete verification matrix**

Run:

```bash
npm run check-public-site-boundary
npm run test:design-handoff-quality
npm test
npm run typecheck:contracts
npm run build
npm --prefix site test
npm --prefix site run build
npm run validate-readiness-artifacts -- --mode public
git diff --check origin/main...HEAD
```

Expected:

- no public corpus static assets;
- all tests, typechecks, and builds pass;
- readiness validation has no malformed-state issues;
- C0 and C1 remain closed;
- C2 remains open pending gold execution and approval.

- [ ] **Step 4: Perform adversarial manual checks**

Verify:

```bash
test ! -d site/public/entries
node -e 'const s=require("./site/public/snapshot.json"); if(s.count!==0||s.entries.length!==0) process.exit(1)'
if rg -n 'images-private|private-entry|actorRegistrySha256' site/public site/dist; then exit 1; fi
```

Inspect the production site bundle network manifest and confirm no request can retrieve corpus entries, images, critiques, or source identities.

- [ ] **Step 5: Review the complete pre-C2 increment**

Run the project-standard holistic review over `origin/main...HEAD`, including requirements traceability, privacy, security, contract compatibility, tests, status truthfulness, and scope containment. Resolve all P0/P1 findings and rerun affected gates.

- [ ] **Step 6: Commit the authority/status update**

After review approval:

```bash
git add docs/superpowers/specs/2026-07-13-agent-readiness-and-retagging-design.md docs/superpowers/plans/2026-07-14-agent-readiness-phase-0-1c-implementation-plan.md docs/AGENT_READINESS_STATUS.md
git commit -m "docs(readiness): align C2 with grounded design handoffs"
```

Do not modify `checkpoint-approvals-v2.json` unless a separately reviewed append-only approval operation is explicitly authorized.

## Final acceptance

The pre-C2 foundation is complete only when:

- `site/public/entries/` is absent and the tracked site snapshot contains zero corpus entries;
- the public boundary checker runs in the root build;
- `DesignSourceSnapshot` and `SOURCE-DESIGN.md` are strict, provenance-complete, and deterministic;
- representative crawl planning rejects credentials, cross-origin routes, destructive paths, and unbounded scope;
- hosted SSRF rules reject localhost/private addresses while local curator capture retains its explicit developer allowance;
- cookie and consent decisions are deterministic and session-only;
- the 12-case design-handoff gold contract and scorer pass offline;
- C0/C1 remain closed and C2 remains truthfully open; and
- the complete increment has an approved holistic review artifact.
