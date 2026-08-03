import { describe, expect, it } from "vitest";
import { buildDeniedNames, screenProse } from "./corpus-prose-screen.js";
import { loadCorpus } from "./corpus.js";
import type { CorpusEntryT } from "./schema.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

interface FixtureEntry extends Partial<CorpusEntryT> {
  id: string;
  title: string;
  source: { productName: string };
  critique: string;
  whatToSteal: string[];
  antiPatterns: { antiPatterns: string[]; whereThisFails: string[] };
}

function entryNamed(productName: string, title = `${productName} — fixture`): FixtureEntry {
  return {
    id: "fixture",
    title,
    source: { productName },
    critique: "x".repeat(80),
    whatToSteal: ["stealable prose"],
    antiPatterns: { antiPatterns: [], whereThisFails: [] },
  } as FixtureEntry;
}

// ---------------------------------------------------------------------------
// Identity screen (design spec §3)
// ---------------------------------------------------------------------------

describe("screenProse — identity screen", () => {
  const mobbin = entryNamed("Mobbin");
  const other = entryNamed("Other");
  const superhuman = entryNamed("Superhuman");
  const names = buildDeniedNames([mobbin, other, superhuman]);

  it("drops a string naming its own entry's product", () => {
    expect(screenProse("How Mobbin works is the hook", mobbin, names)).toBeNull();
  });

  it("drops a string containing its own entry's corpus id", () => {
    // §2c: the corpus entry id is never served, including when prose embeds it
    // (the public-MCP contract fixture embeds the id in whatToSteal).
    const withId = { ...mobbin, id: "internal-mobbin-7" } as unknown as CorpusEntryT;
    expect(screenProse("Copy the internal-mobbin-7 grid", withId, names)).toBeNull();
  });

  it("drops a string naming a different corpus product", () => {
    expect(screenProse("unlike Superhuman's triage", other, names)).toBeNull();
  });

  it("drops a string naming a product whose name ends in a non-word character", () => {
    // "SLMobbin!" — \b…\b never matches a name ending in a non-word char (no
    // word/non-word transition after "!"); the explicit non-word boundary does.
    const slmobbin = { ...other, source: { productName: "SLMobbin!" } } as unknown as CorpusEntryT;
    const withName = buildDeniedNames([slmobbin]);
    expect(screenProse("the SLMobbin! design", other, withName)).toBeNull();
  });

  it("does not match a product name inside a longer word", () => {
    expect(screenProse("mobbinology is a made-up word", other, names)).not.toBeNull();
  });

  it("keeps a dictionary-word product name used as an ordinary noun", () => {
    // "Projects" is a corpus product name AND an English word; matching it
    // globally would drop ~8% of good rows.
    expect(screenProse("Group projects under one nav item", other, names)).not.toBeNull();
  });

  it("drops, never redacts", () => {
    const out = screenProse("How Mobbin works", mobbin, names);
    expect(out).toBeNull(); // not "How  works"
  });

  it("still applies the private-marker sweep", () => {
    // The plan's draft example used "see corpus-abc123", which does NOT trip
    // containsPrivateMarker (verified: its markers are "private-corpus-id",
    // the three private paths and the URL/path regex). The sweep's intent is
    // unchanged — a private marker still drops the row — so the example uses a
    // string the actual marker set catches.
    expect(screenProse("see images-private/hero.png", other, names)).toBeNull();
  });

  it("drops a string containing a URL", () => {
    expect(screenProse("reference the guide at https://example.com/guides/onboarding", other, names)).toBeNull();
    expect(screenProse("visit www.example.com for details", other, names)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Full-corpus characterization (local data only)
// ---------------------------------------------------------------------------
//
// CHARACTERIZATION NUMBERS, NOT REQUIREMENTS (plan Task 3 Step 3). The real
// corpus (corpus/entries.json, 787 entries) is gitignored — it references
// private images and critique IP — so this block runs only where the real
// corpus is present and skips on a fresh clone/CI (where loadCorpus returns
// the 1-entry seed). Consequently it is NOT a CI guard: a change to the
// denied-name list is caught by this block only in environments that carry
// the corpus (PR review finding #3; the committed full-corpus leak sweep in
// src/full-corpus-leak-sweep.test.ts has the same data constraint). The bands
// make such a change visible wherever the corpus exists: adding or removing an
// exclusion moves the counts by far more than the band width.
//
// The plan's draft bands (34/21/52) were measured against a smaller corpus
// (77 distinct product names). The current corpus has 93 distinct
// source.productName values (82 distinctive after the six dictionary-word
// exclusions), so the measured rates are higher.
//
// Re-measured at 38/36/65 ± 5 after the schemeless-host pattern was widened to
// cover subdomain and email forms (PR review round 3). That widening moved
// antiPatterns 32 -> 36 and critique 61 -> 65: eight rows in the corpus carry a
// host reference, and the new hits are worth the cost. It newly drops a real
// person's address quoted from a screenshot ("lucy@yahoo.com" — PII the old
// pattern let through because it excluded "@" before the label) and keeps
// catching a real product domain ("MOBBIN.COM/SLACK"). The rows lost are ones
// quoting RFC placeholder addresses ("you@example.com", "user@domain.com");
// serving a real address would be the worse error.

describe("full-corpus characterization (local data)", () => {
  const corpus = loadCorpus();
  const realCorpusPresent = corpus.length > 100;
  const itReal = realCorpusPresent ? it : it.skip;

  itReal("drop rates stay within measured bands (characterization, not requirements)", () => {
    const denied = buildDeniedNames(corpus);
    let whatToStealDrops = 0;
    let antiPatternsDrops = 0;
    let critiqueDrops = 0;
    for (const entry of corpus) {
      if ((entry.whatToSteal ?? []).some((t) => screenProse(t, entry, denied) === null))
        whatToStealDrops++;
      if ((entry.antiPatterns?.antiPatterns ?? []).some((t) => screenProse(t, entry, denied) === null))
        antiPatternsDrops++;
      if (screenProse(entry.critique, entry, denied) === null)
        critiqueDrops++;
    }
    expect(whatToStealDrops).toBeGreaterThanOrEqual(33);
    expect(whatToStealDrops).toBeLessThanOrEqual(43);
    expect(antiPatternsDrops).toBeGreaterThanOrEqual(31);
    expect(antiPatternsDrops).toBeLessThanOrEqual(41);
    expect(critiqueDrops).toBeGreaterThanOrEqual(60);
    expect(critiqueDrops).toBeLessThanOrEqual(70);
  });
});

// ---------------------------------------------------------------------------
// Schemeless URLs (PR review round 2 minor)
// ---------------------------------------------------------------------------

describe("screenProse — schemeless URL", () => {
  const other = entryNamed("Other");
  const names = buildDeniedNames([other]);

  it("drops a bare domain with a path", () => {
    expect(screenProse("Sign up at acme.com/start to continue", other, names)).toBeNull();
  });

  it("drops a bare domain with no path", () => {
    expect(screenProse("Copy the pricing table from stripe.com", other, names)).toBeNull();
  });

  it("drops a subdomain, an email host, and a product TLD outside the base list", () => {
    // The leading guard must not exclude "." or "@", or every subdomain and
    // email form slips through a TLD the list already covers.
    expect(screenProse("Open app.acme.com to continue", other, names)).toBeNull();
    expect(screenProse("Write to hello@acme.com for access", other, names)).toBeNull();
    expect(screenProse("Flow at sub.acme.com/start", other, names)).toBeNull();
    expect(screenProse("Read the notes on paper.fm", other, names)).toBeNull();
  });

  it("keeps ordinary prose containing a period-joined word", () => {
    // The TLD list is closed so sentence-internal dots ("e.g.", "1.4.3",
    // "config.json") are not URLs and must not drop a good row.
    expect(screenProse("Meets WCAG 1.4.3 for contrast, e.g. on secondary text", other, names)).not.toBeNull();
    expect(screenProse("Mirror the spacing scale, i.e. an 8px baseline grid", other, names)).not.toBeNull();
  });
});
