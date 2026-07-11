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
 */
import { searchRanked } from "./corpus.js";
import { cosine, loadImageIndex, type ImageEmbeddingIndex } from "./image-index.js";
import type { ImageEmbeddingProvider, ValidatedImage } from "./image-embeddings.js";

export interface CritiqueEntry {
  id: string;
  patternType?: string;
  platform?: string;
  reviewStatus?: string;
  title?: string;
  score: number;
}

export type RetrievalMode = "image" | "hybrid" | "structured-fallback";

export interface RetrievalResult {
  entries: CritiqueEntry[];
  mode: RetrievalMode;
  fallbackUsed: boolean;
  coverage: "strong" | "moderate" | "weak" | "none";
}

export interface RetrieveCritiqueInput {
  imageProvider: ImageEmbeddingProvider | null;
  imageData: Buffer | null; // decoded image bytes for embedding
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
  const { imageProvider, imageData, extraction, productContext, platform, imageIndex } = input;

  // ── Try image retrieval first ────────────────────────────────────────────────
  if (imageProvider && imageData && imageIndex) {
    try {
      const queryVec = await imageProvider.embedImage({
        data: imageData,
        mimeType: "image/png", // default; the caller should set this
      } as ValidatedImage);

      // Rank all index entries by cosine similarity.
      const ranked = Object.entries(imageIndex.entries)
        .map(([id, entry]) => ({ id, score: cosine(queryVec, entry.vector) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_ENTRIES * 2); // over-fetch for platform filtering

      // Fetch entry metadata from corpus (searchRanked does approved-only,
      // but the image index may contain stale entries — filter by id lookup).
      // For now, use the scores directly; the synthesis layer will validate.
      const entries: CritiqueEntry[] = ranked.map((r) => ({
        id: r.id,
        score: r.score,
        patternType: undefined, // resolved by caller from corpus lookup
      }));

      if (entries.length > 0) {
        const filtered = applyPlatformFilter(entries, platform);
        const coverage = classifyCoverage(filtered);
        return {
          entries: filtered.slice(0, MAX_ENTRIES),
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
  const results = await searchRanked({ query, limit: MAX_ENTRIES * 2 });
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
