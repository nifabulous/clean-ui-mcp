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

  it("drops a string naming a different corpus product", () => {
    expect(screenProse("unlike Superhuman's triage", other, names)).toBeNull();
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
});

// ---------------------------------------------------------------------------
// Full-corpus characterization (local data only)
// ---------------------------------------------------------------------------
//
// CHARACTERIZATION NUMBERS, NOT REQUIREMENTS (plan Task 3 Step 3). The real
// corpus (corpus/entries.json, 787 entries) is gitignored — it references
// private images and critique IP — so this block runs only where the real
// corpus is present and skips on a fresh clone/CI (where loadCorpus returns
// the 1-entry seed). The bands make a future change to the denied-name list
// visible: adding or removing an exclusion moves the counts by far more than
// the band width.
//
// The plan's draft bands (34/21/52) were measured against a smaller corpus
// (77 distinct product names). The current corpus has 93 distinct
// source.productName values (82 distinctive after the six dictionary-word
// exclusions), so the measured rates are higher; bands below are the current
// measurements (38/32/61) ± 5.

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
    expect(antiPatternsDrops).toBeGreaterThanOrEqual(27);
    expect(antiPatternsDrops).toBeLessThanOrEqual(37);
    expect(critiqueDrops).toBeGreaterThanOrEqual(56);
    expect(critiqueDrops).toBeLessThanOrEqual(66);
  });
});
