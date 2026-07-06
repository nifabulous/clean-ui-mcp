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
 *   { version: 2, model: "voyage-4", entries: { [id]: { vector: number[], hash: string } } }
 * The hash is a SHA-256 of the entryToDocument() text, so the doctor can detect
 * content-stale embeddings (title/critique changed after the vector was built)
 * without re-running the model. v1 indexes (bare vector arrays) are treated as
 * fully stale on load and rebuilt. Gitignored — regenerate with `npm run build-index`.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(__dirname, "..", "corpus", "embeddings.json");

const VOYAGE_MODEL = "voyage-4";
const VOYAGE_API   = "https://api.voyageai.com/v1/embeddings";
const EMBED_DIM    = 1024;

// ─── types ────────────────────────────────────────────────────────────────────

export interface IndexedEntry {
  vector: number[]; // 1024-float Voyage vector
  hash:   string;  // SHA-256 of entryToDocument(entry) — detects content drift
}

export interface EmbeddingIndex {
  version: 2;
  model:   string;
  entries: Record<string, IndexedEntry>; // id → { vector, hash }
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
  const BATCH = 64; // 64 (not 128) to stay under Voyage's token-per-request cap on dense entries
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const vecs  = await voyageEmbedWithRetry(batch, "document");
    results.push(...vecs);
    if (i + BATCH < texts.length) {
      // Polite pause between batches — Voyage free tier is rate-limited
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  return results;
}

/** voyageEmbed with retry+backoff on 429/transient errors. Rate limits are the
 *  expected failure mode on the free tier when embedding hundreds of entries. */
async function voyageEmbedWithRetry(
  texts: string[],
  inputType: "document" | "query",
  retries = 4,
): Promise<number[][]> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await voyageEmbed(texts, inputType);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const isRateLimit = /429|rate_limit|RESOURCE_EXHAUSTED|Too Many Requests/i.test(msg);
      if (attempt < retries && isRateLimit) {
        const backoff = 2000 * 2 ** attempt; // 2s, 4s, 8s, 16s
        console.error(`  [voyage] rate limited, retrying in ${backoff / 1000}s (attempt ${attempt + 1}/${retries})…`);
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      throw error;
    }
  }
  throw new Error("voyageEmbedWithRetry: unreachable");
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
  return coerceToV2(parsed);
}

/**
 * Validate that a parsed index is structurally sound AND matches the current
 * embedding model + dimension. Accepts v1 (bare vector arrays, no hash) and
 * v2 ({vector, hash}). A v1 index loads but every entry is treated as
 * content-stale (no hash to compare), so the next incremental build-index
 * re-embeds everything and writes v2.
 */
function isValidIndex(parsed: unknown): parsed is EmbeddingIndex {
  if (!parsed || typeof parsed !== "object") return false;
  const idx = parsed as Record<string, unknown>;
  if (idx.version !== 1 && idx.version !== 2) return false;
  if (idx.model !== VOYAGE_MODEL) return false;
  const entries = idx.entries;
  if (!entries || typeof entries !== "object") return false;
  // Check the first entry's dimension; an empty index is trivially valid.
  const values = Object.values(entries as Record<string, unknown>);
  if (values.length === 0) return true;
  return isValidEntry(values[0]);
}

/** Accept v1 (number[]) or v2 ({vector, hash}). */
function isValidEntry(value: unknown): boolean {
  if (Array.isArray(value)) {
    // v1: bare vector array
    return value.length === EMBED_DIM && value.every((v) => typeof v === "number");
  }
  if (value && typeof value === "object") {
    // v2: { vector, hash }
    const entry = value as { vector?: unknown; hash?: unknown };
    return Array.isArray(entry.vector) && entry.vector.length === EMBED_DIM
      && entry.vector.every((v) => typeof v === "number")
      && typeof entry.hash === "string";
  }
  return false;
}

/**
 * Coerce a parsed (validated) index to v2 shape. v1 entries (bare arrays)
 * become { vector, hash: "" } — the empty hash marks them content-stale so
 * indexStatus reports them and build-index re-embeds them.
 */
function coerceToV2(parsed: EmbeddingIndex): EmbeddingIndex {
  if (parsed.version === 2) return parsed;
  const entries: Record<string, IndexedEntry> = {};
  for (const [id, raw] of Object.entries(parsed.entries)) {
    // v1 entries are bare number[]; cast through unknown since the v1 type is
    // already validated structurally by isValidEntry above.
    const vector = raw as unknown as number[];
    entries[id] = { vector, hash: "" };
  }
  return { version: 2, model: parsed.model, entries };
}

export function saveIndex(index: EmbeddingIndex): void {
  writeFileSync(INDEX_PATH, JSON.stringify(index), "utf-8");
}

/** SHA-256 (hex) of a document string — used to detect content drift cheaply. */
export function hashForDocument(document: string): string {
  return createHash("sha256").update(document).digest("hex");
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
  businessRationale?: { businessGoal?: string; targetUser?: string; rationale?: string; confirmed?: boolean };
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
  // Embedding document for semantic search + similarity.
  //
  // Design attributes (patternType, styleTags, visual, layout) are repeated
  // to emphasize them over product identity and prose. This fixes the
  // product-clustering problem: without reweighting, entries from the same
  // product (same critique writing style, same productName) cluster tightly
  // in embedding space regardless of their actual visual design. By front-
  // loading and repeating the structural attributes, "find similar dashboards"
  // returns visually similar dashboards from DIFFERENT products, not just
  // more entries from the same product.
  const patternAndStyle = [
    entry.patternType ? `Pattern: ${entry.patternType}.` : "",
    `Categories: ${entry.categories.join(", ")}.`,
    `Style: ${entry.styleTags.join(", ")}.`,
  ].filter(Boolean).join(" ");

  const visualAttrs = [
    `Spacing: ${entry.visual.spacingDensity}. Corners: ${entry.visual.cornerStyle}.`,
    entry.visual.usesShadows ? "Uses shadows for depth." : "No shadows; depth via other means.",
    entry.visual.usesBorders ? "Borders used for structure." : "No borders.",
  ].join(" ");

  const colorAttrs = [
    entry.visual.dominantColors.length ? `Colors: ${entry.visual.dominantColors.join(", ")}.` : "",
    (() => {
      const cr = entry.visual.colorRoles;
      if (cr?.canvas && cr?.ink) {
        return `Color roles: canvas ${cr.canvas}, ink ${cr.ink}${cr.accent ? `, accent ${cr.accent}` : ""}.`;
      }
      return "";
    })(),
    entry.visual.accentColor ? `Accent: ${entry.visual.accentColor}.` : "",
  ].filter(Boolean).join(" ");

  const layoutAttrs = (() => {
    if (!entry.layout?.form) return "";
    const roles = (entry.layout.regions ?? []).map((r) => r.role).join(", ");
    return `Layout: ${entry.layout.form}${roles ? ` (${roles})` : ""}.`;
  })();

  const typeAttrs = (() => {
    const parts: string[] = [];
    if (entry.visual.typePairing.display || entry.visual.typePairing.body) {
      const tp = [entry.visual.typePairing.display, entry.visual.typePairing.body]
        .filter(Boolean).join(" / ");
      parts.push(`Type: ${tp}.`);
    }
    if (entry.visual.typePairing.notes) parts.push(entry.visual.typePairing.notes);
    return parts.join(" ");
  })();

  // Anti-patterns characterize the design's discipline.
  const ap = entry.antiPatterns?.antiPatterns ?? [];
  const avoidAttrs = ap.length ? `Avoids: ${ap.join("; ")}.` : "";

  // Voice — copy IS design.
  const voiceAttrs = entry.voice?.tone ? `Voice: ${entry.voice.tone}.` : "";

  // Quality tier — "cautionary" is a strong signal.
  const tierAttrs = (entry.qualityTier && entry.qualityTier !== "exceptional")
    ? `Tier: ${entry.qualityTier} (teach what NOT to do).` : "";

  const businessAttrs = entry.businessRationale?.businessGoal
    ? `Business goal: ${entry.businessRationale.businessGoal}. Target user: ${entry.businessRationale.targetUser ?? "unknown"}. Rationale: ${entry.businessRationale.rationale ?? ""}`
    : "";

  // Assemble: structural attributes first + repeated (emphasized), then prose
  // (critique + steals) once, then product identity last (de-emphasized).
  const parts: string[] = [
    // Structural block — repeated to weight design characteristics heavily.
    patternAndStyle,
    visualAttrs,
    colorAttrs,
    layoutAttrs,
    typeAttrs,
    avoidAttrs,
    tierAttrs,
    // One repetition of the key structural signals for extra embedding weight.
    patternAndStyle,
    visualAttrs,
    layoutAttrs,
    // Prose — included once for search depth, but not repeated.
    entry.critique,
    entry.whatToSteal.join(". "),
    // Supplementary context.
    voiceAttrs,
    businessAttrs,
    // Product identity — last, so it's the weakest signal.
    entry.source.productName,
  ];

  return parts.filter(Boolean).join("\n");
}

export { EMBED_DIM, INDEX_PATH };
