/**
 * critique-retrieval.ts — hybrid evidence retrieval for critique_ui.
 *
 * Two modes:
 * 1. Image retrieval — embed the screenshot, find nearest corpus entries in
 *    the image-embedding index (if a provider is configured AND the index
 *    exists and isn't stale).
 * 2. Structured fallback — serialize the tagger's extraction + product context
 *    into a text query and use the existing text search (searchRanked). This
 *    is the default when no image-embedding provider is configured.
 *
 * Both modes rely on searchRanked's existing default reviewStatus:"approved"
 * filter for the structured path. The image path filters approved entries
 * explicitly after retrieval.
 *
 * Platform filtering: if the input specifies a platform, entries that don't
 * match are deprioritized (not removed — cross-platform inspiration has value).
 *
 * Gate 1A, Task 4a: corpus access now flows through an injected `CorpusReader`
 * instead of importing loadCorpus/searchRanked directly. This is what lets the
 * public reader (Task 4b) filter evidence by the publication policy without
 * this module changing. The caller (the critique_ui tool handler) passes the
 * reader it received from createServer.
 */
import type { CorpusReader } from "./corpus-reader.js";
import { cosine, type ImageEmbeddingIndex } from "./image-index.js";
import type { ImageEmbeddingProvider, ValidatedImage } from "./image-embeddings.js";

export interface CritiqueEntry {
  id: string;
  patternType?: string;
  platform?: string;
  reviewStatus?: string;
  title?: string;
  score: number;
}

export type RetrievalMode = "image" | "structured-fallback";

export interface RetrievalResult {
  entries: CritiqueEntry[];
  mode: RetrievalMode;
  fallbackUsed: boolean;
  coverage: "strong" | "moderate" | "weak" | "none";
}

export interface RetrieveCritiqueInput {
  /** Corpus access (search + entriesForAggregation) — injected by the caller. */
  reader: CorpusReader;
  imageProvider: ImageEmbeddingProvider | null;
  imageData: Buffer | null; // decoded image bytes for embedding
  imageMimeType?: string; // I2 fix: the actual MIME type (was hardcoded to image/png)
  extraction: Record<string, unknown>;
  productContext?: string;
  platform?: string;
  imageIndex: ImageEmbeddingIndex | null; // pre-loaded, or null
}

const MAX_ENTRIES = 5;

/**
 * Retrieve up to 5 approved corpus entries as evidence for a screenshot critique.
 */
export async function retrieveCritiqueEvidence(input: RetrieveCritiqueInput): Promise<RetrievalResult> {
  const { reader, imageProvider, imageData, imageMimeType, extraction, productContext, platform, imageIndex } = input;

  // ── Try image retrieval first ────────────────────────────────────────────────
  if (imageProvider && imageData && imageIndex) {
    try {
      const queryVec = await imageProvider.embedImage({
        data: imageData,
        mimeType: (imageMimeType ?? "image/png") as ValidatedImage["mimeType"],
      });

      // N2 fix: runtime dimension guard — if the query vector doesn't match the
      // index's dimension, fall back to structured retrieval instead of
      // producing NaN-scored garbage rankings.
      if (queryVec.length !== imageIndex.dimension) {
        console.error(`[critique-retrieval] Dimension mismatch: query=${queryVec.length} vs index=${imageIndex.dimension}. Falling back.`);
        throw new Error("dimension mismatch");
      }

      // N3 fix: look up each ranked entry in the live corpus to verify it's
      // still approved. The image index may contain stale entries (demoted to
      // draft or deleted after indexing).
      const corpusEntries = reader.entriesForAggregation();
      const corpusById = new Map(corpusEntries.map((e) => [e.id, e]));
      const ranked = Object.entries(imageIndex.entries)
        .map(([id, entry]) => ({ id, score: cosine(queryVec, entry.vector) }))
        .sort((a, b) => b.score - a.score);

      // Filter to approved entries only — enforce the global constraint at runtime.
      const entries: CritiqueEntry[] = ranked
        .filter((r) => {
          const ce = corpusById.get(r.id);
          return ce && ce.reviewStatus === "approved";
        })
        .map((r) => {
          const ce = corpusById.get(r.id)!;
          return {
            id: r.id,
            score: r.score,
            patternType: ce.patternType,
            platform: ce.platform,
            reviewStatus: ce.reviewStatus,
            title: ce.title,
          };
        })
        .slice(0, MAX_ENTRIES);

      if (entries.length > 0) {
        const filtered = applyPlatformFilter(entries, platform);
        const coverage = classifyCoverage(filtered);
        return {
          entries: filtered,
          mode: "image",
          fallbackUsed: false,
          coverage,
        };
      }
    } catch (err) {
      console.error("[critique-retrieval] Image retrieval failed, falling back to structured:", err instanceof Error ? err.message : err);
    }
  }

  // ── Structured fallback ─────────────────────────────────────────────────────
  const query = buildStructuredQuery(extraction, productContext);
  // searchRanked's default reviewStatus:"approved" filter ensures drafts are excluded.
  const results = await reader.searchRanked({ query, limit: MAX_ENTRIES * 2 });
  const entries: CritiqueEntry[] = results.map((r) => ({
    id: r.entry.id,
    patternType: r.entry.patternType,
    platform: r.entry.platform,
    reviewStatus: r.entry.reviewStatus,
    title: r.entry.title,
    score: r.score,
  }));

  const filtered = applyPlatformFilter(entries, platform);
  const coverage = classifyCoverage(filtered);

  return {
    entries: filtered.slice(0, MAX_ENTRIES),
    mode: "structured-fallback",
    fallbackUsed: true,
    coverage,
  };
}

/** Build a text query from the extraction + product context for the fallback path. */
function buildStructuredQuery(extraction: Record<string, unknown>, productContext?: string): string {
  const parts: string[] = [];
  if (productContext) parts.push(productContext);
  const pt = typeof extraction.patternType === "string" ? extraction.patternType : "";
  if (pt) parts.push(pt);
  const cats = Array.isArray(extraction.categories) ? extraction.categories.join(" ") : "";
  if (cats) parts.push(cats);
  const components = Array.isArray(extraction.components) ? extraction.components.join(" ") : "";
  if (components) parts.push(components);
  return parts.join(" ") || "UI design";
}

/**
 * Platform-aware filtering: deprioritize entries that don't match the target
 * platform (don't remove — cross-platform inspiration has value, and many
 * entries may lack a platform field).
 */
function applyPlatformFilter(entries: CritiqueEntry[], platform?: string): CritiqueEntry[] {
  if (!platform) return entries;
  return entries
    .map((e) => ({
      ...e,
      // Penalize mismatched platform by halving the score (keeps it in results
      // but ranks it below platform-matched entries).
      score: e.platform && e.platform !== platform ? e.score * 0.5 : e.score,
    }))
    .sort((a, b) => b.score - a.score);
}

/** Classify coverage quality based on top score + count. */
function classifyCoverage(entries: CritiqueEntry[]): RetrievalResult["coverage"] {
  if (entries.length === 0) return "none";
  const topScore = entries[0]?.score ?? 0;
  if (topScore >= 0.75) return "strong";
  if (topScore >= 0.5) return "moderate";
  return "weak";
}
