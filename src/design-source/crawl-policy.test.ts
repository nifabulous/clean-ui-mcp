import { describe, expect, it } from "vitest";
import { planRepresentativeCrawl } from "./crawl-policy.js";

// ============================================================
// planRepresentativeCrawl — the bounded representative crawl
// planner. Pure function: takes the user's starting URL plus the
// set of links discovered during the initial public, same-origin,
// unauthenticated inspection, and produces a CrawlPlan that is
// GUARANTEED bounded (≤30 routes), same-origin, non-destructive,
// and free of raw credentials.
//
// The planner is the choke point that enforces the global
// constraints: no unbounded crawl, no cross-origin drift, no
// mutation/logout/admin/api routes, no raw pasted credentials.
// ============================================================

describe("planRepresentativeCrawl: canonicalization", () => {
  it("strips fragments (the #... portion never affects identity)", () => {
    const plan = planRepresentativeCrawl({
      startUrl: "https://example.com/app",
      discoveredUrls: ["https://example.com/section#hero", "https://example.com/section#nav"],
    });
    // Both fragment-bearing URLs collapse to the same canonical route; the
    // first occurrence wins and the duplicate is skipped.
    expect(plan.routes.map((r) => r.url)).toEqual([
      "https://example.com/app",
      "https://example.com/section",
    ]);
    expect(plan.skipped.map((s) => s.url)).toEqual(["https://example.com/section"]);
  });

  it("strips utm_* tracking parameters plus gclid, fbclid, and ref", () => {
    const plan = planRepresentativeCrawl({
      startUrl: "https://example.com/",
      discoveredUrls: [
        "https://example.com/pricing?utm_source=x&utm_medium=y",
        "https://example.com/ads?gclid=abc&fbclid=def&ref=partner",
        "https://example.com/keep?id=42",
      ],
    });
    expect(plan.routes.map((r) => r.url)).toEqual([
      "https://example.com/",
      "https://example.com/pricing",
      "https://example.com/ads",
      "https://example.com/keep?id=42",
    ]);
  });
});

describe("planRepresentativeCrawl: same-origin enforcement", () => {
  it("rejects cross-origin URLs with reason 'cross-origin'", () => {
    const plan = planRepresentativeCrawl({
      startUrl: "https://example.com/",
      discoveredUrls: [
        "https://other.test/",
        "https://example.org/path",
        "http://example.com/different-scheme",
      ],
    });
    // Only the startUrl (same-origin to itself) survives; the rest are
    // cross-origin (different host OR different scheme → different origin).
    expect(plan.routes.map((r) => r.url)).toEqual(["https://example.com/"]);
    expect(plan.skipped.map((s) => ({ url: s.url, reason: s.reason }))).toEqual([
      { url: "https://other.test/", reason: "cross-origin" },
      { url: "https://example.org/path", reason: "cross-origin" },
      { url: "http://example.com/different-scheme", reason: "cross-origin" },
    ]);
  });
});

describe("planRepresentativeCrawl: non-HTML exclusion", () => {
  it("rejects non-HTML extensions with reason 'non-html'", () => {
    const plan = planRepresentativeCrawl({
      startUrl: "https://example.com/",
      discoveredUrls: [
        "https://example.com/file.zip",
        "https://example.com/doc.pdf",
        "https://example.com/img.png",
        "https://example.com/photo.jpeg",
        "https://example.com/anim.gif",
        "https://example.com/pic.webp",
        "https://example.com/logo.svg",
        "https://example.com/clip.mp4",
        "https://example.com/audio.mp3",
        "https://example.com/data.json",
        "https://example.com/feed.xml",
      ],
    });
    expect(plan.routes.map((r) => r.url)).toEqual(["https://example.com/"]);
    for (const skip of plan.skipped) {
      expect(skip.reason).toBe("non-html");
    }
    expect(plan.skipped).toHaveLength(11);
  });
});

describe("planRepresentativeCrawl: destructive route blocking", () => {
  it("rejects logout, signout, delete, remove, purchase, checkout, invite, and admin paths", () => {
    const plan = planRepresentativeCrawl({
      startUrl: "https://example.com/",
      discoveredUrls: [
        "https://example.com/logout",
        "https://example.com/signout",
        "https://example.com/delete",
        "https://example.com/remove",
        "https://example.com/purchase",
        "https://example.com/checkout",
        "https://example.com/invite",
        "https://example.com/admin",
        "https://example.com/admin/users",
        "https://example.com/logout?next=/", // destructive even with query
      ],
    });
    expect(plan.routes.map((r) => r.url)).toEqual(["https://example.com/"]);
    expect(plan.skipped).toHaveLength(10);
    for (const skip of plan.skipped) {
      expect(skip.reason).toBe("destructive");
    }
  });

  it("still allows a path that merely CONTAINS a destructive word as a substring", () => {
    // /signout-forms is fine; only path SEGMENTS matching the denylist are blocked.
    const plan = planRepresentativeCrawl({
      startUrl: "https://example.com/",
      discoveredUrls: ["https://example.com/signout-forms", "https://example.com/removals"],
    });
    expect(plan.routes.map((r) => r.url)).toEqual([
      "https://example.com/",
      "https://example.com/signout-forms",
      "https://example.com/removals",
    ]);
  });

  it("rejects /api/ paths with reason 'non-html'", () => {
    const plan = planRepresentativeCrawl({
      startUrl: "https://example.com/",
      discoveredUrls: ["https://example.com/api/users", "https://example.com/api/v1/items"],
    });
    expect(plan.routes.map((r) => r.url)).toEqual(["https://example.com/"]);
    for (const skip of plan.skipped) {
      expect(skip.reason).toBe("non-html");
    }
  });
});

describe("planRepresentativeCrawl: duplicate collapse + ordering", () => {
  it("the user-supplied startUrl is ALWAYS first with reason 'user-supplied'", () => {
    const plan = planRepresentativeCrawl({
      startUrl: "https://example.com/app",
      discoveredUrls: ["https://example.com/a", "https://example.com/b"],
    });
    expect(plan.routes[0]).toEqual({ url: "https://example.com/app", reason: "user-supplied" });
  });

  it("duplicate canonical URLs collapse to a single route (first occurrence wins)", () => {
    const plan = planRepresentativeCrawl({
      startUrl: "https://example.com/",
      discoveredUrls: [
        "https://example.com/page?utm_source=x",
        "https://example.com/page#frag",
        "https://example.com/page",
      ],
    });
    // All three canonicalize to https://example.com/page → one route, two skips.
    expect(plan.routes.map((r) => r.url)).toEqual(["https://example.com/", "https://example.com/page"]);
    expect(plan.skipped.map((s) => ({ url: s.url, reason: s.reason }))).toEqual([
      { url: "https://example.com/page", reason: "duplicate" },
      { url: "https://example.com/page", reason: "duplicate" },
    ]);
  });

  it("user-supplied takes priority when startUrl also appears in discoveredUrls", () => {
    const plan = planRepresentativeCrawl({
      startUrl: "https://example.com/app",
      discoveredUrls: ["https://example.com/app#section", "https://example.com/app"],
    });
    expect(plan.routes[0]).toEqual({ url: "https://example.com/app", reason: "user-supplied" });
    // The two discovered copies canonicalize to the start URL → duplicates.
    expect(plan.skipped.every((s) => s.reason === "duplicate")).toBe(true);
    expect(plan.skipped).toHaveLength(2);
  });
});

describe("planRepresentativeCrawl: budget enforcement", () => {
  it("the three exact Step-1 assertions hold", () => {
    // #1: full canonicalization + filtering pipeline.
    expect(
      planRepresentativeCrawl({
        startUrl: "https://example.com/app",
        discoveredUrls: [
          "https://example.com/",
          "https://example.com/pricing?utm_source=x",
          "https://other.test/",
          "https://example.com/api/users",
          "https://example.com/logout",
        ],
      }).routes.map((route) => route.url),
    ).toEqual(["https://example.com/app", "https://example.com/", "https://example.com/pricing"]);

    // #2: default budget caps 40 discovered URLs at 25 routes.
    expect(
      planRepresentativeCrawl({
        startUrl: "https://example.com",
        discoveredUrls: Array.from({ length: 40 }, (_, index) => `https://example.com/page-${index}`),
      }).routes,
    ).toHaveLength(25);

    // #3: any non-empty credential field throws.
    expect(() =>
      planRepresentativeCrawl({ startUrl: "https://example.com", discoveredUrls: [], cookie: "session=secret" }),
    ).toThrow(/raw credentials are not accepted/);
  });

  it("default budget is 25 (40 discovered → exactly 25 routes, remainder budget-skipped)", () => {
    const plan = planRepresentativeCrawl({
      startUrl: "https://example.com",
      discoveredUrls: Array.from({ length: 40 }, (_, index) => `https://example.com/page-${index}`),
    });
    expect(plan.routes).toHaveLength(25);
    // 40 discovered all canonicalize uniquely + survive filters; 24 of them
    // fit alongside the user-supplied startUrl (25 routes total), leaving the
    // remaining 16 budget-exhausted. startUrl occupies slot 1 of 25.
    expect(plan.skipped.filter((s) => s.reason === "budget")).toHaveLength(16);
    // Every skipped URL has a reason.
    expect(plan.skipped.every((s) => typeof s.reason === "string" && s.reason.length > 0)).toBe(true);
  });

  it("caps maxRoutes at 30 even when the caller asks for more", () => {
    const plan = planRepresentativeCrawl({
      startUrl: "https://example.com",
      maxRoutes: 1000,
      discoveredUrls: Array.from({ length: 100 }, (_, index) => `https://example.com/page-${index}`),
    });
    expect(plan.maxRoutes).toBe(30);
    expect(plan.routes).toHaveLength(30);
  });

  it("honors a maxRoutes under the cap", () => {
    const plan = planRepresentativeCrawl({
      startUrl: "https://example.com",
      maxRoutes: 5,
      discoveredUrls: Array.from({ length: 20 }, (_, index) => `https://example.com/page-${index}`),
    });
    expect(plan.maxRoutes).toBe(5);
    expect(plan.routes).toHaveLength(5);
  });

  it("treats a NaN maxRoutes as the default (25), not unbounded", () => {
    // NaN would otherwise make `routes.length >= NaN` always false, so the
    // budget never fires and 40 discovered URLs would ALL route. After the
    // Number.isFinite guard, NaN falls back to the default of 25.
    const plan = planRepresentativeCrawl({
      startUrl: "https://example.com",
      discoveredUrls: Array.from({ length: 40 }, (_, i) => `https://example.com/p${i}`),
      maxRoutes: NaN,
    });
    expect(plan.maxRoutes).toBe(25);
    expect(plan.routes).toHaveLength(25);
  });

  it("floors a fractional maxRoutes to an integer before clamping (P2)", () => {
    // A fractional budget like 1.5 must not report maxRoutes: 1.5 while letting
    // two routes in (the budget comparison runs before insertion). The reported
    // bound must be an integer to match DesignSourceSnapshotSchema's
    // crawl.maxRoutes contract. Math.floor(1.5) = 1.
    const plan = planRepresentativeCrawl({
      startUrl: "https://example.com",
      discoveredUrls: ["https://example.com/a", "https://example.com/b"],
      maxRoutes: 1.5,
    });
    expect(plan.maxRoutes).toBe(1);
    // Only the start URL fits — floor(1.5)=1, and startUrl occupies the slot.
    expect(plan.routes).toHaveLength(1);
    expect(plan.routes[0].reason).toBe("user-supplied");
  });

  it("rejects a destructive start URL rather than anchoring an unsafe crawl (P1)", () => {
    // The start URL is the crawl's origin anchor. If it is itself destructive,
    // API, or non-HTML, there is no valid safe entry route, so the whole request
    // is rejected with a clear error rather than silently producing an empty or
    // unsafe plan. User intent selects WHICH routes are crawled; it does not
    // bypass the hosted-capture safety boundary.
    expect(() =>
      planRepresentativeCrawl({ startUrl: "https://example.com/logout", discoveredUrls: [] }),
    ).toThrow(/destructive/);
    expect(() =>
      planRepresentativeCrawl({ startUrl: "https://example.com/admin", discoveredUrls: [] }),
    ).toThrow(/destructive/);
    expect(() =>
      planRepresentativeCrawl({ startUrl: "https://example.com/api/delete", discoveredUrls: [] }),
    ).toThrow(/destructive/);
    expect(() =>
      planRepresentativeCrawl({ startUrl: "https://example.com/api/users", discoveredUrls: [] }),
    ).toThrow(/non-html/);
    expect(() =>
      planRepresentativeCrawl({ startUrl: "https://example.com/export.pdf", discoveredUrls: [] }),
    ).toThrow(/non-html/);
  });

  it("accepts a safe (non-destructive, HTML) start URL unchanged (P1 regression guard)", () => {
    // The normal case must still work: a safe start URL anchors the crawl and
    // is route[0] with reason 'user-supplied'.
    const plan = planRepresentativeCrawl({ startUrl: "https://example.com/app", discoveredUrls: [] });
    expect(plan.routes).toHaveLength(1);
    expect(plan.routes[0]).toEqual({ url: "https://example.com/app", reason: "user-supplied" });
  });
});

describe("planRepresentativeCrawl: include/exclude", () => {
  it("includeUrls become 'user-included' routes (subject to the same filters)", () => {
    const plan = planRepresentativeCrawl({
      startUrl: "https://example.com/",
      discoveredUrls: [],
      includeUrls: ["https://example.com/about", "https://example.com/team"],
    });
    expect(plan.routes.map((r) => ({ url: r.url, reason: r.reason }))).toEqual([
      { url: "https://example.com/", reason: "user-supplied" },
      { url: "https://example.com/about", reason: "user-included" },
      { url: "https://example.com/team", reason: "user-included" },
    ]);
  });

  it("a cross-origin or destructive includeUrl goes to 'skipped', not routes", () => {
    const plan = planRepresentativeCrawl({
      startUrl: "https://example.com/",
      discoveredUrls: [],
      includeUrls: ["https://other.test/", "https://example.com/admin", "https://example.com/ok"],
    });
    expect(plan.routes.map((r) => r.url)).toEqual(["https://example.com/", "https://example.com/ok"]);
    expect(plan.skipped.map((s) => ({ url: s.url, reason: s.reason }))).toEqual([
      { url: "https://other.test/", reason: "cross-origin" },
      { url: "https://example.com/admin", reason: "destructive" },
    ]);
  });

  it("excludeUrls entries that would otherwise be routes go to 'skipped' with reason 'excluded'", () => {
    const plan = planRepresentativeCrawl({
      startUrl: "https://example.com/",
      discoveredUrls: ["https://example.com/keep", "https://example.com/drop"],
      excludeUrls: ["https://example.com/drop"],
    });
    expect(plan.routes.map((r) => r.url)).toEqual(["https://example.com/", "https://example.com/keep"]);
    expect(plan.skipped.map((s) => ({ url: s.url, reason: s.reason }))).toEqual([
      { url: "https://example.com/drop", reason: "excluded" },
    ]);
  });
});

describe("planRepresentativeCrawl: credential rejection", () => {
  it("rejects a non-empty cookie", () => {
    expect(() =>
      planRepresentativeCrawl({ startUrl: "https://example.com", discoveredUrls: [], cookie: "session=secret" }),
    ).toThrow(/raw credentials are not accepted/);
  });

  it("rejects a non-empty authorization header", () => {
    expect(() =>
      planRepresentativeCrawl({ startUrl: "https://example.com", discoveredUrls: [], authorization: "Bearer abc" }),
    ).toThrow(/raw credentials are not accepted/);
  });

  it("rejects a non-empty password", () => {
    expect(() =>
      planRepresentativeCrawl({ startUrl: "https://example.com", discoveredUrls: [], password: "hunter2" }),
    ).toThrow(/raw credentials are not accepted/);
  });

  it("does NOT throw when credential fields are absent or empty", () => {
    expect(() =>
      planRepresentativeCrawl({ startUrl: "https://example.com", discoveredUrls: [], cookie: "" }),
    ).not.toThrow();
    expect(() => planRepresentativeCrawl({ startUrl: "https://example.com", discoveredUrls: [] })).not.toThrow();
  });
});

describe("planRepresentativeCrawl: percent-encoded bypass", () => {
  it("decodes percent-encoded destructive/api/non-html paths before filtering", () => {
    // WHATWG URL.pathname does NOT decode percent-encoding, so without a
    // decode step these would slip past the filters (under-block). After the
    // fix, the decoded form is what the destructive/api/extension regexes see.
    const plan = planRepresentativeCrawl({
      startUrl: "https://example.com",
      discoveredUrls: [
        "https://example.com/%61dmin", // decodes to /admin → destructive
        "https://example.com/%64elete", // decodes to /delete → destructive
        "https://example.com/%61pi/users", // decodes to /api/users → non-html
      ],
    });
    // All three must be SKIPPED (none routed). startUrl is the only route.
    expect(plan.routes.map((r) => r.url)).toEqual(["https://example.com/"]);
    expect(plan.skipped.map((s) => s.url)).toEqual([
      "https://example.com/%61dmin",
      "https://example.com/%64elete",
      "https://example.com/%61pi/users",
    ]);
    for (const skip of plan.skipped) {
      expect(skip.reason === "destructive" || skip.reason === "non-html").toBe(true);
    }
    // Specifically: the two destructive-word paths get 'destructive', the
    // /api/ path gets 'non-html'.
    expect(plan.skipped[0].reason).toBe("destructive");
    expect(plan.skipped[1].reason).toBe("destructive");
    expect(plan.skipped[2].reason).toBe("non-html");
  });
});

describe("planRepresentativeCrawl: plan-shape invariants", () => {
  it("every route has a url and a known reason; every skipped has a url and a known reason", () => {
    const plan = planRepresentativeCrawl({
      startUrl: "https://example.com/app",
      discoveredUrls: [
        "https://example.com/page",
        "https://other.test/", // cross-origin
        "https://example.com/api/x", // non-html
        "https://example.com/logout", // destructive
        "https://example.com/page", // duplicate
      ],
    });
    const routeReasons = new Set(["user-supplied", "discovered", "user-included"]);
    const skipReasons = new Set(["cross-origin", "non-html", "destructive", "excluded", "duplicate", "budget"]);
    for (const r of plan.routes) {
      expect(typeof r.url).toBe("string");
      expect(r.url.length).toBeGreaterThan(0);
      expect(routeReasons.has(r.reason)).toBe(true);
    }
    for (const s of plan.skipped) {
      expect(typeof s.url).toBe("string");
      expect(s.url.length).toBeGreaterThan(0);
      expect(skipReasons.has(s.reason)).toBe(true);
    }
  });

  it("exposes the origin and the (capped) maxRoutes on the plan", () => {
    const plan = planRepresentativeCrawl({
      startUrl: "https://example.com/app",
      discoveredUrls: [],
      maxRoutes: 100,
    });
    expect(plan.origin).toBe("https://example.com");
    expect(plan.maxRoutes).toBe(30);
  });
});
