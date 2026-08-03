/**
 * create-ui-spec-fixture.ts — REAL `/api/create-ui-spec` response bytes for the
 * built-site browser suite.
 *
 * WHY THIS IS NOT A HAND-WRITTEN STUB. The browser suite runs against a `vite
 * preview` server, which serves static files only, so the composer's `/api/*`
 * calls have to be intercepted. A hand-written response body would be a second,
 * independent description of the server contract — and a hand-written stub that
 * drifted from the real server has already caused a regression on this branch. So
 * this module does not describe the response: it PRODUCES it, by calling the same
 * `handleCreateUiSpecHttp` adapter the loopback route calls, over an in-memory
 * `CorpusReader`. The bytes the browser receives are therefore the bytes the real
 * route would write, including every hash and both renderings. If the envelope
 * shape changes, these fixtures change with it automatically.
 *
 * NO NETWORK, NO PROVIDER. The reader is a plain in-memory object; nothing here
 * opens a socket or reads a provider credential. This runs in the suite's node
 * process (the browser only ever sees the resulting string).
 *
 * The seeded entry carries deliberately DISTINCTIVE private values — a raw corpus
 * id, a private product name, a private source URL, an image path, critique prose
 * — so the suite's "no private marker in the serialized page" assertion is a real
 * check against material that genuinely passed through the producer.
 */
import type { CorpusReader } from "../../src/corpus-reader.js";
import type { CorpusEntryT } from "../../src/schema.js";
import { handleCreateUiSpecHttp } from "../../src/create-ui-spec-http.js";

/**
 * IDENTITY values seeded into the corpus entry. None may reach the browser, in
 * any C3 phase — corpus id, product name, source URL and image path are the
 * "never served" set (design spec §2c).
 */
export const PRIVATE_MARKERS: readonly string[] = [
  "internal-corpus-77",
  "product-Alpha-Private",
  "https://private.example.com/secret",
  "images-private/secret.png",
  "images-private",
];

/**
 * Corpus PROSE that C3 Phase 1 serves INTO THE PAGE. `critique` folds into the
 * synthesized `designDirection`, which `site/src/data/create-ui-spec.ts`
 * projects and the composer renders.
 *
 * Asserted PRESENT rather than deleted from the sweep: the identity sweep above
 * is only a real check if the entry's judgment actually reached the page, and a
 * silent regression back to withholding corpus prose should fail this suite
 * instead of passing it vacuously.
 *
 * The wording ("must never leave the server") describes the PRE-C3 posture and
 * is kept verbatim so the diff against the old `PRIVATE_MARKERS` list is
 * legible.
 */
export const PAGE_SERVED_CORPUS_PROSE: readonly string[] = [
  "critique prose that must never leave the server",
];

/**
 * Corpus prose that C3 Phase 1 serves ONLY in the handoff bytes. `whatToSteal`
 * becomes `techniques[].text`, which `renderDesignHandoffMarkdown` writes into
 * `designMarkdown` but the client projection deliberately does not read — a
 * DOWNLOAD/CLIPBOARD PAYLOAD ONLY (see the projection docblock in
 * `site/src/data/create-ui-spec.ts`). It must therefore never reach the DOM,
 * exactly like the handoff's structural markers.
 */
export const HANDOFF_ONLY_CORPUS_PROSE: readonly string[] = [
  "stealable prose that must never leave the server",
];

function seededEntry(): CorpusEntryT {
  return {
    id: "internal-corpus-77",
    title: "Untitled",
    patternType: "dashboard",
    source: {
      productName: "product-Alpha-Private",
      url: "https://private.example.com/secret",
      kind: "screenshot",
      capturedAt: "2026-01-01",
      licenseStatus: "private",
      attribution: "Private Corpus",
    },
    image: {
      visibility: "private",
      path: "images-private/secret.png",
      width: 1280,
      height: 800,
    },
    critique: "critique prose that must never leave the server",
    whatToSteal: ["stealable prose that must never leave the server"],
    antiPatterns: { antiPatterns: [], whereThisFails: [], accessibilityRisks: [] },
    categories: ["dashboard"],
    styleTags: ["minimal"],
    components: [],
    visual: {},
    qualityScore: 4,
    qualityTier: "exceptional",
    reviewStatus: "approved",
    addedAt: "2026-01-01",
  } as unknown as CorpusEntryT;
}

/** An in-memory reader. `ranked` drives whether keyword retrieval matches. */
function makeReader(ranked: readonly CorpusEntryT[]): CorpusReader {
  return {
    search: async () => [...ranked],
    searchRanked: async () =>
      ranked.map((entry) => ({ entry, score: 5, searchMode: "keyword" as const })),
    getById: () => undefined,
    findSimilar: () => [],
    listCategories: () => [],
    listStyleTags: () => [],
    listDomainTags: () => [],
    indexStatus: () => ({
      indexed: 0,
      total: ranked.length,
      hasIndex: false,
      missing: ranked.length,
      stale: 0,
      contentStale: 0,
    }),
    entriesForAggregation: () => [...ranked],
    resolveImagePath: () => null,
    getImageIndex: async () => null,
  } as unknown as CorpusReader;
}

export interface ArtifactFixture {
  /** The exact JSON string the real route would write. */
  readonly body: string;
  /** The parsed body, for hash/marker assertions in the node process. */
  readonly envelope: Record<string, unknown>;
}

/**
 * The optional request fields a fixture may carry beyond the brief. These are
 * NOT re-declared bounds — they are forwarded verbatim into the real adapter,
 * so an out-of-bounds value here produces a real 400 and this module throws.
 * The authoritative bounds live in `CreateUiSpecRequestSchema`.
 */
export interface FixtureRequestExtras {
  readonly constraints?: readonly string[];
  readonly colorIntent?: {
    readonly accentPreference?: string;
    readonly mood?: string;
    readonly contrastFloor?: "AA" | "AAA";
  };
  readonly typeIntent?: {
    readonly voice?: string;
    readonly density?: "compact" | "regular" | "spacious";
  };
}

async function produce(
  productContext: string,
  ranked: readonly CorpusEntryT[],
  extras: FixtureRequestExtras = {},
): Promise<ArtifactFixture> {
  const result = await handleCreateUiSpecHttp(
    { productContext, ...extras },
    makeReader(ranked),
  );
  if (result.status !== 200) {
    throw new Error(`fixture generation failed with status ${result.status}`);
  }
  return { body: result.body, envelope: JSON.parse(result.body) as Record<string, unknown> };
}

/**
 * A keyword-matched artifact: `retrieval.mode` is `keyword`, `fallbackUsed` is
 * false. It still carries the producer's `motionEvidenceUnavailable` warning,
 * because no motion intents were supplied — which is exactly why the composer
 * must not equate "has warnings" with "used the fallback".
 */
export function keywordMatchedArtifact(productContext: string): Promise<ArtifactFixture> {
  return produce(productContext, [seededEntry()]);
}

/**
 * A zero-match artifact: `structured-fallback` / `metadata`, `fallbackUsed` true
 * with `fallbackReason: "no-results"`. Still a servable, downloadable artifact.
 */
export function fallbackArtifact(productContext: string): Promise<ArtifactFixture> {
  return produce(productContext, []);
}

/**
 * A keyword-matched artifact carrying caller constraints and structured design
 * intent — the shape the site's intent controls produce.
 *
 * This exists because the site cannot assert "the intent I sent came back
 * honored" against a hand-written body: the bytes have to come from the real
 * producer, whose `spec.context.colorIntent` / `spec.context.typeIntent` and
 * `caller-constraint-*` acceptance criteria are the ONLY user-visible proof the
 * intent was recorded. Constraints and intent both feed `semanticSpecSha256`, so
 * a fixture built this way also carries a genuinely different artifact identity
 * from the plain-brief fixtures above.
 */
export function designIntentArtifact(
  productContext: string,
  extras: FixtureRequestExtras,
): Promise<ArtifactFixture> {
  return produce(productContext, [seededEntry()], extras);
}
