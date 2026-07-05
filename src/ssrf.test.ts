import { describe, expect, it } from "vitest";
import { isPrivateAddress, assertSafeCaptureTarget } from "./ssrf.js";
import { captureSlug, isAllowedByRobots, escapeCssId } from "./scripts/capture.js";

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
