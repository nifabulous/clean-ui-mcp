import { describe, expect, it } from "vitest";
import {
  isBannedAggregatorHost,
  buildCaptureSources,
  buildGenerationPrompt,
  buildReport,
  buildScoringPrompt,
  computeGaps,
  decideAcceptance,
  dedupeCandidates,
  isReachableStatus,
  metadataAcceptable,
  normalizeHost,
  normalizeUrl,
  parseCandidates,
  parseScore,
  readCapped,
  type Candidate,
  type CorpusEntry,
  type SuitabilityScore,
  type Verification,
} from "./scout-sources.js";

const sampleEntries: CorpusEntry[] = [
  { patternType: "dashboard", categories: ["dashboard"], styleTags: ["minimal"], source: { productName: "Linear", url: "https://linear.app" } },
  { patternType: "dashboard", categories: ["dashboard", "data-table"], styleTags: ["minimal", "dense-data"], source: { productName: "Vercel", url: "https://vercel.com/dashboard" } },
  { patternType: "pricing", categories: ["pricing"], styleTags: ["editorial"], industryVertical: "fintech", source: { productName: "Stripe", url: "https://stripe.com/pricing" } },
  { patternType: "auth", categories: ["auth"], styleTags: ["minimal"], source: { productName: "Supabase", url: "https://supabase.com" } },
];

describe("normalizeHost / normalizeUrl", () => {
  it("strips www and lowercases hosts", () => {
    expect(normalizeHost("https://www.Linear.app")).toBe("linear.app");
    expect(normalizeHost("https://linear.app:8443/foo")).toBe("linear.app");
  });

  it("normalizes URLs to host + path without trailing slash", () => {
    expect(normalizeUrl("https://www.linear.app/")).toBe("linear.app");
    expect(normalizeUrl("https://linear.app/dashboard/")).toBe("linear.app/dashboard");
  });
});

describe("computeGaps", () => {
  it("counts entries per pattern/category/style/industry and sorts rarest first", () => {
    const gaps = computeGaps(sampleEntries);
    const pricing = gaps.find((g) => g.dimension === "patternType" && g.value === "pricing");
    expect(pricing?.count).toBe(1);
    const auth = gaps.find((g) => g.dimension === "patternType" && g.value === "auth");
    expect(auth?.count).toBe(1);
    const dashboard = gaps.find((g) => g.dimension === "patternType" && g.value === "dashboard");
    expect(dashboard?.count).toBe(2);
    const dense = gaps.find((g) => g.dimension === "styleTag" && g.value === "dense-data");
    expect(dense?.count).toBe(1);
    const fintech = gaps.find((g) => g.dimension === "industryVertical" && g.value === "fintech");
    expect(fintech?.count).toBe(1);
    // rarity ordering: everything with count 1 sorts before count 2
    const first = gaps[0];
    expect(first.count).toBeLessThanOrEqual(gaps[gaps.length - 1].count);
  });

  it("prioritizes explicitly targeted values even when well covered", () => {
    const gaps = computeGaps(sampleEntries, [{ dimension: "patternType", value: "dashboard" }]);
    expect(gaps[0]).toMatchObject({ dimension: "patternType", value: "dashboard", count: 2 });
  });

  it("reports zero for requested values absent from the corpus", () => {
    const gaps = computeGaps(sampleEntries, [{ dimension: "styleTag", value: "glassmorphic" }]);
    expect(gaps).toContainEqual({ dimension: "styleTag", value: "glassmorphic", count: 0 });
  });
});

describe("isBannedAggregatorHost — the ToS/redistribution denylist is ENFORCED, not just documented", () => {
  it("bans the named aggregators", () => {
    for (const u of [
      "https://mobbin.com/screens", "https://dribbble.com/shots",
      "https://www.behance.net/gallery", "https://awwwards.com/sites",
      "https://land-book.com/x",
    ]) expect(isBannedAggregatorHost(u), u).toBe(true);
  });

  it("cannot be bypassed by subdomain, case, trailing dot, or port", () => {
    for (const u of [
      "https://MOBBIN.com", "https://app.mobbin.com/x", "https://mobbin.com./x",
      "https://dribbble.com:443/shots",
    ]) expect(isBannedAggregatorHost(u), u).toBe(true);
  });

  it("allows real product sites", () => {
    for (const u of ["https://linear.app", "https://stripe.com/pricing", "https://notmobbin.example.com"]) {
      expect(isBannedAggregatorHost(u), u).toBe(false);
    }
  });

  it("treats an unparseable URL as not-a-known-aggregator (verifyCandidate still SSRF/robots-gates it)", () => {
    expect(isBannedAggregatorHost("not a url")).toBe(false);
  });
});

describe("parseCandidates drops banned aggregators", () => {
  it("removes an aggregator the model proposed anyway, with a reason", () => {
    const { kept, dropped } = parseCandidates(
      '[{"url":"https://mobbin.com/x","sourceName":"Mobbin"},{"url":"https://linear.app","sourceName":"Linear"}]',
    );
    expect(kept.map((c) => c.sourceName)).toEqual(["Linear"]);
    expect(dropped.some((d) => /aggregator|banned/i.test(String(d.reason)))).toBe(true);
  });
});

describe("parseCandidates", () => {
  it("parses a fenced JSON array", () => {
    const { kept, dropped } = parseCandidates(`\`\`\`json
[{"url": "https://example.com", "sourceName": "Example", "rationale": "nice hero", "expectedPattern": "landing-page"}]
\`\`\``);
    expect(dropped).toEqual([]);
    expect(kept).toEqual([
      { url: "https://example.com/", sourceName: "Example", rationale: "nice hero", expectedPattern: "landing-page", cautionary: false },
    ]);
  });

  it("drops invalid URLs, non-http(s) URLs, and missing names", () => {
    const { kept, dropped } = parseCandidates(JSON.stringify([
      { url: "not-a-url", sourceName: "Bad" },
      { url: "ftp://example.com/x", sourceName: "Ftp" },
      { url: "https://example.com", sourceName: "  " },
      { url: "https://ok.com", sourceName: "OK" },
    ]));
    expect(kept).toHaveLength(1);
    expect(kept[0].sourceName).toBe("OK");
    expect(dropped).toHaveLength(3);
  });

  it("returns a dropped record when the response is not JSON at all", () => {
    const { kept, dropped } = parseCandidates("Here are some ideas: https://example.com");
    expect(kept).toEqual([]);
    expect(dropped).toHaveLength(1);
  });
});

describe("dedupeCandidates", () => {
  const candidates: Candidate[] = [
    { url: "https://linear.app", sourceName: "Linear" },
    { url: "https://www.vercel.com/something-else", sourceName: "Vercel Again" },
    { url: "https://stripe.com", sourceName: "Stripe" },
    { url: "https://fresh-site.com", sourceName: "Fresh Site" },
  ];

  it("drops exact URL, hostname, and product-name collisions with the corpus", () => {
    const { kept, dropped } = dedupeCandidates(candidates, sampleEntries);
    expect(kept.map((c) => c.sourceName)).toEqual(["Fresh Site"]);
    expect(dropped.map((d) => d.reason)).toContain("exact URL already in corpus/prior sources: https://linear.app");
    expect(dropped.map((d) => d.reason)).toContain("domain already in corpus/prior sources: vercel.com");
  });

  it("drops product-name collisions even when the domain differs", () => {
    const { dropped } = dedupeCandidates(
      [{ url: "https://stripe.co", sourceName: "Stripe" }],
      sampleEntries,
    );
    expect(dropped[0].reason).toBe("product name already in corpus/prior sources: Stripe");
  });

  it("drops duplicates against prior sources in the same run", () => {
    const { kept } = dedupeCandidates(
      [
        { url: "https://brand-new.com", sourceName: "Brand New" },
        { url: "https://www.brand-new.com/pricing", sourceName: "Brand New Pricing" },
      ],
      [],
    );
    expect(kept).toHaveLength(1);
  });
});

describe("buildCaptureSources", () => {
  it("emits capture-batch-compatible entries with a note carrying scout metadata", () => {
    const sources = buildCaptureSources([
      {
        candidate: {
          url: "https://example.com/pricing",
          sourceName: "Example",
          rationale: "Transparent tier comparison",
          expectedPattern: "pricing",
          expectedCategories: ["pricing"],
          expectedStyleTags: ["editorial"],
        },
        score: { verdict: "suitable", suitability: 4, matchesGap: true, reasons: ["clear"], cautionary: false } as SuitabilityScore,
      },
    ]);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      url: "https://example.com/pricing",
      sourceName: "Example",
    });
    expect(sources[0].note).toContain("expectedPattern=pricing");
    expect(sources[0].note).toContain("scoutVerdict=suitable(4/5)");
  });

  it("marks cautionary candidates skipAutoConsent", () => {
    const sources = buildCaptureSources([
      { candidate: { url: "https://bad.example.com", sourceName: "Bad Example", rationale: "", cautionary: true }, score: null },
    ]);
    expect(sources[0].skipAutoConsent).toBe(true);
  });
});

describe("decideAcceptance / parseScore", () => {
  const makeScore = (overrides: Partial<SuitabilityScore>): SuitabilityScore => ({
    url: "https://example.com",
    suitability: 4,
    verdict: "suitable",
    matchesGap: true,
    reasons: [],
    cautionary: false,
    raw: "",
    ...overrides,
  });

  it("accepts suitable >= 3, rejects unsuitable, and defers uncertain", () => {
    expect(decideAcceptance(makeScore({})).accepted).toBe(true);
    expect(decideAcceptance(makeScore({ suitability: 3 })).accepted).toBe(true);
    expect(decideAcceptance(makeScore({ suitability: 2, verdict: "suitable" })).accepted).toBe(false);
    expect(decideAcceptance(makeScore({ verdict: "unsuitable", suitability: 2 })).accepted).toBe(false);
    expect(decideAcceptance(makeScore({ verdict: "uncertain", suitability: 3 })).accepted).toBe(false);
  });

  it("parses score JSON and rejects malformed responses", () => {
    const parsed = parseScore("https://example.com", JSON.stringify({
      suitability: 5,
      verdict: "suitable",
      matchesGap: true,
      reasons: ["bold typography hierarchy"],
      proposedPattern: "landing-page",
      proposedCategories: ["marketing-hero"],
      proposedStyleTags: ["editorial"],
      cautionary: false,
    }));
    expect(parsed?.suitability).toBe(5);
    expect(parsed?.verdict).toBe("suitable");
    expect(parsed?.proposedPattern).toBe("landing-page");
    expect(parseScore("https://example.com", "not json")).toBeNull();
    expect(parseScore("https://example.com", JSON.stringify({ suitability: 9, verdict: "maybe" }))).toBeNull();
  });
});

describe("prompt/report builders", () => {
  it("generation prompt bans gallery sites and lists gaps", () => {
    const prompt = buildGenerationPrompt({
      gaps: [{ dimension: "patternType", value: "pricing", count: 1 }],
      existing: { products: ["Linear"], hosts: ["linear.app"] },
      maxCandidates: 5,
      patterns: ["pricing"],
      categories: ["pricing"],
      styles: ["editorial"],
    });
    expect(prompt).toContain('patternType "pricing" — 1');
    expect(prompt).toContain("Mobbin");
    expect(prompt).toContain("linear.app");
  });

  it("scoring prompt names the target gap", () => {
    const prompt = buildScoringPrompt({
      candidate: { url: "https://example.com", sourceName: "Example", rationale: "x", expectedPattern: "pricing" },
      verification: { url: "https://example.com", sourceName: "Example", reachable: true, status: 200, finalUrl: "https://example.com", title: "Pricing", description: null, robotsAllowed: true, screenshotPath: null, error: null },
      gaps: [{ dimension: "patternType", value: "pricing", count: 1 }],
    });
    expect(prompt).toContain('patternType "pricing"');
    expect(prompt).toContain("cautionary");
  });

  it("report includes accepted, rejected, uncertain, and next steps", () => {
    const report = buildReport({
      gaps: [{ dimension: "patternType", value: "pricing", count: 1 }],
      generated: [],
      generatedDropped: [],
      dropped: [],
      verified: [],
      rejected: [],
      uncertain: [],
      accepted: [{
        candidate: { url: "https://example.com/pricing", sourceName: "Example", rationale: "Clear tiers" },
        verification: { url: "https://example.com/pricing", sourceName: "Example", reachable: true, status: 200, finalUrl: "https://example.com/pricing", title: "Example Pricing", description: null, robotsAllowed: true, screenshotPath: null, error: null },
        score: null,
      }],
      noVision: true,
      runId: "test-run",
    });
    expect(report).toContain("Example");
    expect(report).toContain("npm run capture-batch");
    expect(report).toContain("metadata-only");
  });
});

describe("isReachableStatus — only 2xx is reachable", () => {
  it("accepts 2xx and refuses every 3xx/4xx/5xx and null", () => {
    expect(isReachableStatus(200)).toBe(true);
    expect(isReachableStatus(204)).toBe(true);
    // A 3xx without a Location, or the redirect-loop-exhausted response, must
    // NOT be marked reachable — the old check let every 300-399 through.
    expect(isReachableStatus(301)).toBe(false);
    expect(isReachableStatus(304)).toBe(false);
    expect(isReachableStatus(399)).toBe(false);
    expect(isReachableStatus(400)).toBe(false);
    expect(isReachableStatus(500)).toBe(false);
    expect(isReachableStatus(null)).toBe(false);
  });
});

describe("readCapped — bounded reads", () => {
  it("returns an empty string when the response has no body", async () => {
    const res = new Response(null, { status: 200 });
    expect(await readCapped(res, 1024)).toBe("");
  });

  it("caps a large streamed body at the byte budget", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("x".repeat(10_000)));
        controller.close();
      },
    });
    const res = new Response(stream, { status: 200 });
    const out = await readCapped(res, 1024);
    expect(out.length).toBe(1024);
  });
});

describe("metadataAcceptable — the metadata-only content gate", () => {
  const base = (over: Partial<Verification> = {}): Verification => ({
    url: "https://example.com",
    sourceName: "Example",
    reachable: true,
    status: 200,
    finalUrl: "https://example.com",
    title: "Example",
    description: null,
    robotsAllowed: true,
    screenshotPath: null,
    error: null,
    ...over,
  });

  it("accepts a reachable, robots-allowed page with an extracted title", () => {
    expect(metadataAcceptable(base())).toBe(true);
  });

  it("refuses a page with no title — a binary 200 (PDF/image) has no <title>", () => {
    expect(metadataAcceptable(base({ title: null }))).toBe(false);
  });

  it("refuses an unreachable or robots-disallowed page", () => {
    expect(metadataAcceptable(base({ reachable: false }))).toBe(false);
    expect(metadataAcceptable(base({ robotsAllowed: false }))).toBe(false);
  });
});
