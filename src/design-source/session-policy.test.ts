import { describe, expect, it } from "vitest";
import { decideCookie, chooseConsentAction } from "./session-policy.js";

// ============================================================
// session-policy.ts — the ephemeral cookie + consent policy.
//
// Pure functions only: no browser clicking, no cookie persistence,
// no jar. `decideCookie` is the single choke point that enforces the
// global constraint that essential first-party cookies may exist only
// inside ONE ephemeral capture context and that third-party cookies
// are blocked. `chooseConsentAction` picks the safest rejection
// button from the visible consent surface.
// ============================================================

describe("decideCookie: first-party essential allow", () => {
  it("allows an essential cookie whose domain equals the request hostname", () => {
    expect(decideCookie({ requestOrigin: "https://example.com", cookieDomain: "example.com", essential: true })).toBe("allow-session-first-party");
  });

  it("allows an essential cookie whose domain is a PARENT of the request hostname", () => {
    expect(decideCookie({ requestOrigin: "https://www.example.com", cookieDomain: "example.com", essential: true })).toBe("allow-session-first-party");
  });
});

describe("decideCookie: third-party and non-essential block", () => {
  it("blocks a non-essential cookie even when the domain matches", () => {
    expect(decideCookie({ requestOrigin: "https://example.com", cookieDomain: "example.com", essential: false })).toBe("block");
  });

  it("blocks a third-party tracker cookie (domain unrelated to host)", () => {
    expect(decideCookie({ requestOrigin: "https://example.com", cookieDomain: "tracker.test", essential: false })).toBe("block");
  });

  it("blocks when essential is missing/false even on a parent domain", () => {
    // Non-essential on a parent domain is still non-essential → block.
    expect(decideCookie({ requestOrigin: "https://www.example.com", cookieDomain: "example.com", essential: false })).toBe("block");
  });
});

describe("decideCookie: suffix-aliasing and child-domain traps", () => {
  it("does NOT treat a shared suffix as a parent (xexample.com is not example.com)", () => {
    // The classic suffix-aliasing trap: "xexample.com" ends with "example.com"
    // but is a different registrable host. Must block.
    expect(decideCookie({ requestOrigin: "https://xexample.com", cookieDomain: "example.com", essential: true })).toBe("block");
  });

  it("blocks when the cookie domain is a CHILD of the request host (third-party-ish)", () => {
    // www.example.com is a child of example.com, so a cookie scoped to the
    // deeper host is not first-party to a request on the shallower host.
    expect(decideCookie({ requestOrigin: "https://example.com", cookieDomain: "www.example.com", essential: true })).toBe("block");
  });
});

describe("decideCookie: malformed origin fail-closed", () => {
  it("blocks when the request origin cannot be parsed as a URL", () => {
    expect(decideCookie({ requestOrigin: "not a url", cookieDomain: "example.com", essential: true })).toBe("block");
  });
});

describe("chooseConsentAction: canonical Step-1 assertions", () => {
  it("selects 'Reject non-essential' from a mixed button set, preserving the label", () => {
    expect(chooseConsentAction(["Accept all", "Reject non-essential", "Preferences"])).toEqual({ kind: "click", label: "Reject non-essential" });
  });

  it("stops with reason when no safe rejection action exists", () => {
    expect(chooseConsentAction(["Accept all"])).toEqual({ kind: "stop", reason: "no safe rejection action" });
  });
});

describe("chooseConsentAction: case-insensitive rejection variants", () => {
  it("matches 'Reject all' and returns the label exactly as provided", () => {
    expect(chooseConsentAction(["Accept all", "Reject all"])).toEqual({ kind: "click", label: "Reject all" });
  });

  it("matches 'Necessary only' and returns the label exactly as provided", () => {
    expect(chooseConsentAction(["Accept all", "Necessary only"])).toEqual({ kind: "click", label: "Necessary only" });
  });

  it("matches 'Decline optional' and returns the label exactly as provided", () => {
    expect(chooseConsentAction(["Accept all", "Decline optional"])).toEqual({ kind: "click", label: "Decline optional" });
  });

  it("matches case-insensitively while preserving original casing in the returned label", () => {
    // Lowercase input still matches; the returned label preserves the original.
    expect(chooseConsentAction(["reject non-essential"])).toEqual({ kind: "click", label: "reject non-essential" });
    // All-caps input matches; original casing preserved.
    expect(chooseConsentAction(["NECESSARY ONLY"])).toEqual({ kind: "click", label: "NECESSARY ONLY" });
    // Mixed-case variant of "Decline Optional".
    expect(chooseConsentAction(["Decline optional"])).toEqual({ kind: "click", label: "Decline optional" });
  });

  it("selects the FIRST matching label in array order", () => {
    // Both match; the earlier one wins.
    expect(chooseConsentAction(["Reject all", "Necessary only"])).toEqual({ kind: "click", label: "Reject all" });
  });
});

describe("chooseConsentAction: ambiguous buttons do NOT count as rejection", () => {
  it("does not treat 'Continue' as a rejection (returns stop)", () => {
    expect(chooseConsentAction(["Continue"])).toEqual({ kind: "stop", reason: "no safe rejection action" });
  });

  it("does not treat generic affirmative/neutral labels as rejection", () => {
    // Bare "Accept", "OK", "Save", "Submit", "Preferences", bare "Reject"
    // (without all/non-essential), and bare "Necessary" (without "only") must
    // all fall through to the stop decision.
    for (const label of ["OK", "Accept", "Save", "Submit", "Reject", "Preferences", "Necessary"]) {
      expect(chooseConsentAction([label])).toEqual({ kind: "stop", reason: "no safe rejection action" });
    }
  });

  it("returns stop for an empty button set", () => {
    expect(chooseConsentAction([])).toEqual({ kind: "stop", reason: "no safe rejection action" });
  });
});

// ─── Codex review P1 #6: bare public suffixes are not first-party anchors ───
describe("decideCookie: codex review hardening", () => {
  it.each(["com", "org", "net", "io", "co"])(
    "blocks a cookie whose domain is a bare public suffix (%s)",
    (suffix) => {
      // `example.com`.endsWith(`.com`) is true, so the prior check treated the
      // TLD as a parent domain and allowed any cross-site cookie set for it.
      // A real parent domain has at least one dot.
      expect(
        decideCookie({ requestOrigin: `https://shop.${suffix}`, cookieDomain: suffix, essential: true }),
      ).toBe("block");
    },
  );

  it("still allows a real parent domain (example.com for www.example.com)", () => {
    expect(
      decideCookie({ requestOrigin: "https://www.example.com", cookieDomain: "example.com", essential: true }),
    ).toBe("allow-session-first-party");
  });
});
