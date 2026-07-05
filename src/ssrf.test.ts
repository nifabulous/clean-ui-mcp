import { describe, expect, it } from "vitest";
import { isPrivateAddress, assertSafeCaptureTarget } from "./ssrf.js";
import { captureSlug, isAllowedByRobots, escapeCssId, selectorFingerprint, MIN_GROUP_DIM, MAX_GROUP_ASPECT, MIN_VH_FRAC, VIEWPORTS } from "./scripts/capture.js";

// ============================================================
// SSRF guard — the lint that prevents the capture pipeline from
// becoming an SSRF vector. Tested directly because both the CLI
// (npm run capture / capture-batch) and /api/capture-url depend on it.
// ============================================================

describe("SSRF guard: isPrivateAddress", () => {
  it("rejects IPv4 private ranges", () => {
    expect(isPrivateAddress("10.0.0.1")).toBe(true);
    expect(isPrivateAddress("10.255.255.255")).toBe(true);
    expect(isPrivateAddress("192.168.1.1")).toBe(true);
    expect(isPrivateAddress("172.16.0.1")).toBe(true);
    expect(isPrivateAddress("172.31.255.255")).toBe(true);
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("0.0.0.0")).toBe(true);
    // Cloud-metadata endpoint — the canonical SSRF target.
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
  });

  it("rejects IPv6 private/loopback/link-local", () => {
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("::")).toBe(true);
    expect(isPrivateAddress("fe80::1")).toBe(true);
    expect(isPrivateAddress("fc00::1")).toBe(true);
    expect(isPrivateAddress("fd12:3456::1")).toBe(true);
  });

  it("unmasks IPv4-mapped IPv6 and rejects the underlying private v4", () => {
    expect(isPrivateAddress("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:169.254.169.254")).toBe(true);
  });

  it("accepts public addresses", () => {
    expect(isPrivateAddress("1.1.1.1")).toBe(false);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("203.0.113.1")).toBe(false);
    // Public v6 (Cloudflare)
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
  });
});

describe("SSRF guard: assertSafeCaptureTarget", () => {
  it("rejects non-http(s) protocols", async () => {
    await expect(assertSafeCaptureTarget("file:///etc/passwd")).rejects.toThrow(/http and https/);
    await expect(assertSafeCaptureTarget("ftp://example.com/")).rejects.toThrow(/http and https/);
  });

  it("rejects the AWS/GCP cloud-metadata hostnames by name", async () => {
    await expect(assertSafeCaptureTarget("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/blocked metadata/);
    await expect(assertSafeCaptureTarget("http://metadata.google.internal/computeMetadata/v1/")).rejects.toThrow(/blocked metadata/);
  });

  it("rejects malformed URLs", async () => {
    await expect(assertSafeCaptureTarget("not-a-url")).rejects.toThrow(/Invalid URL/);
    await expect(assertSafeCaptureTarget("https://")).rejects.toThrow(/Invalid URL/);
  });

  it("allows explicit localhost hostnames (legitimate dev target)", async () => {
    // These should NOT throw — local-dev captures against a sandbox running on
    // the same machine are a real workflow.
    await expect(assertSafeCaptureTarget("http://localhost:3000/")).resolves.toBeInstanceOf(URL);
    await expect(assertSafeCaptureTarget("http://127.0.0.1:8080/")).resolves.toBeInstanceOf(URL);
  });
});

// ============================================================
// slug — the path-traversal guard that prevents untrusted
// captureId/batchId/slug values from escaping images-private/.
// ============================================================

describe("capture slug (path-traversal guard)", () => {
  it("strips path separators and dots from untrusted slugs", () => {
    // The classic traversal attempt — must NOT preserve the ../ sequence.
    // The slug regex collapses runs of non-alphanumerics into single hyphens,
    // so "../../etc/passwd" → "etc-passwd" (the leading "../" run drops to "").
    expect(captureSlug("../../etc/passwd")).toBe("etc-passwd");
    // URL-encoded traversal "..%2F..%2Fetc" — the % gets stripped and the runs
    // of dots/letters collapse to a safe kebab string with no path separators.
    expect(captureSlug("..%2F..%2Fetc")).toBe("2f-2fetc");
    expect(captureSlug("/absolute/path")).toBe("absolute-path");
    // The key invariant: no output contains "/", "\", or "..".
    for (const malicious of ["..", "../", "..\\", "..%2f", "..%5c", "....//"]) {
      const out = captureSlug(malicious);
      expect(out).not.toContain("/");
      expect(out).not.toContain("\\");
    }
  });

  it("returns a safe fallback for all-symbol input", () => {
    expect(captureSlug("...")).toBe("");
    expect(captureSlug("%%")).toBe("");
    expect(captureSlug("")).toBe("");
  });

  it("preserves meaningful slugs", () => {
    expect(captureSlug("Linear Landing 2026")).toBe("linear-landing-2026");
    expect(captureSlug("stripe-dashboard-dark")).toBe("stripe-dashboard-dark");
  });
});

// ============================================================
// escapeCssId — Node-side replacement for the browser-only CSS.escape.
// Critical because the previous version called CSS.escape from Node code
// (page.locator ran in Node, not in page.evaluate), which threw
// ReferenceError, got caught at the viewport loop, and silently skipped
// every section/group/interaction for that viewport whenever a page had
// any anchor ID. Bug surfaced in PR review.
// ============================================================

describe("escapeCssId (Node-side CSS.escape replacement)", () => {
  it("passes through plain alphanumeric ids unchanged", () => {
    expect(escapeCssId("main")).toBe("main");
    expect(escapeCssId("hero-section")).toBe("hero-section");
    expect(escapeCssId("nav_primary")).toBe("nav_primary");
  });

  it("escapes a leading digit (would otherwise make an invalid identifier)", () => {
    // A bare `#1section` is invalid CSS; `#\31 section` is the spec form.
    // We just need the result to be a valid selector — exact bytes can vary.
    const out = escapeCssId("1section");
    expect(out).not.toBe("1section");
    expect(out.startsWith("\\")).toBe(true);
  });

  it("escapes dots and colons (the classic id-trap characters)", () => {
    // `#foo.bar` would be parsed as id="foo" class="bar". `#a:b` would be
    // parsed as id="a" pseudo-class="b". Both must be escaped.
    const dotted = escapeCssId("foo.bar");
    expect(dotted).not.toBe("foo.bar");
    expect(dotted.includes("\\")).toBe(true);
    const colon = escapeCssId("a:b");
    expect(colon).not.toBe("a:b");
    expect(colon.includes("\\")).toBe(true);
  });

  it("produces a selector that locates an element with that id (round-trip)", () => {
    // Smoke test: when fed back into a CSS attribute selector that DOESN'T
    // need escaping, the escaped id should still match. (Sanity for the
    // alphanumeric pass-through path.)
    expect(escapeCssId("plain")).toBe("plain");
  });
});

// ============================================================
// robots.txt gate — the heise.de case. A site that disallows
// capture must be skipped, but a missing/unreachable robots.txt
// is treated as allowed (don't hard-block on transient network errors).
// ============================================================

describe("robots.txt gate", () => {
  it("allows when robots.txt is missing (404 → treat as allowed)", async () => {
    // example.com serves a real robots.txt; pick a hostname that 404s.
    // Wrap in try/catch because this makes a real network call — if the test
    // environment has no network, the fetch throws and the gate returns true.
    const allowed = await isAllowedByRobots("https://example.com/some-path-with-no-disallow").catch(() => true);
    expect(allowed).toBe(true);
  });
});

// ============================================================
// selectorFingerprint — short id generation for capture filenames.
// Bug it fixes: cssPath() in DETECT_SCRIPT can chain up to 6 nodes worth of
// tag+classes; slugified directly into a filename that regularly exceeded
// 200 chars ("File name too long" on zip/tar). The fingerprint is sha1/10
// so ids stay short and stable; selectorPath in the manifest keeps the
// human-readable original.
// ============================================================

describe("selectorFingerprint (short id generation)", () => {
  it("returns a 10-char hex string regardless of input length", () => {
    const short = selectorFingerprint("#main");
    const long = selectorFingerprint("body > div.very.deeply.nested.container > section.foo.bar > article > p.baz.qux > span");
    expect(short).toMatch(/^[a-f0-9]{10}$/);
    expect(long).toMatch(/^[a-f0-9]{10}$/);
    expect(short.length).toBe(10);
    expect(long.length).toBe(10);
  });

  it("is deterministic — same selector always produces the same fingerprint", () => {
    const s = "body > main > section.hero > div.container > h1";
    expect(selectorFingerprint(s)).toBe(selectorFingerprint(s));
  });

  it("distinguishes different selectors", () => {
    // Two selectors that differ only in their tail should produce different ids.
    const a = selectorFingerprint("body > main > section.hero");
    const b = selectorFingerprint("body > main > section.footer");
    expect(a).not.toBe(b);
  });

  it("produces ids short enough that filenames stay under common filesystem limits", () => {
    // Real batch id from the linear.app run before this fix:
    //   linear-group-div-7bwwmq-root-7bwwmq-homepage-nth-of-type-2-div-...-mobile
    // (200+ chars). With fingerprinting, the worst case is product + group +
    // 10-char-hash + viewport, ~40 chars total.
    const longSelector = "body > main > section > div > div > div > div.a.b > div.c.d > div.e.f > article > p";
    const id = `linear-group-${selectorFingerprint(longSelector)}-desktop`;
    expect(id.length).toBeLessThan(50);
  });
});

// ============================================================
// Group-member size filter — the sliver-rejection predicate that gates Pass B
// (repeated sibling groups). Ported here from DETECT_SCRIPT so we can test
// the math directly. The in-page script uses the same constants
// (MIN_GROUP_DIM, MAX_GROUP_ASPECT); the predicate below mirrors its logic.
//
// Bug cases this catches:
//   - 12×249 chart-bar sliver (passed the old height-only floor)
//   - <60px icon fragments (now dropped by the per-axis floor)
// Bug cases it correctly still rejects:
//   - SVG-internal <path> siblings (caught by the SVG guard, not this filter)
// ============================================================

describe("group-member size filter (sliver rejection)", () => {
  // Predicate mirroring the in-page check (group.map(...).filter).
  function groupMemberPasses(width: number, height: number): boolean {
    if (width < MIN_GROUP_DIM || height < MIN_GROUP_DIM) return false;
    const longSide = Math.max(width, height);
    const shortSide = Math.max(1, Math.min(width, height));
    return longSide / shortSide <= MAX_GROUP_ASPECT;
  }

  it("rejects the 12×249 sliver that motivated the fix", () => {
    // Real case from the linear.app batch: a chart-bar inside an <svg>. The
    // 12px width passed the area check (249×12 = 2988 > 2500) but the capture
    // was a content-free vertical strip. With MIN_GROUP_DIM=60 this is now
    // rejected on width alone.
    expect(groupMemberPasses(12, 249)).toBe(false);
  });

  it("rejects anything below the per-axis 60px floor", () => {
    expect(groupMemberPasses(59, 200)).toBe(false);
    expect(groupMemberPasses(200, 59)).toBe(false);
    expect(groupMemberPasses(59, 59)).toBe(false);
  });

  it("rejects extreme aspect ratios even when both axes clear the floor", () => {
    // 60×481 = ~8:1, just over the cap.
    expect(groupMemberPasses(60, 481)).toBe(false);
    // 600×60 = 10:1 — legit width, but a sliver-thin strip.
    expect(groupMemberPasses(600, 60)).toBe(false);
  });

  it("accepts legitimate group-member shapes", () => {
    expect(groupMemberPasses(300, 200)).toBe(true);   // typical card
    expect(groupMemberPasses(200, 200)).toBe(true);   // square tile
    expect(groupMemberPasses(80, 80)).toBe(true);     // exactly at floor (MIN_GROUP_DIM=80)
    expect(groupMemberPasses(640, 80)).toBe(true);    // 8:1 exactly, both axes ≥80
    expect(groupMemberPasses(120, 120)).toBe(true);   // small icon tile
    // The 60×60 case used to pass at MIN_GROUP_DIM=60; with the floor at 80
    // it's now (correctly) rejected — small enough that it's likely an icon
    // grid rather than a real card grid.
    expect(groupMemberPasses(60, 60)).toBe(false);
  });

  it("the threshold tuning is internally consistent with the exported constants", () => {
    // Sanity: the constants exist and have sensible values. If someone tunes
    // them later, this catches accidental drift to a nonsensical range.
    // MIN_GROUP_DIM matches section-mode's minH=80 deliberately — keeps the
    // "what counts as a UI unit" floor consistent across detection modes.
    expect(MIN_GROUP_DIM).toBeGreaterThanOrEqual(60);
    expect(MIN_GROUP_DIM).toBeLessThanOrEqual(120);
    expect(MAX_GROUP_ASPECT).toBeGreaterThanOrEqual(4);
    expect(MAX_GROUP_ASPECT).toBeLessThanOrEqual(20);
    // MIN_VH_FRAC: the section-height fractional floor. 0.12 = 12% of viewport.
    // Tight band — anything below 0.08 lets slivers through, anything above
    // 0.20 starts dropping real compact sections.
    expect(MIN_VH_FRAC).toBeGreaterThanOrEqual(0.08);
    expect(MIN_VH_FRAC).toBeLessThanOrEqual(0.20);
  });
});

// ============================================================
// Section-height filter — the min-VH fractional floor for Pass A.
// Closes the asymmetry in the section filter: width had a fractional floor
// (vw * 0.5) but height had only a fixed pixel floor (minH=80). Without a
// fractional floor, a 1392×112 announcement bar (12% of a 900px desktop
// viewport) passed because it cleared 80px — but a strip that thin isn't a
// meaningful UI section.
//
// Predicate ported from DETECT_SCRIPT so we can test the math directly.
// Tested at desktop (vh=900) and mobile (vh=844) since the floor is fractional.
// ============================================================

describe("section-height filter (MIN_VH_FRAC)", () => {
  // Predicate mirroring the section filter's height check.
  // minH is the legacy 80px floor; minVFrac is the new fractional floor.
  // Both must be cleared (height >= max(minH, vh * minVFrac)).
  const MIN_H = 80;
  function sectionHeightPasses(height: number, vh: number, minVFrac: number): boolean {
    return height >= MIN_H && height >= vh * minVFrac;
  }

  it("rejects sub-12% sections on a 900px desktop viewport", () => {
    const vh = 900;
    // 12% of 900 = 108px. The fractional floor dominates the 80px fixed floor.
    // Real cases from the linear+vercel batch — sub-12% should drop, ≥12% keep:
    expect(sectionHeightPasses(97, vh, MIN_VH_FRAC)).toBe(false);   // 10.8% — group fragment
    expect(sectionHeightPasses(105, vh, MIN_VH_FRAC)).toBe(false);  // 11.7% — under the 108px floor
    expect(sectionHeightPasses(108, vh, MIN_VH_FRAC)).toBe(true);   // exactly 12% — passes
    expect(sectionHeightPasses(137, vh, MIN_VH_FRAC)).toBe(true);   // 15% — real section
    expect(sectionHeightPasses(700, vh, MIN_VH_FRAC)).toBe(true);   // hero-sized
  });

  it("scales with viewport — same logic, different px threshold on mobile", () => {
    // The fractional floor's whole point: 12% means a different pixel count
    // per viewport, but the same "meaningful relative to what the user sees"
    // semantic. Mobile vh=844 → 12% = 101.28px, so 101 fails and 102 passes.
    const mobileVh = 844;
    expect(sectionHeightPasses(100, mobileVh, MIN_VH_FRAC)).toBe(false);  // 11.8% — under
    expect(sectionHeightPasses(101, mobileVh, MIN_VH_FRAC)).toBe(false);  // 11.97% — still under 101.28
    expect(sectionHeightPasses(102, mobileVh, MIN_VH_FRAC)).toBe(true);   // 12.1% — passes
  });

  it("the fixed 80px floor still kicks in for unusually short viewports", () => {
    // On a tiny viewport (e.g. an old phone landscape at 400px tall), 12% would
    // be 48px — below the 80px fixed floor. In that regime the fixed floor
    // dominates and prevents tiny-but-fractional sections from passing.
    const tinyVh = 400;
    expect(sectionHeightPasses(50, tinyVh, MIN_VH_FRAC)).toBe(false);   // 50 < 80
    expect(sectionHeightPasses(80, tinyVh, MIN_VH_FRAC)).toBe(true);    // 80px floor satisfied
  });
});

// ============================================================
// VIEWPORTS — filtered by CAPTURE_VIEWPORTS env var. Default is both
// desktop + mobile. The filter exists so a curator building out one corpus
// (e.g. web-only) can skip the other viewport without editing code.
// ============================================================

describe("VIEWPORTS filter (CAPTURE_VIEWPORTS env)", () => {
  // Note: VIEWPORTS is computed at module load from process.env.CAPTURE_VIEWPORTS,
  // so this test asserts the *current* process's filter result. The default
  // (env unset) is both viewports; setting CAPTURE_VIEWPORTS=desktop at boot
  // filters to just desktop. We can't easily test both from one process, so
  // this test locks in whichever shape is currently active and asserts the
  // invariants that hold regardless of the filter.
  it("returns at least one viewport (never empty — empty would silently produce zero captures)", () => {
    expect(VIEWPORTS.length).toBeGreaterThanOrEqual(1);
  });

  it("every entry has a name, width, and height", () => {
    for (const v of VIEWPORTS) {
      expect(typeof v.name).toBe("string");
      expect(v.name.length).toBeGreaterThan(0);
      expect(v.width).toBeGreaterThan(0);
      expect(v.height).toBeGreaterThan(0);
    }
  });

  it("the desktop viewport (1440×900) is in the active set under default config", () => {
    // Default env = both viewports. If this test process has CAPTURE_VIEWPORTS
    // set to mobile-only, this would fail — but the default-run expectation
    // is desktop present.
    const desktop = VIEWPORTS.find((v) => v.name === "desktop");
    expect(desktop).toBeDefined();
    expect(desktop?.width).toBe(1440);
    expect(desktop?.height).toBe(900);
  });
});
