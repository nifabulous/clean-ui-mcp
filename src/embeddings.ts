import "./env.js";

/**
 * embeddings.ts
 * ──────────────
 * Voyage AI HTTP client + cosine similarity + index load/save.
 * No native deps — just fetch() and JSON.
 *
 * Env: VOYAGE_API_KEY (get one free at https://dash.voyageai.com)
 * Model: voyage-4 — Anthropic's recommended partner, 1024-dim, normalized.
 *
 * Index file: corpus/embeddings.json
 *   { version: 1, model: "voyage-4", entries: { [id]: number[] } }
 * Gitignored by default — regenerate with `npm run build-index`.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(__dirname, "..", "corpus", "embeddings.json");

const VOYAGE_MODEL = "voyage-4";
const VOYAGE_API   = "https://api.voyageai.com/v1/embeddings";
const EMBED_DIM    = 1024;

// ─── types ────────────────────────────────────────────────────────────────────

export interface EmbeddingIndex {
  version: 1;
  model:   string;
  entries: Record<string, number[]>; // id → 1024-float vector
}

// ─── Voyage HTTP client ───────────────────────────────────────────────────────

async function voyageEmbed(
  texts: string[],
  inputType: "document" | "query",
): Promise<number[][]> {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) throw new Error("VOYAGE_API_KEY env var not set. Get one at https://dash.voyageai.com");

  const res = await fetch(VOYAGE_API, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${key}`,
    },
    body: JSON.stringify({ input: texts, model: VOYAGE_MODEL, input_type: inputType }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Voyage API error ${res.status}: ${body}`);
  }

  const data = await res.json() as {
    data: Array<{ index: number; embedding: number[] }>;
  };

  // Sort by index (API guarantees order but let's be safe)
  return data.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

/** Embed a single query string (different input_type from documents). */
export async function embedQuery(text: string): Promise<number[]> {
  const [vec] = await voyageEmbed([text], "query");
  return vec;
}

/** Embed a batch of document strings. Voyages's batch limit is 128 inputs. */
export async function embedDocuments(texts: string[]): Promise<number[][]> {
  const BATCH = 128;
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const vecs  = await voyageEmbed(batch, "document");
    results.push(...vecs);
    if (i + BATCH < texts.length) {
      // Polite pause between batches — Voyage free tier is rate-limited
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return results;
}

// ─── cosine similarity (dot product — Voyage vectors are L2-normalized) ───────

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error(`Dimension mismatch: ${a.length} vs ${b.length}`);
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // already in [-1, 1] since both are unit vectors
}

// ─── index I/O ────────────────────────────────────────────────────────────────

export function indexExists(): boolean {
  return existsSync(INDEX_PATH);
}

export function loadIndex(): EmbeddingIndex | null {
  if (!existsSync(INDEX_PATH)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(INDEX_PATH, "utf-8"));
  } catch {
    return null;
  }
  if (!isValidIndex(parsed)) {
    // Stale/incompatible index (wrong model, changed embedding dimension, hand
    // edit). Treat as absent so search degrades to keyword instead of throwing
    // Dimension mismatch inside cosine() on every vector query.
    console.error(
      "[clean-ui-mcp] embeddings.json is stale or incompatible (model/dimension mismatch) — falling back to keyword search. Run `npm run build-index --force` to rebuild.",
    );
    return null;
  }
  return parsed;
}

/**
 * Validate that a parsed index is structurally sound AND matches the current
 * embedding model + dimension. Returns false on any mismatch so the caller can
 * fall back to keyword search instead of crashing mid-query.
 */
function isValidIndex(parsed: unknown): parsed is EmbeddingIndex {
  if (!parsed || typeof parsed !== "object") return false;
  const idx = parsed as Record<string, unknown>;
  if (idx.version !== 1) return false;
  if (idx.model !== VOYAGE_MODEL) return false;
  const entries = idx.entries;
  if (!entries || typeof entries !== "object") return false;
  // Check the first vector's dimension; an empty index is trivially valid.
  const vectors = Object.values(entries as Record<string, unknown>);
  if (vectors.length === 0) return true;
  const first = vectors[0];
  return Array.isArray(first) && first.length === EMBED_DIM && first.every((v) => typeof v === "number");
}

export function saveIndex(index: EmbeddingIndex): void {
  writeFileSync(INDEX_PATH, JSON.stringify(index), "utf-8");
}

// ─── text to embed per entry ──────────────────────────────────────────────────

/**
 * Build the document text for one corpus entry.
 * This is what gets embedded — optimise this string to get better retrieval.
 *
 * Design choices:
 * - critique + whatToSteal carry the most semantic signal; they lead.
 * - categories/styleTags are explicit, so included verbatim.
 * - visual attributes (colors, fonts) are included as natural phrases
 *   so queries like "dark monochrome with Inter" still surface matches.
 * - antiPatterns.antiPatterns (mistakes avoided) IS useful signal for
 *   similarity — it characterizes the design's discipline, not its failures.
 *   whereThisFails/accessibilityRisks stay excluded (true negative signal).
 */
export function entryToDocument(entry: {
  title:        string;
  patternType?: string;
  categories:   string[];
  styleTags:    string[];
  critique:     string;
  whatToSteal:  string[];
  antiPatterns?: { antiPatterns: string[]; whereThisFails?: string[]; accessibilityRisks?: string[] };
  layout?: { form?: string; regions?: Array<{ role: string; width?: string }> };
  voice?: { tone?: string; examples?: string[]; avoid?: string[] };
  qualityTier?: string;
  source:       { productName: string; url?: string | null };
  visual: {
    dominantColors: string[];
    accentColor:    string | null;
    colorRoles?:    { canvas?: string; surface?: string; ink?: string; muted?: string | null; accent?: string };
    typePairing:    { display: string | null; body: string | null; notes?: string };
    spacingDensity: string;
    cornerStyle:    string;
    usesShadows:    boolean;
    usesBorders:    boolean;
  };
}): string {
  const parts: string[] = [
    `${entry.source.productName}: ${entry.title}`,
    entry.patternType ? `Pattern: ${entry.patternType}.` : "",
    `Categories: ${entry.categories.join(", ")}`,
    `Style: ${entry.styleTags.join(", ")}`,
    entry.critique,
    entry.whatToSteal.join(". "),
    `Spacing: ${entry.visual.spacingDensity}. Corners: ${entry.visual.cornerStyle}.`,
    entry.visual.usesShadows ? "Uses shadows for depth." : "No shadows; depth via other means.",
    entry.visual.usesBorders ? "Borders used for structure." : "No borders.",
  ];

  // Anti-patterns (mistakes avoided) characterize the design's discipline and
  // improve "find similar restrained UIs" retrieval.
  const ap = entry.antiPatterns?.antiPatterns ?? [];
  if (ap.length) parts.push(`Avoids: ${ap.join("; ")}.`);

  // Structured layout — improves "find dashboards with a left nav + right rail"
  // style structural retrieval, not just attribute matching.
  if (entry.layout?.form) {
    const roles = (entry.layout.regions ?? []).map((r) => r.role).join(", ");
    parts.push(`Layout: ${entry.layout.form}${roles ? ` (${roles})` : ""}.`);
  }

  // Voice — improves "find restrained-voice dashboards" retrieval (copy IS design).
  if (entry.voice?.tone) parts.push(`Voice: ${entry.voice.tone}.`);

  // Quality tier — "cautionary" is a strong signal; weight it explicitly so
  // "show me bad examples" queries surface them.
  if (entry.qualityTier && entry.qualityTier !== "exceptional") {
    parts.push(`Tier: ${entry.qualityTier} (teach what NOT to do).`);
  }

  // Color roles — labeled tokens improve "find designs with a near-black ink on
  // off-white canvas" retrieval vs bare hex lists.
  const cr = entry.visual.colorRoles;
  if (cr?.canvas && cr?.ink) {
    parts.push(`Color roles: canvas ${cr.canvas}, ink ${cr.ink}${cr.accent ? `, accent ${cr.accent}` : ""}.`);
  }

  if (entry.visual.typePairing.display || entry.visual.typePairing.body) {
    const tp = [entry.visual.typePairing.display, entry.visual.typePairing.body]
      .filter(Boolean).join(" / ");
    parts.push(`Type: ${tp}.`);
  }
  if (entry.visual.typePairing.notes) {
    parts.push(entry.visual.typePairing.notes);
  }
  if (entry.visual.dominantColors.length) {
    parts.push(`Colors: ${entry.visual.dominantColors.join(", ")}.`);
  }

  return parts.filter(Boolean).join("\n");
}

export { EMBED_DIM, INDEX_PATH };
