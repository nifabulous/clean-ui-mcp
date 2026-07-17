# Production Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the security, data-integrity, and test-integrity findings from the 2026-07-17 four-perspective project review so the MCP server and curator tooling are safe to run in production.

**Architecture:** All fixes are localized hardening of existing modules — no new subsystems. The curator HTTP server becomes loopback-only; orphan cleanup gains one shared, capture/decision/draft-aware inventory; the SSRF guard validates every redirect hop; the MCP server's corpus cache invalidates on mtime; decisions gain the same corrupt-file recovery corpus entries already have; all corpus writers route through the atomic persistence layer.

**Tech Stack:** TypeScript 5.9, Node 22, Vitest 4, Zod 4, Playwright (capture), existing `persistence.ts` durability layer.

**Relationship to the agent-readiness plan:** This plan is a parallel lane to `2026-07-14-agent-readiness-phase-0-1c-implementation-plan.md` (C1 rework R6–R7 continues on `feat/agent-readiness-phase-0-1c`). File overlap is nearly zero — this plan touches curator/scripts/SSRF/persistence modules; the readiness plan touches `src/tool-*`, `src/readiness/`, `src/server-factory.ts`. **Exception:** Task 4 here touches `src/corpus.ts`, which readiness Task 7 (Lane D, post-C1) also modifies. Land Task 4 before Lane D starts, or rebase Lane D on it.

**Branch:** `fix/production-hardening` off `origin/main` (374f720 or later).

## Global Constraints

- No task writes to `corpus/entries.json`, `corpus/decisions.json`, or real private screenshots. Tests use `setCorpusForTesting`, `setDecisionsPathsForTesting`, `setCorpusRootForTesting`, or tmp dirs.
- TDD: failing test first, then implementation, then commit.
- After every task: run its focused tests, run `npx vitest run`, request task review, write the `.zcode` task review artifact (the `prepare-commit-msg` hook blocks the next commit otherwise). Before push: holistic branch review + branch artifact.
- The curator server keeps working for a browser on the same machine at `http://localhost:PORT` — no curator workflow may regress.
- Flag-off / default behavior of the MCP server is unchanged except: stale-cache refresh (Task 4) and corrupt-file recovery (Task 5), both of which only change behavior in states that are currently bugs.
- Git hooks must be installed in the working clone before the first commit: `.zcode/scripts/install-git-hooks`.

---

### Task 1: Bind the curator server to loopback only

The curator server currently binds `"::"` (all interfaces, dual-stack) with no auth, and its `sameOrigin()` guard intentionally passes requests without an `Origin` header — so any LAN host can call mutating endpoints (`DELETE /api/orphans`, `POST /api/capture-url`). Binding loopback removes the entire remote surface in one change.

**Files:**
- Modify: `src/scripts/ui-server.ts:1569` (the `server.listen(PORT, "::", …)` call)
- Test: `src/scripts/ui-server.test.ts`

**Interfaces:**
- Consumes: the exported `createUiServer`/server bootstrap already under test in `ui-server.test.ts`.
- Produces: no API change; the listen host becomes `"127.0.0.1"` with a second listener attempt on `"::1"` documented as follow-up if dual-stack loopback is needed.

- [ ] **Step 1: Write the failing test**

Add to `src/scripts/ui-server.test.ts` (follow the existing pattern in that file for starting/stopping the server on an ephemeral port):

```ts
describe("listen address", () => {
  it("binds loopback only — never a routable interface", async () => {
    const { server } = await startTestServer(); // existing helper in this file; if absent, start via the same bootstrap main() uses with PORT=0
    const addr = server.address();
    expect(addr && typeof addr === "object").toBe(true);
    if (addr && typeof addr === "object") {
      expect(["127.0.0.1", "::1"]).toContain(addr.address);
    }
    await new Promise<void>((r) => server.close(() => r()));
  });
});
```

If `ui-server.test.ts` has no exported server-start helper, export the `http.Server` from the bootstrap (e.g. `export function startServer(port: number): Promise<http.Server>`) and call that. Do not spawn a child process.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/scripts/ui-server.test.ts -t "loopback"`
Expected: FAIL — `addr.address` is `"::"` .

- [ ] **Step 3: Change the bind address**

At `src/scripts/ui-server.ts:1569` replace:

```ts
server.listen(PORT, "::", () => {
```

with:

```ts
// SECURITY: loopback only. The curator app has no auth and several mutating
// endpoints; binding a routable interface would expose them to the LAN.
// "127.0.0.1" (not "localhost") so the OS resolver can't rebind it.
server.listen(PORT, "127.0.0.1", () => {
```

Update the startup log line just below (it prints the URL) to `http://127.0.0.1:${PORT}` if it currently prints `localhost`— browsers resolve `localhost` to `127.0.0.1` first, so the printed `localhost` URL still works; keep whichever is already printed but verify manually.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/scripts/ui-server.test.ts`
Expected: ALL PASS (the whole file, not just the new test — the origin-guard tests must still pass).

- [ ] **Step 5: Manual smoke — curator still reachable**

Run: `npm run ui` then open `http://localhost:3131` (or the configured PORT) in a browser. Expected: dashboard loads. Ctrl-C the server.

- [ ] **Step 6: Commit + task review artifact**

```bash
git add src/scripts/ui-server.ts src/scripts/ui-server.test.ts
git commit -m "fix(security): bind curator server to loopback only"
.zcode/scripts/write-review-artifact --type task --result approved --reviewer agent \
  --base-sha <parent-sha> --head-sha "$(git rev-parse HEAD)" --branch fix/production-hardening
```

---

### Task 2: One orphan inventory that cannot delete live data

Two orphan-deletion paths exist and both destroy live data:
- `DELETE /api/orphans` (ui-server.ts:1082-1087) treats anything not referenced by **corpus entries** as an orphan — Decision Lab screenshots (`images-private/decisions/…`, referenced by decisions.json) and un-triaged capture batches (`images-private/captures/{batchId}/…`) get `unlinkSync`'d.
- `clean-orphans.ts --confirm` protects decisions (lines 40-59) but still deletes capture batches and images referenced only by `corpus/entries-draft.json`.

Fix: one shared inventory in a new `src/orphans.ts`, used by both.

**Files:**
- Create: `src/orphans.ts`
- Create: `src/orphans.test.ts`
- Modify: `src/scripts/ui-server.ts:379-391` (`orphanedPrivateImagePaths`), `:1076-1088` (both /api/orphans handlers)
- Modify: `src/scripts/clean-orphans.ts:28-68` (`orphanInventory`)

**Interfaces:**
- Consumes: `listImageFilesRecursive(dir, prefix)` from `src/paths.ts:31`; `Decisions` schema from `src/schema.ts` (same import clean-orphans.ts uses today); `CorpusEntryT`.
- Produces: `export function safeOrphanPaths(opts: { entries: CorpusEntryT[]; privateFiles: string[]; decisionsRaw?: string | null; draftRaw?: string | null }): { orphans: string[]; protectedCounts: { entries: number; decisions: number; draft: number; captures: number } }` — pure, injectable, no disk I/O, so tests never touch real corpus.

- [ ] **Step 1: Write the failing tests**

`src/orphans.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { safeOrphanPaths } from "./orphans.js";
import type { CorpusEntryT } from "./schema.js";

const entry = (imagePath: string): CorpusEntryT =>
  ({ image: { path: imagePath } }) as unknown as CorpusEntryT; // only .image.path is read

describe("safeOrphanPaths", () => {
  it("never returns anything under images-private/captures/", () => {
    const { orphans } = safeOrphanPaths({
      entries: [],
      privateFiles: [
        "images-private/captures/batch-1/shot.png",
        "images-private/captures/batch-1/manifest.json",
        "images-private/loose-orphan.png",
      ],
    });
    expect(orphans).toEqual(["images-private/loose-orphan.png"]);
  });

  it("protects images referenced by decisions.json", () => {
    const decisionsRaw = JSON.stringify({
      version: 1,
      decisions: [{ id: "d1", title: "t", createdAt: "2026-07-17", directions: [{ name: "a", screens: [{ imageRef: "images-private/decisions/d1/screen.png" }] }] }],
    });
    const { orphans } = safeOrphanPaths({
      entries: [],
      privateFiles: ["images-private/decisions/d1/screen.png"],
      decisionsRaw,
    });
    expect(orphans).toEqual([]);
  });

  it("protects images referenced by entries-draft.json", () => {
    const draftRaw = JSON.stringify({
      version: 2,
      entries: [{ image: { path: "images-private/staged/draft-img.png" } }],
    });
    const { orphans } = safeOrphanPaths({
      entries: [],
      privateFiles: ["images-private/staged/draft-img.png"],
      draftRaw,
    });
    expect(orphans).toEqual([]);
  });

  it("with corrupt decisionsRaw, deletes nothing under images-private/decisions/", () => {
    const { orphans } = safeOrphanPaths({
      entries: [],
      privateFiles: ["images-private/decisions/d1/screen.png", "images-private/loose.png"],
      decisionsRaw: "{not json",
    });
    // Fail-closed: if we can't parse the manifest that references these files,
    // we must not treat its subtree as deletable.
    expect(orphans).toEqual(["images-private/loose.png"]);
  });

  it("still reports genuine orphans", () => {
    const { orphans } = safeOrphanPaths({
      entries: [entry("images-private/kept.png")],
      privateFiles: ["images-private/kept.png", "images-private/orphan.png"],
    });
    expect(orphans).toEqual(["images-private/orphan.png"]);
  });
});
```

Adjust the draft fixture shape to the real `entries-draft.json` shape — read one line of `src/scripts/review-draft.ts` or `commit-draft.ts` to confirm the top-level key (`entries` vs `drafts`) before writing the fixture, and match it.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/orphans.test.ts`
Expected: FAIL — module `./orphans.js` not found.

- [ ] **Step 3: Implement `src/orphans.ts`**

```ts
/**
 * orphans.ts — the single source of truth for "which private images are safe
 * to delete". Both the curator endpoint (DELETE /api/orphans) and the CLI
 * (clean-orphans.ts) MUST use this; a second inventory is how the 2026-07-17
 * review found live Decision Lab screenshots and un-triaged capture batches
 * being deleted as "orphans".
 *
 * Fail-closed rules:
 *  - images-private/captures/** is NEVER deletable (pending triage batches).
 *  - images-private/decisions/** is deletable only when decisions.json parsed
 *    successfully AND does not reference the file.
 *  - entries-draft.json references are protected the same way.
 */
import { type CorpusEntryT, Decisions } from "./schema.js";

export interface OrphanScan {
  orphans: string[];
  protectedCounts: { entries: number; decisions: number; draft: number; captures: number };
}

export function safeOrphanPaths(opts: {
  entries: CorpusEntryT[];
  privateFiles: string[];
  decisionsRaw?: string | null;
  draftRaw?: string | null;
}): OrphanScan {
  const referenced = new Set<string>();
  let entriesCount = 0;
  for (const e of opts.entries) {
    const p = e.image.path;
    if (p && p.startsWith("images-private/")) { referenced.add(p); entriesCount++; }
  }

  let decisionsCount = 0;
  let decisionsParsed = false;
  if (opts.decisionsRaw != null) {
    try {
      const parsed = Decisions.safeParse(JSON.parse(opts.decisionsRaw));
      if (parsed.success) {
        decisionsParsed = true;
        for (const d of parsed.data.decisions)
          for (const dir of d.directions)
            for (const s of dir.screens)
              if (s.imageRef?.startsWith("images-private/")) { referenced.add(s.imageRef); decisionsCount++; }
      }
    } catch { /* fall through to fail-closed below */ }
  }

  let draftCount = 0;
  let draftParsed = false;
  if (opts.draftRaw != null) {
    try {
      const parsed = JSON.parse(opts.draftRaw) as { entries?: Array<{ image?: { path?: string } }> };
      draftParsed = true;
      for (const e of parsed.entries ?? []) {
        const p = e.image?.path;
        if (p?.startsWith("images-private/")) { referenced.add(p); draftCount++; }
      }
    } catch { /* fail-closed below */ }
  }

  let capturesCount = 0;
  const orphans = opts.privateFiles
    .filter((p) => p.startsWith("images-private/"))
    .filter((p) => {
      if (p.startsWith("images-private/captures/")) { capturesCount++; return false; }
      // Fail-closed: a manifest we were given but could not parse protects its subtree.
      if (p.startsWith("images-private/decisions/") && opts.decisionsRaw != null && !decisionsParsed) return false;
      if (opts.draftRaw != null && !draftParsed) return false;
      return !referenced.has(p);
    })
    .sort();

  return { orphans, protectedCounts: { entries: entriesCount, decisions: decisionsCount, draft: draftCount, captures: capturesCount } };
}
```

Note: `Decisions` must be exported from `src/schema.ts` — clean-orphans.ts already imports it; reuse the same import path. If it lives elsewhere (check clean-orphans.ts line ~20 imports), import from there.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/orphans.test.ts`
Expected: PASS (all 5).

- [ ] **Step 5: Wire both callers**

In `src/scripts/ui-server.ts`: delete the body of `orphanedPrivateImagePaths` (keep the export for test compat, delegating) and change both handlers:

```ts
import { safeOrphanPaths } from "../orphans.js";
import { DECISIONS_PATH } from "…"; // same constant clean-orphans.ts uses; check its import
const DRAFT_PATH = resolve(CORPUS_ROOT, "entries-draft.json"); // match commit-draft.ts's constant

function scanOrphans(entries: CorpusEntryT[]) {
  return safeOrphanPaths({
    entries,
    privateFiles: listImageFilesRecursive(PRIVATE_IMAGE_DIR, "images-private/"),
    decisionsRaw: existsSync(DECISIONS_PATH) ? readFileSync(DECISIONS_PATH, "utf-8") : null,
    draftRaw: existsSync(DRAFT_PATH) ? readFileSync(DRAFT_PATH, "utf-8") : null,
  });
}
```

Both `GET /api/orphans` and `DELETE /api/orphans` call `scanOrphans(entries)` and use `.orphans`; the GET response additionally returns `protectedCounts` so the curator UI can show why files were excluded.

In `src/scripts/clean-orphans.ts`: replace the reference-collection portion of `orphanInventory()` (the entries set + decisions block + the final filter, lines ~28-68) with a call to `safeOrphanPaths`, passing the same raw strings. Keep its corpus-validation precondition and its reporting shape.

- [ ] **Step 6: Update existing ui-server orphan tests and run everything**

`ui-server.test.ts` has existing orphan tests (grep `orphan` in that file); update fixtures that previously expected captures/decisions files to be deletable — they now must expect protection.

Run: `npx vitest run src/orphans.test.ts src/scripts/ui-server.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit + task review artifact** (same commands as Task 1, message `fix(data): orphan cleanup can no longer delete capture batches, decision screenshots, or draft images`)

---

### Task 3: SSRF — validate every redirect hop and close range gaps

Three verified gaps in the capture-time SSRF guard:
1. `assertSafeCaptureTarget` validates only the initial URL; `page.goto` follows redirects unchecked (a public URL 302→`http://169.254.169.254/…` sails through).
2. The robots.txt fetch uses `redirect: "follow"` (capture.ts:333).
3. `isPrivateAddress` misses CGNAT `100.64.0.0/10`, `198.18.0.0/15`, `192.0.0.0/24`.

DNS-rebinding TOCTOU (guard resolves, Playwright re-resolves) is real but the full pin-the-IP fix is invasive with Playwright; per-hop re-validation closes the practical redirect vector now. Record rebinding as a known residual in the module comment.

**Files:**
- Modify: `src/ssrf.ts` (ranges + new `assertSafeRedirectChain` helper)
- Modify: `src/scripts/capture.ts:333` (robots fetch), plus both `page.goto` sites (~:835, :996) and `src/scripts/ui-server.ts:~734` capture path — wire a Playwright request-interception guard
- Test: `src/ssrf.test.ts`

**Interfaces:**
- Consumes: existing `isPrivateAddress(ip)`, `assertSafeCaptureTarget(url)` from `src/ssrf.ts`.
- Produces: `export async function assertSafeNavigationTarget(url: string): Promise<void>` (per-hop re-check, same throw contract as `assertSafeCaptureTarget`) and `export function installSsrfGuard(page: import("playwright").Page): Promise<void>` which rejects main-frame navigations to unsafe targets via `page.route`.

- [ ] **Step 1: Write failing tests**

Add to `src/ssrf.test.ts`:

```ts
describe("isPrivateAddress — extended ranges", () => {
  it.each([
    ["100.64.0.1", true],    // CGNAT 100.64.0.0/10
    ["100.127.255.254", true],
    ["100.128.0.1", false],  // just past /10
    ["198.18.0.1", true],    // benchmark 198.18.0.0/15
    ["198.19.255.254", true],
    ["198.20.0.1", false],
    ["192.0.0.1", true],     // IETF protocol assignments 192.0.0.0/24
  ])("%s → %s", (ip, expected) => {
    expect(isPrivateAddress(ip)).toBe(expected);
  });
});

describe("redirect hop validation", () => {
  it("rejects a redirect target resolving to metadata IP", async () => {
    await expect(assertSafeNavigationTarget("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/non-public|private/i);
  });
  it("accepts a public target", async () => {
    await expect(assertSafeNavigationTarget("https://example.com/")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/ssrf.test.ts -t "extended ranges"`
Expected: FAIL on the three new ranges; `assertSafeNavigationTarget` not exported.

- [ ] **Step 3: Implement**

In `src/ssrf.ts`, extend the IPv4 range checks inside `isPrivateAddress` (locate the existing CIDR checks at ~lines 26-55 and add, in the same style used there):

```ts
// CGNAT (RFC 6598): 100.64.0.0/10
if (a === 100 && b >= 64 && b <= 127) return true;
// Benchmarking (RFC 2544): 198.18.0.0/15
if (a === 198 && (b === 18 || b === 19)) return true;
// IETF protocol assignments: 192.0.0.0/24
if (a === 192 && b === 0 && c === 0) return true;
```

(Adapt variable names to the file's existing octet parsing.) Then:

```ts
/** Per-hop navigation check: same policy as assertSafeCaptureTarget, exported
 *  separately so the Playwright route guard and redirect handling share it. */
export async function assertSafeNavigationTarget(url: string): Promise<void> {
  await assertSafeCaptureTarget(url);
}

/**
 * Intercept every main-frame navigation (including server redirects) and
 * abort any hop whose target fails the SSRF policy. Closes the
 * public-URL-302-to-metadata bypass. KNOWN RESIDUAL: DNS rebinding between
 * our dns.lookup and Chromium's own resolution is not closed here.
 */
export async function installSsrfGuard(page: import("playwright").Page): Promise<void> {
  await page.route("**/*", async (route) => {
    const req = route.request();
    if (!req.isNavigationRequest() || req.frame() !== page.mainFrame()) return route.continue();
    try {
      await assertSafeNavigationTarget(req.url());
      return route.continue();
    } catch {
      return route.abort("blockedbyclient");
    }
  });
}
```

Wire it: in `src/scripts/capture.ts` immediately after each `const page = await …newPage()` preceding the goto sites (~835, ~996), and in the ui-server capture path (~734): `await installSsrfGuard(page);`. In `capture.ts:333` change the robots fetch to `redirect: "manual"`, and treat a 3xx by re-running `assertSafeNavigationTarget(location)` then fetching the new location once (max 3 hops, then treat as disallowed).

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/ssrf.test.ts`
Expected: PASS. Note `assertSafeNavigationTarget("https://example.com/")` does a real DNS lookup — mirror however the existing `assertSafeCaptureTarget` tests in this file handle that (they already test against example.com or stub `dns.lookup`; follow the existing pattern).

- [ ] **Step 5: Manual verification of a capture**

Run: `npm run capture -- --url https://example.com` (or the script's documented arg shape — check `capture.ts` usage block). Expected: capture completes; no SSRF throw on a normal page.

- [ ] **Step 6: Commit + task review artifact** (`fix(security): validate every navigation hop against SSRF policy; add missing non-public ranges`)

---

### Task 4: Corpus cache invalidation in the MCP server

`loadCorpus()` caches forever per process (corpus.ts:5,19-21), so a long-running MCP server never sees curator/CLI edits; meanwhile `loadIndex()` re-parses `embeddings.json` (1024-dim floats) on every query. One mtime-based policy for both.

**Files:**
- Modify: `src/corpus.ts:5-31`
- Modify: `src/embeddings.ts:142-146` (`loadIndex`)
- Test: `src/corpus.test.ts`

**Interfaces:**
- Consumes: `loadCorpusSafe()` from `src/persistence.ts:172`; `ENTRIES_PATH` from `src/persistence.ts:70`.
- Produces: unchanged public API (`loadCorpus`, `setCorpusForTesting`); behavior change only when entries.json mtime changes between calls.

- [ ] **Step 1: Write the failing test**

Add to `src/corpus.test.ts` (uses the existing tmp-corpus pattern from `persistence`-backed tests; if the file has no such pattern, use `setCorpusRootForTesting` from `src/persistence.ts:66` with a `mkdtempSync` dir):

```ts
describe("loadCorpus cache invalidation", () => {
  it("re-reads entries.json when its mtime changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "corpus-cache-"));
    setCorpusRootForTesting(dir);
    setCorpusForTesting(null); // clear cache
    try {
      writeFileSync(join(dir, "entries.json"), JSON.stringify({ version: 2, entries: [FIXTURE_ENTRY_A] }));
      expect(loadCorpus()).toHaveLength(1);
      // Simulate an external edit with a newer mtime.
      writeFileSync(join(dir, "entries.json"), JSON.stringify({ version: 2, entries: [FIXTURE_ENTRY_A, FIXTURE_ENTRY_B] }));
      utimesSync(join(dir, "entries.json"), new Date(), new Date(Date.now() + 5000));
      expect(loadCorpus()).toHaveLength(2);
    } finally {
      setCorpusRootForTesting(null);
      setCorpusForTesting(null);
    }
  });
});
```

Use two existing fixture entries from `src/__fixtures__/` (`corpus-fixtures.ts` exports them — check its exact export names and reuse).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/corpus.test.ts -t "cache invalidation"`
Expected: FAIL — second `loadCorpus()` returns 1 (stale cache).

- [ ] **Step 3: Implement mtime invalidation**

In `src/corpus.ts`:

```ts
import { statSync } from "node:fs";
import { loadCorpusSafe, ENTRIES_PATH } from "./persistence.js";

let cached: CorpusEntryT[] | null = null;
let cachedMtimeMs: number | null = null;
let testOverride = false;

function entriesMtimeMs(): number | null {
  try { return statSync(ENTRIES_PATH).mtimeMs; } catch { return null; }
}

export function loadCorpus(): CorpusEntryT[] {
  if (testOverride && cached) return cached;
  const mtime = entriesMtimeMs();
  if (cached && mtime !== null && mtime === cachedMtimeMs) return cached;
  cached = loadCorpusSafe().entries;
  cachedMtimeMs = mtime;
  return cached;
}

export function setCorpusForTesting(entries: CorpusEntryT[] | null): void {
  cached = entries;
  cachedMtimeMs = null;
  testOverride = entries !== null;
}
```

CAUTION: `ENTRIES_PATH` in persistence.ts is computed from `DEFAULT_CORPUS_ROOT` at module load, so `setCorpusRootForTesting` may not move it — check persistence.ts:66-71; if the test-root override redirects reads through a function rather than the constant, export and use that function (e.g. `entriesPath()`) instead of the constant. Match whatever `loadCorpusSafe` itself reads.

In `src/embeddings.ts` `loadIndex` (142-146), apply the same pattern: module-level `{ index, mtimeMs }` cache keyed on the index file's `statSync(...).mtimeMs`, re-parse only on change.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/corpus.test.ts src/embeddings.test.ts`
Expected: PASS — including all existing tests (the `testOverride` flag preserves `setCorpusForTesting` semantics: fixtures never get invalidated by disk mtimes).

- [ ] **Step 5: Commit + task review artifact** (`fix(server): corpus + embedding index caches invalidate on file mtime`)

---

### Task 5: Decisions corrupt-file recovery (stop persisting wipes)

`parseDecisions` returns `[]` on corrupt JSON (decisions.ts:69-76); the next `saveDecision` persists that wipe and `writeDecisionSnapshot` snapshots the wiped state. Mirror the corpus recovery: fall back to the newest valid snapshot, preserve the corrupt file, never overwrite evidence.

**Files:**
- Modify: `src/decisions.ts:68-113`
- Test: `src/decisions.test.ts`

**Interfaces:**
- Consumes: `writeAtomic` from `src/persistence.ts:208`; existing `setDecisionsPathsForTesting` seam (decisions.ts:37).
- Produces: `loadDecisionsSafe()` unchanged signature; new behavior — corrupt primary → newest parseable snapshot (or `[]` if none), and the corrupt primary is renamed `decisions.json.corrupt-<epoch>` before any subsequent persist.

- [ ] **Step 1: Write the failing tests**

Add to `src/decisions.test.ts` (this file already uses `setDecisionsPathsForTesting` with tmp dirs — follow its beforeEach/afterEach pattern):

```ts
describe("corrupt decisions.json recovery", () => {
  it("falls back to the newest valid snapshot instead of []", () => {
    // Arrange: valid snapshot, corrupt primary.
    const snapDir = join(tmpDir, ".snapshots");
    mkdirSync(snapDir, { recursive: true });
    writeFileSync(join(snapDir, "decisions-1000.json"), JSON.stringify({ version: 1, decisions: [FIXTURE_DECISION] }));
    writeFileSync(decisionsPath, "{corrupt");
    setDecisionsForTesting(null); // clear cache
    expect(loadDecisionsSafe()).toHaveLength(1);
  });

  it("preserves the corrupt primary as decisions.json.corrupt-<epoch>", () => {
    writeFileSync(decisionsPath, "{corrupt");
    setDecisionsForTesting(null);
    loadDecisionsSafe();
    const preserved = readdirSync(tmpDir).filter((f) => f.startsWith("decisions.json.corrupt-"));
    expect(preserved).toHaveLength(1);
    expect(readFileSync(join(tmpDir, preserved[0]), "utf-8")).toBe("{corrupt");
  });
});
```

Use the fixture decision shape the file's existing tests construct (grep `directions` in `decisions.test.ts` and reuse the same object).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/decisions.test.ts -t "corrupt"`
Expected: FAIL — returns `[]`, no preserved file.

- [ ] **Step 3: Implement**

In `src/decisions.ts` replace `loadDecisionsSafe` (and keep `parseDecisions` but make it return `null` on failure instead of `[]`):

```ts
function parseDecisions(raw: string): DecisionT[] | null {
  try {
    return Decisions.parse(JSON.parse(raw)).decisions;
  } catch {
    return null;
  }
}

function newestValidSnapshot(): DecisionT[] | null {
  try {
    const snaps = readdirSync(decisionSnapshotDir)
      .filter((f) => /^decisions-(\d+)\.json$/.test(f))
      .map((f) => ({ f, epoch: Number(f.match(/^decisions-(\d+)\.json$/)![1]) }))
      .sort((a, b) => b.epoch - a.epoch);
    for (const s of snaps) {
      const parsed = parseDecisions(readFileSync(resolve(decisionSnapshotDir, s.f), "utf-8"));
      if (parsed) return parsed;
    }
  } catch { /* no snapshot dir */ }
  return null;
}

export function loadDecisionsSafe(): DecisionT[] {
  if (cached) return cached;
  if (!existsSync(decisionsPath)) {
    cached = [];
    return cached;
  }
  const raw = readFileSync(decisionsPath, "utf-8");
  const parsed = parseDecisions(raw);
  if (parsed) {
    cached = parsed;
    return cached;
  }
  // Corrupt primary: preserve the evidence, then recover from snapshots.
  try { renameSync(decisionsPath, `${decisionsPath}.corrupt-${Date.now()}`); } catch { /* best-effort */ }
  cached = newestValidSnapshot() ?? [];
  return cached;
}
```

Add `renameSync` to the `node:fs` import. Note `writeDecisionSnapshot` currently snapshots the NEW state (persistDecisions calls it with the incoming array) — with the corrupt-primary rename in place this is now acceptable (evidence preserved), so leave persist ordering unchanged in this task.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/decisions.test.ts`
Expected: PASS (all — existing tests must not regress).

- [ ] **Step 5: Also fix the collision-prone decision ID (same file, 2 lines)**

`generateDecisionId` (decisions.ts:62-66) collides on same-title-same-millisecond and on the 25-day base36 wrap. Make uniqueness explicit:

```ts
function generateDecisionId(title: string, existing: ReadonlySet<string>): string {
  const slug = slugify(title);
  const stamp = Date.now().toString(36).slice(-6);
  let id = `${slug}-${stamp}`;
  for (let n = 2; existing.has(id); n++) id = `${slug}-${stamp}-${n}`;
  return id;
}
```

Update its caller in `createDecision` (decisions.ts:116+) to pass `new Set(loadDecisionsSafe().map((d) => d.id))`. Add a test: create two decisions with the same title back-to-back, assert distinct ids.

- [ ] **Step 6: Run full decisions suite, commit + task review artifact** (`fix(data): decisions.json corrupt-file recovery + collision-proof ids`)

---

### Task 6: Route all corpus writers through the atomic persistence layer

Five scripts write `entries.json` with plain `writeFileSync` (crash = torn file, and Task 5's corpus-side recovery then silently swaps in older data): `add-entry.ts:446`, `migrate-platform.ts:72`, `migrate-untitled-products.ts:137`, `migrate-layout-field.ts:130`, `migrate-v1-to-v2.ts:140`. `migrate-wcag-ids.ts:186-187` already does it right (`writeRawSnapshot` of the ORIGINAL bytes + `writeAtomic`) — copy that pattern.

**Files:**
- Modify: the five scripts above (each: 2-4 lines around the write site)
- Test: `src/scripts/migrate-v1-to-v2.test.ts` (exists) — add one assertion; other migrate scripts have no tests and get none in this task (they are one-shot, already-run tools; the write-path change is mechanical and identical).

**Interfaces:**
- Consumes: `writeRawSnapshot(content)` (persistence.ts:215), `writeAtomic(path, content)` (persistence.ts:208), `ENTRIES_PATH` (persistence.ts:70).

- [ ] **Step 1: Look at the reference implementation**

Read `src/scripts/migrate-wcag-ids.ts:180-190`. The pattern to replicate at each of the five write sites:

```ts
import { writeAtomic, writeRawSnapshot, ENTRIES_PATH } from "../persistence.js";
// BEFORE overwriting: snapshot the current on-disk bytes (the state we could
// need to roll back to), not the new array.
writeRawSnapshot(readFileSync(ENTRIES_PATH, "utf-8"));
writeAtomic(ENTRIES_PATH, JSON.stringify(payload, null, 2));
```

Replace each `writeFileSync(ENTRIES_PATH, …)` (or its local-constant equivalent — the migrate scripts may compute the path themselves; unify on `ENTRIES_PATH`) with this. Preserve each script's exact JSON payload/formatting. Delete any now-false "write atomically" comments (migrate-untitled-products.ts:137 has one).

- [ ] **Step 2: Add the regression assertion**

In `src/scripts/migrate-v1-to-v2.test.ts`, after the existing happy-path migration assertion, add: assert a snapshot file appeared in the test corpus's `.snapshots/` dir containing the PRE-migration bytes. (This test already runs the migration against a tmp corpus root — extend it, don't create a new harness.)

- [ ] **Step 3: Run**

Run: `npx vitest run src/scripts/migrate-v1-to-v2.test.ts`
Expected: PASS.

- [ ] **Step 4: Typecheck everything (the other four scripts have no tests)**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit + task review artifact** (`fix(data): all entries.json writers snapshot prior bytes + write atomically`)

---

### Task 7: Serialize curator mutations (kill the read-modify-write race)

Every mutating ui-server handler loads `entries`, `await`s (sharp dedup I/O, vision retag calls), then saves the whole array — concurrent requests lose each other's writes, and `uniqueEntryId` can mint duplicates against a stale snapshot (ui-server.ts:~851, :338-348).

**Files:**
- Modify: `src/scripts/ui-server.ts` (request dispatch for mutating routes)
- Test: `src/scripts/ui-server.test.ts`

**Interfaces:**
- Produces: `function serialized<T>(fn: () => Promise<T>): Promise<T>` — a module-level promise-chain mutex; all mutating handlers (POST/PUT/PATCH/DELETE under `/api/`) run through it. Read-only GETs stay concurrent.

- [ ] **Step 1: Write the failing test**

```ts
it("serializes concurrent mutating requests — no lost update", async () => {
  // Fire two entry-creating POSTs concurrently against the test server with
  // identical titles; both must succeed with DISTINCT ids, and the corpus
  // must contain both entries afterwards.
  const [r1, r2] = await Promise.all([postEntry(fixtureA), postEntry(fixtureA)]);
  expect(r1.id).not.toBe(r2.id);
  const list = await getEntries();
  expect(list.filter((e) => [r1.id, r2.id].includes(e.id))).toHaveLength(2);
});
```

Use the file's existing request helpers (it already tests POST /api/entries — reuse those helpers and fixtures). This test should fail intermittently-to-always under the current code because both handlers snapshot `entries` before either saves.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/scripts/ui-server.test.ts -t "serializes"`
Expected: FAIL (duplicate id or one entry missing).

- [ ] **Step 3: Implement the mutex**

Near the top of ui-server.ts:

```ts
// All corpus-mutating requests run one-at-a-time. Handlers follow a
// load → await (dedup/vision I/O) → save-whole-array pattern; two concurrent
// mutations therefore last-writer-wins without this. A promise chain is
// sufficient — this is a single-process, single-operator tool.
let mutationChain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = mutationChain.then(fn, fn);
  mutationChain = next.catch(() => undefined);
  return next;
}
```

In the main request dispatcher, wrap the handler invocation for any `/api/` route whose method is not GET/HEAD: `return serialized(() => handleX(...))`. CRITICAL: the entries snapshot must be loaded INSIDE the serialized function (i.e. inside each handler, which is already the case — verify no handler receives a pre-loaded `entries` from outside the wrapper; if the dispatcher pre-loads entries once and passes it in, move that load inside).

- [ ] **Step 4: Run the whole ui-server suite**

Run: `npx vitest run src/scripts/ui-server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit + task review artifact** (`fix(data): serialize curator mutations to prevent lost updates`)

---

### Task 8: Test isolation for images-private + un-fork copy-pasted test logic

Three test-integrity issues: (a) `ui-server.test.ts:434,489,549` and `dedup.test.ts:36` write/rmSync inside the REAL `corpus/images-private/`; (b) `ssrf.test.ts:163-176,283,357` tests hand-copied forks of private functions (`parseOpenAIResetHeader`, `groupMemberPasses`, `sectionHeightPasses`) — drift is invisible; (c) `corpus.test.ts:145-166` makes live Voyage API calls during default `npm test` when `VOYAGE_API_KEY` is set.

**Files:**
- Modify: `src/paths.ts` (add `setPrivateImageDirForTesting`)
- Modify: `src/scripts/ui-server.test.ts`, `src/dedup.test.ts` (use the seam)
- Modify: `src/tagger.ts` (export `parseOpenAIResetHeader`), `src/scripts/capture.ts` (export the two predicates), `src/ssrf.test.ts` (import instead of fork), `src/wiring-verification.test.ts` (allowlist the three exports as test-consumed)
- Modify: `src/corpus.test.ts` (gate live calls)

- [ ] **Step 1: Add the captures-root test seam**

`src/paths.ts` exports `PRIVATE_IMAGE_DIR` as a const (line 10) — consts can't be redirected. Convert internal consumers to a getter while keeping the const export for compatibility:

```ts
let privateImageDirOverride: string | null = null;
/** Test-only: redirect private-image writes to a tmp dir. */
export function setPrivateImageDirForTesting(dir: string | null): void {
  privateImageDirOverride = dir;
}
export function privateImageDir(): string {
  return privateImageDirOverride ?? PRIVATE_IMAGE_DIR;
}
```

Then in `ui-server.ts` and `dedup.ts`, replace direct `PRIVATE_IMAGE_DIR` uses with `privateImageDir()` (grep each file; mechanical). In `ui-server.test.ts` (the three batch/promote tests) and `dedup.test.ts:36`, add `beforeEach`: `setPrivateImageDirForTesting(mkdtempSync(join(tmpdir(), "img-")))`; `afterEach`: `setPrivateImageDirForTesting(null)` — and delete the `rmSync` cleanup of real corpus paths.

- [ ] **Step 2: Run those suites**

Run: `npx vitest run src/scripts/ui-server.test.ts src/dedup.test.ts`
Expected: PASS, and `git status corpus/` shows no touched files afterwards.

- [ ] **Step 3: Un-fork the copy-pasted functions**

Export `parseOpenAIResetHeader` from `src/tagger.ts:581` (add `export`), export `groupMemberPasses`/`sectionHeightPasses` from `src/scripts/capture.ts` (they exist as DETECT_SCRIPT predicate builders near the constants at :571-573 — export the real predicate functions the script embeds; if the predicates exist only as strings inside DETECT_SCRIPT, extract them to exported functions and template DETECT_SCRIPT from `fn.toString()`, the same technique the constants already use). In `ssrf.test.ts` delete the three local copies and import the real ones. Add all three to the wiring-verification allowlist ONLY if the scan flags them (they now have a test consumer but the scan requires production consumers — check the scan's rules at `wiring-verification.test.ts:32`; DETECT_SCRIPT templating IS a production consumer for the two predicates).

- [ ] **Step 4: Gate the live-API corpus tests**

In `src/corpus.test.ts:145-166` wrap the "real corpus contracts" describe:

```ts
const LIVE = process.env.RUN_LIVE_INTEGRATION === "1";
(LIVE ? describe : describe.skip)("real corpus contracts (live)", () => { … });
```

- [ ] **Step 5: Full suite, commit + task review artifact**

Run: `npx vitest run`
Expected: PASS; suite makes zero network calls without `RUN_LIVE_INTEGRATION=1`.
Commit: `test: isolate images-private writes, un-fork copied test logic, gate live API calls`

---

### Task 9: Wiring-verification allowlist tells the truth

The allowlist contains three provably false entries — `renderBriefTokens` (called at design-prompt.ts:227), `renderDecisionBrief` (decision-lab.ts:463), `pickDiverse` (recommend.ts:80) — and shields one genuine orphan, `selectReferences` (references/loader.ts:122, zero consumers anywhere).

**Files:**
- Modify: `src/wiring-verification.test.ts` (new invariant + prune 3 entries)
- Modify: `src/references/loader.ts` (delete `selectReferences` + its allowlist entry)

- [ ] **Step 1: Write the failing invariant**

Add to `wiring-verification.test.ts`:

```ts
it("allowlist entries are exclusively-unwired — a wired symbol may not hide there", () => {
  const wiredAllowlisted = [...ALLOWLIST].filter((symbol) => productionReferences(symbol).length > 0);
  expect(wiredAllowlisted).toEqual([]);
});
```

(`productionReferences` = whatever helper the existing scan uses to count non-test references; reuse it — check the file's internals and call the same function the main assertion uses.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/wiring-verification.test.ts`
Expected: FAIL listing `renderBriefTokens`, `renderDecisionBrief`, `pickDiverse`.

- [ ] **Step 3: Prune + delete the orphan**

Remove those three from ALLOWLIST. Delete `selectReferences` from `src/references/loader.ts:122` (and its allowlist entry, and its tests in `loader.test.ts` if any target it directly). Run `npx tsc --noEmit` to confirm nothing imported it.

- [ ] **Step 4: Run, commit + task review artifact**

Run: `npx vitest run src/wiring-verification.test.ts src/references/loader.test.ts`
Expected: PASS.
Commit: `test: allowlist must be exclusively-unwired; delete orphaned selectReferences`

---

### Task 10: Hygiene sweep

**Files:**
- Delete: `_ab_final.mjs`, `scripts/debug-minimax.mjs`, `scripts/debug-minimax2.mjs`, `scripts/debug-minimax3.mjs`, `scripts/debug-raw.mjs`, `scripts/debug-full-prompt.mjs`, `scripts/ab-eval.mjs`, `scripts/ab-eval-2.mjs`, `scripts/grok-eval.mjs` (verify each is unreferenced first: `grep -rn "<basename>" package.json docs/ README.md src/ scripts/`)
- Move: `mcp-call.mjs` → `scripts/mcp-call.mjs` (and remove the stderr suppression at its line 65 so server startup errors are visible)
- Modify: `package.json` (delete the broken `workflow` script; add a comment-equivalent by documenting `capture`/`capture-batch` aliasing in README)
- Modify: `README.md` (replace "420 tests across 28 files" with "run `npm test`"; add `scripts/mcp-call.mjs` to the dev-tools section)
- Modify: `src/scripts/doctor.ts` (warn when `.git/hooks/prepare-commit-msg` or `pre-push` is missing while `.zcode/git-hooks/` exists)

- [ ] **Step 1: Verify and delete debris** — run the grep per file; delete only unreferenced ones; any referenced file stays and gets a follow-up note in the commit body.

- [ ] **Step 2: Move mcp-call.mjs, fix stderr, test it**

Run: `node scripts/mcp-call.mjs search_ui_examples '{"query":"pricing"}'` (adapt to its documented argv shape — read its usage block). Expected: JSON tool result printed against `dist/server.js` (build first: `npm run build`).

- [ ] **Step 3: Doctor hook check**

In `src/scripts/doctor.ts`, add a check in the same style as its existing checks:

```ts
const hookSrc = resolve(PROJECT_ROOT, ".zcode/git-hooks");
const hookDst = resolve(PROJECT_ROOT, ".git/hooks/pre-push");
if (existsSync(hookSrc) && !existsSync(hookDst)) {
  warn("review-gate git hooks not installed — run .zcode/scripts/install-git-hooks");
}
```

(Use doctor's actual warn/report helper — read the file's existing check functions and match.)

- [ ] **Step 4: Full verification, commit + task review artifact**

Run: `npx vitest run && npx tsc --noEmit && npm run doctor`
Expected: green; doctor warns if hooks missing.
Commit: `chore: remove debris scripts, adopt mcp-call helper, doctor checks review hooks`

---

## Final verification (before push)

```bash
npm run build
npx vitest run
npx tsc --noEmit
npm run validate-corpus
npm run doctor
git status corpus/   # must be clean — proves test isolation held
```

Then: holistic branch review over `git merge-base origin/main HEAD..HEAD`, write the branch review artifact (`.zcode/scripts/write-review-artifact --type branch …`), push, open PR.

## Explicitly out of scope

- C1 rework R6–R7 and everything in the agent-readiness plan (Tasks 2–11, C2–C5) — continues on `feat/agent-readiness-phase-0-1c` under its own plan.
- DNS-rebinding IP pinning for Playwright navigation (recorded as known residual in Task 3).
- Prompt-injection neutralization of captured page copy in tagger prompts (security finding #6 — Minor; the human draft-review gate mitigates; revisit before any unattended auto-approve pipeline).
- dHash cache atomicity + rebuild queueing (Minor findings 10-12 of the data-integrity review) — batch into a later cleanup.
- Ranking-test depth (5+ graded entries) and dedup threshold boundary fixtures — worthwhile, not production-blocking.
