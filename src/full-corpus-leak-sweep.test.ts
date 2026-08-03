import { describe, expect, it } from "vitest";
import { createUiSpecForAdapter } from "./create-ui-spec.js";
import { loadCorpus } from "./corpus.js";
import type { CorpusReader } from "./corpus-reader.js";
import type { CorpusEntryT } from "./schema.js";

// ---------------------------------------------------------------------------
// Full-corpus leak sweep (plan Task 7 Step 3), committed so the guard is
// reproducible and survives as a test. The real corpus (corpus/entries.json)
// is gitignored — it references private images and critique IP — so this block
// self-skips where the real corpus is absent (CI) and runs wherever it exists.
//
// SCOPE (deliberate, same as the PR review's measured sweep):
//  - Checks the C3 prose-guarded positions: designDirection, techniques[].text
//    + sourceIds, antiPatterns[].text + sourceIds, contentVoiceGuidance,
//    accessibilityConstraints[].
//  - The six dictionary-word product names (Origin/Hive/People/Projects/
//    Mercury/Untitled) are the design spec's documented global-list exclusion
//    (caught only by the precise own-entry check), so they are excluded here.
//  - The pre-existing sanitized evidence summary interpolates structuredFacts
//    including typePairing font names ("Alan Sans" for the "Alan" product);
//    that channel predates the C3 screen and typePairing is an intended served
//    signal (design spec §1B) — it is NOT part of the C3 prose surface (PR
//    review finding #4, tracked in TODOS.md).
// ---------------------------------------------------------------------------

const DICTIONARY_WORD_PRODUCT_NAMES = new Set([
  "origin", "hive", "people", "projects", "mercury", "untitled",
]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasWord(text: string, name: string): boolean {
  return new RegExp(`(?:^|[^\\w])${escapeRegExp(name)}(?:$|[^\\w])`, "i").test(text);
}

const BRIEF = "A calm analytics dashboard for a fintech company";

function readerFor(entry: CorpusEntryT, corpus: readonly CorpusEntryT[]): CorpusReader {
  return {
    search: async () => [],
    searchRanked: async () => [{ entry, score: 5, searchMode: "keyword" }],
    getById: () => undefined,
    findSimilar: () => [],
    listCategories: () => [],
    listStyleTags: () => [],
    listDomainTags: () => [],
    indexStatus: () => ({ indexed: 0, total: 1, hasIndex: false, missing: 1, stale: 0, contentStale: 0 }),
    entriesForAggregation: () => corpus,
    resolveImagePath: () => null,
  } as CorpusReader;
}

describe("full-corpus leak sweep (local data)", () => {
  const corpus = loadCorpus();
  const realCorpusPresent = corpus.length > 100;
  const itReal = realCorpusPresent ? it : it.skip;

  itReal("no identity survives in the served prose positions across every corpus entry", async () => {
    const identity = corpus.map((e) => ({
      id: String(e.id ?? ""),
      productName: String(e.source?.productName ?? ""),
      title: String(e.title ?? ""),
      imagePath: String(e.image?.path ?? ""),
      sourceUrl: String(e.source?.url ?? ""),
    })).filter((id) => !DICTIONARY_WORD_PRODUCT_NAMES.has(id.productName.toLowerCase()));

    const prosePositions = (spec: { designDirection?: string | null; techniques?: { text: string; sourceIds: string[] }[]; antiPatterns?: { text: string; sourceIds: string[] }[]; contentVoiceGuidance?: string | null; accessibilityConstraints?: string[] }): string =>
      [
        spec.designDirection ?? "",
        ...(spec.techniques ?? []).flatMap((t) => [t.text, ...(t.sourceIds ?? [])]),
        ...(spec.antiPatterns ?? []).flatMap((a) => [a.text, ...(a.sourceIds ?? [])]),
        spec.contentVoiceGuidance ?? "",
        ...(spec.accessibilityConstraints ?? []),
      ].join("\n");

    let failures = 0;
    for (const entry of corpus) {
      const out = await createUiSpecForAdapter(
        { productContext: BRIEF, referenceIds: [], constraints: [], motionIntents: [] },
        { reader: readerFor(entry, corpus), resolveReferenceToken: () => undefined },
      );
      const served = prosePositions(out.envelope.spec);
      for (const id of identity) {
        if (id.productName && hasWord(served, id.productName)) {
          console.error(`LEAK [${entry.id}] productName "${id.productName}" from ${id.id}`);
          failures++;
        }
        if (id.title && hasWord(served, id.title)) {
          console.error(`LEAK [${entry.id}] title "${id.title}" from ${id.id}`);
          failures++;
        }
        if (id.id && hasWord(served, id.id)) {
          console.error(`LEAK [${entry.id}] id "${id.id}" from ${id.id}`);
          failures++;
        }
        if (id.imagePath && served.includes(id.imagePath)) {
          console.error(`LEAK [${entry.id}] imagePath "${id.imagePath}" from ${id.id}`);
          failures++;
        }
        if (id.sourceUrl && served.includes(id.sourceUrl)) {
          console.error(`LEAK [${entry.id}] sourceUrl "${id.sourceUrl}" from ${id.id}`);
          failures++;
        }
      }
    }
    expect(failures, `${failures} identity leak(s) across ${corpus.length} entries`).toBe(0);
  }, 120_000);
});
