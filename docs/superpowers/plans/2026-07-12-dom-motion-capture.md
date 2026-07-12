# Browser-Side DOM Motion Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect `normalizeMotionDeclarations` to the capture pipeline so motion signals are collected from the browser, normalized, written to the dom-signals sidecar, and available as `dom:motion:*` evidence in critique synthesis.

**Architecture:** Motion CSS declarations are collected **before** `settlePage` freezes them, via a pre-freeze evaluate that reads computed styles and stylesheet rules from interactive elements. The raw declarations are passed through the existing `normalizeMotionDeclarations` pure function in Node-land, and the normalized `MotionResult` is attached to `DomSignals.motion`. The sidecar serialization flows it through automatically. The wiring-verification allowlist entry for `normalizeMotionDeclarations` is removed.

**Critical design constraint:** `settlePage` (capture.ts:413) injects `animation-duration: 0s !important; transition-duration: 0s !important` on all elements before `captureLocator` runs. Computed styles read after this freeze will show `0s` for all durations. Motion collection MUST happen before the freeze, or read from authored stylesheet rules (not computed style).

**Tech Stack:** TypeScript, Playwright, existing dom-motion + capture modules.

## Global Constraints

- Motion collection must not exceed the existing 3s timeout budget for DOM signals.
- The freeze hazard means motion CSS must be collected before `settlePage` or from stylesheet rules.
- `normalizeMotionDeclarations` stays pure — the browser evaluate produces raw `DomMotionInput[]`, Node-land normalizes.
- Motion signals flow through the existing `DomSignals.motion` field → sidecar → `readDomSignalsForImage` → `TaggerInput.domSignals.motion` → `buildSynthesisContext` → `dom:motion:*` evidence. No new types needed.
- Cross-origin stylesheets throw `SecurityError` on `cssRules` access — catch and count as `inaccessibleStylesheets`.
- Remove `normalizeMotionDeclarations` from the wiring-verification allowlist once it has a production caller.

---

### Task 1: Add pre-freeze motion collection to the capture pipeline

**Files:**
- Modify: `src/scripts/capture.ts`
- Modify: `src/dom-motion.ts` (add `animationTimingFunction` field to `DomMotionInput`)
- Modify: `src/wiring-verification.test.ts` (remove allowlist entry)

**Interfaces:**
- Produces: a pre-freeze browser evaluate that collects `DomMotionInput[]` + `prefersReducedMotion` + `inaccessibleStylesheets`
- Produces: `normalizeMotionDeclarations` call in `captureLocator` that attaches `motion` to `DomSignals`
- Consumes: existing `normalizeMotionDeclarations` from `dom-motion.ts`

- [ ] **Step 1: Add `animationTimingFunction` to `DomMotionInput`**

In `src/dom-motion.ts`, add `animationTimingFunction?: string;` to the `DomMotionInput` interface. Update the animation signal builder to use `input.animationTimingFunction` (not `input.transitionTimingFunction`) for animation entries.

- [ ] **Step 2: Add pre-freeze motion collection evaluate**

In `src/scripts/capture.ts`, add a function that runs BEFORE `settlePage`:

```ts
async function collectMotionDeclarations(page: Page): Promise<{
  inputs: DomMotionInput[];
  prefersReducedMotion: boolean;
  inaccessibleStylesheets: number;
} | null> {
  try {
    return await page.evaluate(() => {
      // Collect authored transition/animation declarations from interactive elements
      const interactive = document.querySelectorAll("button, a, input, select, textarea, [role='button'], [role='link'], [role='tab'], [onclick], details, summary");
      const inputs = [];
      let count = 0;
      for (const el of interactive) {
        if (count >= 50) break; // match MAX_ELEMENTS
        // Skip invisible elements
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        const cs = window.getComputedStyle(el);
        // Only collect elements with actual motion (non-zero duration)
        const td = cs.transitionDuration;
        const ad = cs.animationDuration;
        const hasTransition = td && td !== "0s";
        const hasAnimation = ad && ad !== "0s" && cs.animationName && cs.animationName !== "none";
        if (!hasTransition && !hasAnimation) continue;
        count++;
        // Build a selector hint from tag + role + test-id
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute("role");
        const testId = el.getAttribute("data-testid");
        const selector = testId ? `${tag}[data-testid=${testId}]` : role ? `${tag}[role=${role}]` : tag;
        inputs.push({
          selector,
          transitionDuration: td,
          transitionProperty: cs.transitionProperty,
          transitionDelay: cs.transitionDelay,
          transitionTimingFunction: cs.transitionTimingFunction,
          animationDuration: ad,
          animationName: cs.animationName,
          animationIterationCount: cs.animationIterationCount,
          animationDelay: cs.animationDelay,
          animationTimingFunction: cs.animationTimingFunction,
        });
      }
      // Detect prefers-reduced-motion
      const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      // Count inaccessible (cross-origin) stylesheets
      let inaccessibleStylesheets = 0;
      for (const sheet of document.styleSheets) {
        try { void sheet.cssRules; } catch { inaccessibleStylesheets++; }
      }
      return { inputs, prefersReducedMotion, inaccessibleStylesheets };
    });
  } catch {
    return null; // Graceful degradation — no motion signals
  }
}
```

**Why before settlePage:** This evaluate runs before the freeze tag is injected, so `getComputedStyle` returns the actual authored durations, not the forced `0s`.

- [ ] **Step 3: Call collectMotionDeclarations in captureLocator**

In `captureLocator` (or the calling context), call `collectMotionDeclarations(page)` before `settlePage`. Store the result. After `extractDomSignals` returns, normalize and attach:

```ts
// Before settlePage:
const motionRaw = await collectMotionDeclarations(page);
// ... settlePage, capture, extractDomSignals ...
if (signals && motionRaw) {
  signals.motion = normalizeMotionDeclarations(motionRaw.inputs, {
    prefersReducedMotion: motionRaw.prefersReducedMotion,
    inaccessibleStylesheets: motionRaw.inaccessibleStylesheets,
  });
}
```

- [ ] **Step 4: Import normalizeMotionDeclarations in capture.ts**

Add: `import { normalizeMotionDeclarations, type DomMotionInput } from "../dom-motion.js";`

- [ ] **Step 5: Remove normalizeMotionDeclarations from wiring-verification allowlist**

Remove the entry from `src/wiring-verification.test.ts` and its DEFERRED comment.

- [ ] **Step 6: Build and test**

Run: `npm run build`
Expected: PASS

Run: `npm test`
Expected: PASS (wiring test should pass — normalizeMotionDeclarations now has a production caller in capture.ts)

- [ ] **Step 7: Commit**

```bash
git add src/scripts/capture.ts src/dom-motion.ts src/wiring-verification.test.ts
git commit -m "feat(capture): collect and normalize DOM motion declarations

- Pre-freeze browser evaluate collects transition/animation CSS from
  visible interactive elements before settlePage freezes motion
- normalizeMotionDeclarations processes raw declarations in Node-land
- Result attached to DomSignals.motion, flows through sidecar automatically
- Added animationTimingFunction to DomMotionInput (was reusing transition)
- Removed normalizeMotionDeclarations from wiring-verification allowlist"
```

---

### Task 2: Add tests for the motion collection integration

**Files:**
- Modify: `src/dom-motion.test.ts` (add tests for animationTimingFunction)

- [ ] **Step 1: Add test for animationTimingFunction**

Test that animation signals correctly use `animationTimingFunction` when provided, falling back to `undefined` when absent.

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/dom-motion.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/dom-motion.test.ts
git commit -m "test(dom-motion): add animationTimingFunction test"
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

- [ ] **Step 3: Verify no freeze hazard**

Grep that `collectMotionDeclarations` is called before `settlePage`:

```bash
grep -n "collectMotionDeclarations\|settlePage" src/scripts/capture.ts
```

Expected: `collectMotionDeclarations` appears BEFORE `settlePage` in the capture flow.

## Self-Review

**Spec coverage:** The plan covers pre-freeze collection (Task 1), animationTimingFunction fix (Task 1 Step 1 + Task 2), normalization call (Task 1 Step 3), allowlist removal (Task 1 Step 5), and verification (Task 3).

**Known limitation:** The browser evaluate uses `getComputedStyle` before the freeze, which reads the page's actual runtime styles. This works for pages that apply motion via inline styles or `<style>` tags loaded synchronously. Pages that inject styles via JavaScript AFTER load (SPA route changes, dynamic imports) may not have their motion CSS present at collection time. This is an acceptable limitation — the collection is best-effort and degrades gracefully (no motion signals if no motion is present at collection time).

**Critical ordering verified:** `collectMotionDeclarations` runs before `settlePage`, so the freeze tag hasn't been injected yet and computed styles reflect authored durations.
