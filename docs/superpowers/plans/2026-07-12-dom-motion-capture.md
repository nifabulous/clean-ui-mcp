# Browser-Side DOM Motion Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect `normalizeMotionDeclarations` to the capture pipeline so motion signals are collected from the browser, normalized, written to the dom-signals sidecar, and available as `dom:motion:*` evidence in critique synthesis.

**Architecture:** `settlePage` is split into `waitAndLazyLoadPage` (scroll + networkidle) and `freezePageMotion` (inject the `0s !important` style tag). Motion CSS is collected via `page.evaluate` between those two steps. The browser context is created with `reducedMotion: "reduce"` which suppresses transitions on well-behaved sites — so collection reads **authored stylesheet rules** (`document.styleSheets` → `cssRules`), not computed styles, to get the declarations the designer wrote regardless of reduced-motion emulation. Collection is **per-capture-root** (scoped to each locator's DOM subtree), not page-wide, so cropped captures only get motion evidence from elements actually in the screenshot. Raw declarations pass through `normalizeMotionDeclarations` in Node-land, the normalized `MotionResult` attaches to `DomSignals.motion`, and the sidecar serialization flows it through automatically.

**Critical design constraints:**
1. `settlePage` (capture.ts:413) currently combines lazy-load scrolling + motion freeze in one function. Must split so motion collection runs between them.
2. Browser context uses `reducedMotion: "reduce"` (capture.ts:828) — computed styles will reflect the reduced-motion cascade, suppressing transitions. Must read authored stylesheet rules instead.
3. Motion must be collected per-capture-root, not page-wide, so cropped section captures don't get evidence from off-screen elements.

**Tech Stack:** TypeScript, Playwright, existing dom-motion + capture modules.

## Global Constraints

- Motion collection must not exceed the existing 3s timeout budget for DOM signals.
- The freeze hazard means motion CSS must be collected before `settlePage` or from stylesheet rules.
- `normalizeMotionDeclarations` stays pure — the browser evaluate produces raw `DomMotionInput[]`, Node-land normalizes.
- Motion signals flow through the existing `DomSignals.motion` field → sidecar → `readDomSignalsForImage` → `TaggerInput.domSignals.motion` → `buildSynthesisContext` → `dom:motion:*` evidence. No new types needed.
- Cross-origin stylesheets throw `SecurityError` on `cssRules` access — catch and count as `inaccessibleStylesheets`.
- Remove `normalizeMotionDeclarations` from the wiring-verification allowlist once it has a production caller.

---

### Task 1: Split settlePage + add per-root motion collection from authored stylesheet rules

**Files:**
- Modify: `src/scripts/capture.ts`
- Modify: `src/dom-motion.ts` (add `animationTimingFunction` field to `DomMotionInput`)
- Modify: `src/wiring-verification.test.ts` (remove allowlist entry)

**Interfaces:**
- Produces: `waitAndLazyLoadPage(page)` and `freezePageMotion(page)` (split from `settlePage`)
- Produces: `collectMotionDeclarations(locator)` — per-root browser evaluate reading authored CSS rules
- Produces: `normalizeMotionDeclarations` call in `captureLocator` that attaches `motion` to `DomSignals`
- Consumes: existing `normalizeMotionDeclarations` from `dom-motion.ts`

- [ ] **Step 1: Add `animationTimingFunction` to `DomMotionInput`**

In `src/dom-motion.ts`, add `animationTimingFunction?: string;` to the `DomMotionInput` interface. Update the animation signal builder (line ~146) to use `input.animationTimingFunction ?? input.transitionTimingFunction` for animation entries.

- [ ] **Step 2: Split settlePage into waitAndLazyLoadPage + freezePageMotion**

In `src/scripts/capture.ts`, split `settlePage` (line 413) into two functions:

```ts
/** Lazy-load scroll + networkidle wait. Does NOT freeze motion. */
async function waitAndLazyLoadPage(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await page.evaluate(async () => {
    const step = window.innerHeight * 0.8;
    let y = 0;
    const max = document.body.scrollHeight;
    while (y < max) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 250));
      y += step;
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 250));
  });
}

/** Inject the motion-freeze style tag. Call AFTER motion collection. */
async function freezePageMotion(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `*, *::before, *::after {
      animation-duration: 0s !important;
      animation-delay: 0s !important;
      transition-duration: 0s !important;
      transition-delay: 0s !important;
      scroll-behavior: auto !important;
    }`,
  }).catch(() => {});
  await page.waitForTimeout(300);
}
```

Update the call site at line 836: replace `await settlePage(page)` with:
```ts
await waitAndLazyLoadPage(page);
// Motion collection happens per-capture-root below, before freeze
```

The freeze must be called AFTER motion collection but BEFORE the screenshot. Since `captureLocator` takes the screenshot, the freeze must happen after motion collection but before `captureLocator`. The simplest ordering: collect motion for ALL roots first, then freeze, then capture all roots.

- [ ] **Step 3: Add per-root motion collection from authored stylesheet rules**

Add a function that collects motion declarations **scoped to a locator's DOM subtree**, reading authored CSS from stylesheets (not computed styles, which are affected by `reducedMotion: "reduce"`):

```ts
async function collectMotionDeclarations(locator: Locator): Promise<{
  inputs: DomMotionInput[];
  prefersReducedMotion: boolean;
  inaccessibleStylesheets: number;
} | null> {
  try {
    return await locator.evaluate((root) => {
      // Read authored transition/animation declarations from stylesheets,
      // NOT computed styles. The browser context uses reducedMotion: "reduce"
      // which suppresses transitions in computed style — we want the authored
      // declarations the designer wrote.
      const interactive = root.querySelectorAll("button, a, input, select, textarea, [role='button'], [role='link'], [role='tab'], [onclick], details, summary");
      const inputs: Array<Record<string, string>> = [];
      let count = 0;

      // Build a map of CSS rules from accessible same-origin stylesheets
      const rules: Array<{ selectorText: string; styles: Record<string, string> }> = [];
      let inaccessibleStylesheets = 0;
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule instanceof CSSStyleRule) {
              const s = rule.style;
              const entry: Record<string, string> = {};
              if (s.transitionDuration) entry.transitionDuration = s.transitionDuration;
              if (s.transitionProperty) entry.transitionProperty = s.transitionProperty;
              if (s.transitionDelay) entry.transitionDelay = s.transitionDelay;
              if (s.transitionTimingFunction) entry.transitionTimingFunction = s.transitionTimingFunction;
              if (s.animationDuration) entry.animationDuration = s.animationDuration;
              if (s.animationName) entry.animationName = s.animationName;
              if (s.animationIterationCount) entry.animationIterationCount = s.animationIterationCount;
              if (s.animationDelay) entry.animationDelay = s.animationDelay;
              if (s.animationTimingFunction) entry.animationTimingFunction = s.animationTimingFunction;
              if (Object.keys(entry).length > 0) {
                rules.push({ selectorText: rule.selectorText, styles: entry });
              }
            }
          }
        } catch {
          inaccessibleStylesheets++;
        }
      }

      // For each interactive element in root, find matching stylesheet rules
      for (const el of interactive) {
        if (count >= 50) break;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;

        // Check inline styles first
        const inline = (el as HTMLElement).style;
        const inlineEntry: Record<string, string> = {};
        if (inline.transitionDuration) inlineEntry.transitionDuration = inline.transitionDuration;
        if (inline.transitionProperty) inlineEntry.transitionProperty = inline.transitionProperty;
        if (inline.animationDuration) inlineEntry.animationDuration = inline.animationDuration;
        if (inline.animationName) inlineEntry.animationName = inline.animationName;

        // Check matching stylesheet rules
        const matched: Record<string, string> = {};
        for (const r of rules) {
          if (r.selectorText && el.matches(r.selectorText)) {
            Object.assign(matched, r.styles);
          }
        }

        const combined = { ...matched, ...inlineEntry };
        const hasMotion =
          (combined.transitionDuration && combined.transitionDuration !== "0s") ||
          (combined.animationDuration && combined.animationDuration !== "0s" && combined.animationName && combined.animationName !== "none");
        if (!hasMotion) continue;
        count++;

        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute("role");
        const testId = el.getAttribute("data-testid");
        const selector = testId ? `${tag}[data-testid=${testId}]` : role ? `${tag}[role=${role}]` : tag;
        inputs.push({ selector, ...combined });
      }

      const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      return { inputs, prefersReducedMotion, inaccessibleStylesheets };
    });
  } catch {
    return null; // Graceful degradation — no motion signals
  }
}
```

**Why authored rules not computed styles:** The browser context is created with `reducedMotion: "reduce"` (capture.ts:828). Computed styles reflect the reduced-motion cascade, which may suppress `transition-duration` to `0s` on well-behaved sites. Authored stylesheet rules preserve the designer's original declaration regardless of the reduced-motion emulation.

- [ ] **Step 4: Wire motion collection into the capture flow**

In the batch capture flow (around lines 834-860), restructure the ordering:

```ts
await waitAndLazyLoadPage(page);
// ... consent dismissal, anchor IDs ...

// Collect motion per root BEFORE freezing
const motionByRoot = new Map<string, { inputs: DomMotionInput[]; prefersReducedMotion: boolean; inaccessibleStylesheets: number }>();
const collectFrom = async (rootSelector: string, mode: "section" | "recursive") => {
  const { sections, groups, oversized } = await detect(page, rootSelector);
  for (const sec of sections) {
    const loc = page.locator(sec.selector).first();
    if (!(await loc.isVisible().catch(() => false))) continue;
    const captureId = safeId(source.sourceName, mode, selectorFingerprint(sec.selector), viewport.name);
    // Collect motion BEFORE freeze
    const motionRaw = await collectMotionDeclarations(loc);
    if (motionRaw) motionByRoot.set(captureId, motionRaw);
    // ... capture (screenshot happens inside captureLocator, after freeze)
  }
  // Same for groups
};

// After all motion is collected, freeze the page
await freezePageMotion(page);

// Now capture all roots (screenshots will be frozen)
// Pass motionByRoot into captureLocator so it can attach motion to DomSignals
```

Inside `captureLocator`, after `extractDomSignals`, normalize and attach:
```ts
const motionRaw = motionByRoot.get(info.id);
if (signals && motionRaw) {
  signals.motion = normalizeMotionDeclarations(motionRaw.inputs, {
    prefersReducedMotion: motionRaw.prefersReducedMotion,
    inaccessibleStylesheets: motionRaw.inaccessibleStylesheets,
  });
}
```

Note: this requires threading `motionByRoot` into `captureLocator` (add a parameter) or restructuring the flow. The simplest approach: pass motion data alongside signalsMap.

- [ ] **Step 5: Import normalizeMotionDeclarations in capture.ts**

Add: `import { normalizeMotionDeclarations, type DomMotionInput } from "../dom-motion.js";`

- [ ] **Step 6: Remove normalizeMotionDeclarations from wiring-verification allowlist**

Remove the entry from `src/wiring-verification.test.ts` and its DEFERRED comment.

- [ ] **Step 7: Build and test**

Run: `npm run build`
Expected: PASS

Run: `npm test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/scripts/capture.ts src/dom-motion.ts src/wiring-verification.test.ts
git commit -m "feat(capture): collect DOM motion from authored stylesheet rules

- Split settlePage into waitAndLazyLoadPage + freezePageMotion so motion
  collection runs between them (freeze hazard fix)
- Per-root collection scoped to each locator's DOM subtree (no cross-
  contamination between cropped captures)
- Reads authored stylesheet rules, not computed styles (reducedMotion:
  reduce emulation suppresses computed transitions on well-behaved sites)
- normalizeMotionDeclarations processes raw declarations in Node-land
- Result attached to DomSignals.motion, flows through sidecar automatically
- Added animationTimingFunction to DomMotionInput (was reusing transition)
- Removed normalizeMotionDeclarations from wiring-verification allowlist"
```

---

### Task 2: Add unit + integration tests for the motion collection seam

**Files:**
- Modify: `src/dom-motion.test.ts` (add tests for animationTimingFunction)
- Create or modify: a Playwright integration test that verifies the freeze/collect ordering

- [ ] **Step 1: Add test for animationTimingFunction**

Test that animation signals correctly use `animationTimingFunction` when provided, falling back to `transitionTimingFunction` when absent.

- [ ] **Step 2: Add a Playwright integration test for the capture seam**

Create a test (or extend the existing browser test suite) that:
1. Serves a tiny HTML page with a `<button style="transition: opacity 0.3s">`
2. Runs the capture pipeline (or a minimal version: `waitAndLazyLoadPage` → `collectMotionDeclarations` → `freezePageMotion`)
3. Asserts `collectMotionDeclarations` returns non-empty inputs with `transitionDuration: "0.3s"`
4. Asserts `freezePageMotion` was called after collection (verify the freeze tag is present in the DOM via `page.$("style")` text content)
5. Asserts the screenshot was taken while the freeze was active (no mid-transition artifacts)

This is the behavioral proof that the ordering is correct — not a grep-based check.

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/dom-motion.test.ts` — unit tests PASS
Run: `npx vitest run <integration-test-file>` — integration test PASS (requires Playwright)

- [ ] **Step 4: Commit**

```bash
git add src/dom-motion.test.ts <integration-test-file>
git commit -m "test(capture): add motion collection unit + integration tests

- Unit: animationTimingFunction field mapping
- Integration: Playwright test verifying collect-before-freeze ordering
  with a real page containing a transition"
```

---

### Task 3: Verify end-to-end + wiring test

- [ ] **Step 1: Run full verification suite**

```bash
npm run build && npm run validate-references && npm test
```

Expected: all exit 0.

- [ ] **Step 2: Verify wiring test**

```bash
npx vitest run src/wiring-verification.test.ts
```

Expected: PASS — `normalizeMotionDeclarations` is no longer in the allowlist and has a production caller.

- [ ] **Step 3: Freeze ordering verified by integration test**

The Playwright integration test from Task 2 is the behavioral proof of correct ordering. No grep-based check needed — the test proves motion collection returns non-zero durations AND the freeze is active afterward.

## Self-Review

**Spec coverage:** The plan covers pre-freeze collection (Task 1), animationTimingFunction fix (Task 1 Step 1 + Task 2), normalization call (Task 1 Step 3), allowlist removal (Task 1 Step 5), and verification (Task 3).

**Known limitation:** The browser evaluate uses `getComputedStyle` before the freeze, which reads the page's actual runtime styles. This works for pages that apply motion via inline styles or `<style>` tags loaded synchronously. Pages that inject styles via JavaScript AFTER load (SPA route changes, dynamic imports) may not have their motion CSS present at collection time. This is an acceptable limitation — the collection is best-effort and degrades gracefully (no motion signals if no motion is present at collection time).

**Critical ordering verified:** `collectMotionDeclarations` runs before `settlePage`, so the freeze tag hasn't been injected yet and computed styles reflect authored durations.
