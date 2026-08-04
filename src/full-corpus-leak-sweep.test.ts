import { describe, expect, it } from "vitest";
import { createUiSpecForAdapter } from "./create-ui-spec.js";
import { loadCorpus } from "./corpus.js";
import type { CorpusReader } from "./corpus-reader.js";
import type { CorpusEntryT } from "./schema.js";

// ---------------------------------------------------------------------------
// Leak sweep (plan Task 7 Step 3), committed so the guard is reproducible and
// survives as a test. TWO ARMS, because the real corpus (corpus/entries.json)
// is gitignored — it references private images and critique IP:
//
//  1. SYNTHETIC — runs everywhere, including CI. It carries its own
//     identity-bearing corpus (six products, twelve entries), with product
//     names, titles, ids, image paths, URLs and schemeless hosts planted inside
//     the prose fields C3 serves, and each entry's prose naming a DIFFERENT
//     product so the corpus-wide list is what has to catch it — the exact shape
//     of the Task 7 bug. Verified by deletion: stubbing out the corpus-wide
//     name check fails all four sweep arms.
//  2. REAL — self-skips where the private corpus is absent, runs wherever it
//     exists (787 entries at the time of writing).
//
// Both arms sweep single-entry matches AND five-entry windows. Five is what
// production retrieval returns, and the composed contentVoiceGuidance is
// assembled ACROSS entries, so a single-entry sweep cannot exercise it.
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

function readerFor(top: readonly CorpusEntryT[], corpus: readonly CorpusEntryT[]): CorpusReader {
  return {
    search: async () => [],
    searchRanked: async () => top.map((entry) => ({ entry, score: 5, searchMode: "keyword" })),
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

interface Identity {
  readonly id: string;
  readonly productName: string;
  readonly title: string;
  readonly imagePath: string;
  readonly sourceUrl: string;
}

function identitiesOf(corpus: readonly CorpusEntryT[]): Identity[] {
  return corpus
    .map((e) => ({
      id: String(e.id ?? ""),
      productName: String(e.source?.productName ?? ""),
      title: String(e.title ?? ""),
      imagePath: String(e.image?.path ?? ""),
      sourceUrl: String(e.source?.url ?? ""),
    }))
    .filter((id) => !DICTIONARY_WORD_PRODUCT_NAMES.has(id.productName.toLowerCase()));
}

interface ServedSpec {
  readonly designDirection?: string | null;
  readonly techniques?: readonly { text: string; sourceIds: string[] }[];
  readonly antiPatterns?: readonly { text: string; sourceIds: string[] }[];
  readonly contentVoiceGuidance?: string | null;
  readonly accessibilityConstraints?: readonly string[];
}

function prosePositions(spec: ServedSpec): string {
  return [
    spec.designDirection ?? "",
    ...(spec.techniques ?? []).flatMap((t) => [t.text, ...(t.sourceIds ?? [])]),
    ...(spec.antiPatterns ?? []).flatMap((a) => [a.text, ...(a.sourceIds ?? [])]),
    spec.contentVoiceGuidance ?? "",
    ...(spec.accessibilityConstraints ?? []),
  ].join("\n");
}

function leaksIn(served: string, label: string, identity: readonly Identity[]): string[] {
  const found: string[] = [];
  for (const id of identity) {
    if (id.productName && hasWord(served, id.productName))
      found.push(`[${label}] productName "${id.productName}" from ${id.id}`);
    if (id.title && hasWord(served, id.title))
      found.push(`[${label}] title "${id.title}" from ${id.id}`);
    if (id.id && hasWord(served, id.id))
      found.push(`[${label}] id "${id.id}" from ${id.id}`);
    if (id.imagePath && served.includes(id.imagePath))
      found.push(`[${label}] imagePath "${id.imagePath}" from ${id.id}`);
    if (id.sourceUrl && served.includes(id.sourceUrl))
      found.push(`[${label}] sourceUrl "${id.sourceUrl}" from ${id.id}`);
  }
  return found;
}

/**
 * The C3 trust gate serves corpus prose only from entries carrying a
 * `provenance.verification` record, and no real corpus entry carries one yet.
 * This sweep's subject is the IDENTITY screen, which the plan's global
 * constraints keep independent of trust ("the trust gate runs first; screenProse
 * is unchanged and still drops identity-bearing prose from trusted entries"), so
 * every entry is stamped verified IN MEMORY before serving.
 *
 * Without this the sweep would pass by serving nothing — vacuously green, and
 * exactly the false confidence the "not passing by serving nothing" case exists
 * to catch. Nothing is written back to `corpus/entries.json`; the stamp lives on
 * a shallow copy for the duration of one serve.
 */
function asVerified(entries: readonly CorpusEntryT[]): CorpusEntryT[] {
  return entries.map((e) => ({
    ...e,
    provenance: {
      ...(e.provenance ?? { taggedBy: "auto" as const }),
      verification: {
        method: "image-confirmed" as const,
        verifiedAt: "2026-08-04",
        verifierVersion: "leak-sweep-fixture",
        imageSha256: "a".repeat(64),
      },
    },
  }));
}

async function serveProse(top: readonly CorpusEntryT[], corpus: readonly CorpusEntryT[]): Promise<string> {
  const out = await createUiSpecForAdapter(
    { productContext: BRIEF, referenceIds: [], constraints: [], motionIntents: [] },
    { reader: readerFor(asVerified(top), corpus), resolveReferenceToken: () => undefined },
  );
  return prosePositions(out.envelope.spec as ServedSpec);
}

// ---------------------------------------------------------------------------
// Synthetic arm — RUNS EVERYWHERE, INCLUDING CI
// ---------------------------------------------------------------------------
//
// The real-corpus arm below self-skips on a fresh clone, so on CI the screen
// had no executing guard at all. This arm carries its own identity-bearing
// corpus so the sweep is a real check in every environment: product names,
// titles, ids, image paths, URLs and schemeless hosts are planted INSIDE the
// prose fields that C3 serves, across entries, so a screen that only checked
// the source entry (the Task 7 bug) fails here.

const SYNTHETIC_PRODUCTS = ["Zephyrine", "Kalliope", "Nautibus", "Vermillio", "Obsidiant", "Quorvex"];

function syntheticCorpus(): CorpusEntryT[] {
  const entries: CorpusEntryT[] = [];
  SYNTHETIC_PRODUCTS.forEach((product, p) => {
    for (let n = 0; n < 2; n += 1) {
      // Each entry's prose names a DIFFERENT product, so the corpus-wide list
      // is what has to catch it — not the own-entry check.
      const other = SYNTHETIC_PRODUCTS[(p + 1) % SYNTHETIC_PRODUCTS.length];
      entries.push({
        id: `synthetic-${product.toLowerCase()}-${n}`,
        title: `${product} — analytics workspace`,
        patternType: "dashboard",
        source: {
          productName: product,
          url: `https://${product.toLowerCase()}.example.com/screens/${n}`,
          kind: "screenshot",
          capturedAt: "2026-01-01",
          licenseStatus: "private",
          attribution: "Synthetic",
        },
        image: { visibility: "private", path: `images-private/${product.toLowerCase()}-${n}.png`, width: 1280, height: 800 },
        // One clean row per field so the arm cannot pass by serving nothing,
        // plus one row per identity channel that MUST be dropped.
        whatToSteal: [
          "Group the metric tiles on a single baseline so scanning stays cheap.",
          `Copy the way ${other} anchors its filter rail to the chart region.`,
          `See ${product} for the original treatment.`,
          `Reference screens live at images-private/${product.toLowerCase()}-${n}.png.`,
          `Full flow at https://${product.toLowerCase()}.example.com/screens/${n}.`,
          `More at ${product.toLowerCase()}.example.com/screens.`,
          `The synthetic-${product.toLowerCase()}-${n} entry records the same pattern.`,
        ],
        antiPatterns: {
          antiPatterns: [
            "Avoid stacking two shadow depths in one card.",
            `Unlike ${other}, this buries the primary action below the fold.`,
          ],
          whereThisFails: [],
          accessibilityRisks: [
            { element: "Secondary label", risk: "Muted text falls below 4.5:1 on the surface tint.", evidence: "visible", confidence: "visible", wcag: ["1.4.3"] },
            { element: "Filter chip", risk: `Chip labels repeat the ${other} wording and lose meaning out of context.`, evidence: "visible", confidence: "visible", wcag: ["1.4.3"] },
          ],
        },
        categories: ["dashboard"],
        styleTags: ["minimal"],
        components: ["kpi-card"],
        responsiveBehavior: "responsive",
        mood: "calm and measured",
        colorScheme: "light",
        visual: {
          typePairing: { display: "Inter", body: "Inter", notes: "Weight contrast carries the hierarchy without a second family." },
          colorRoles: { canvas: "#ffffff", surface: "#f8fafc", ink: "#111827", muted: "#6b7280", accent: "#2563eb" },
        },
        voice: {
          tone: "Plain and unhurried",
          examples: ["Nothing to review right now — we will tell you when there is."],
          avoid: [`Do not borrow the ${other} exclamation style for financial figures.`],
        },
        critique: `A synthetic critique long enough to satisfy the schema minimum. It states the layout reasoning plainly and, deliberately, mentions ${other} so the corpus-wide screen has something to catch.`,
        qualityScore: 4,
        qualityTier: "exceptional",
        reviewStatus: "approved",
        addedAt: "2026-01-01",
      } as unknown as CorpusEntryT);
    }
  });
  return entries;
}

describe("leak sweep — synthetic corpus (runs in CI)", () => {
  const corpus = syntheticCorpus();
  const identity = identitiesOf(corpus);

  it("drops every identity channel, one entry at a time", async () => {
    const leaks: string[] = [];
    for (const entry of corpus) {
      leaks.push(...leaksIn(await serveProse([entry], corpus), String(entry.id), identity));
    }
    expect(leaks, leaks.join("\n")).toEqual([]);
  }, 120_000);

  // Production retrieval returns up to five product-diverse entries, and the
  // composed contentVoiceGuidance is assembled ACROSS them. A single-entry
  // sweep cannot exercise that composition at all.
  it("drops every identity channel with five entries matched at once", async () => {
    const leaks: string[] = [];
    for (let i = 0; i + 5 <= corpus.length; i += 5) {
      const window = corpus.slice(i, i + 5);
      leaks.push(...leaksIn(await serveProse(window, corpus), `window-${i}`, identity));
    }
    expect(leaks, leaks.join("\n")).toEqual([]);
  }, 120_000);

  it("still serves the clean rows — the sweep is not passing by serving nothing", async () => {
    const served = await serveProse(corpus.slice(0, 5), corpus);
    expect(served).toContain("Group the metric tiles on a single baseline");
    expect(served).toContain("Avoid stacking two shadow depths");
    expect(served).toContain("Muted text falls below 4.5:1");
    expect(served).toContain("Plain and unhurried");
  }, 120_000);
});

describe("full-corpus leak sweep (local data)", () => {
  const corpus = loadCorpus();
  const realCorpusPresent = corpus.length > 100;
  const itReal = realCorpusPresent ? it : it.skip;
  const identity = realCorpusPresent ? identitiesOf(corpus) : [];

  itReal("no identity survives in the served prose positions across every corpus entry", async () => {
    const leaks: string[] = [];
    for (const entry of corpus) {
      leaks.push(...leaksIn(await serveProse([entry], corpus), String(entry.id), identity));
    }
    expect(leaks, `${leaks.length} identity leak(s) across ${corpus.length} entries:\n${leaks.slice(0, 20).join("\n")}`).toEqual([]);
  }, 120_000);

  itReal("no identity survives with five real entries matched at once", async () => {
    const leaks: string[] = [];
    for (let i = 0; i + 5 <= corpus.length; i += 5) {
      leaks.push(...leaksIn(await serveProse(corpus.slice(i, i + 5), corpus), `window-${i}`, identity));
    }
    expect(leaks, `${leaks.length} identity leak(s) across ${corpus.length} entries:\n${leaks.slice(0, 20).join("\n")}`).toEqual([]);
  }, 120_000);
});
