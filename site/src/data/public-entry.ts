/**
 * Publication-safe snapshot adapter.
 *
 * The public site only ever consumes the tracked {@link PublicSnapshot}. This
 * module narrows that snapshot to the fields the homepage and playground need
 * and validates every value with explicit predicates. The most important rule
 * is the safe-image-path contract (see {@link assertSafePublicImagePath}): a
 * malicious or corrupted `imagePath` must never reach a generated `<img src>`
 * that points outside `${BASE_URL}entries/`.
 */

/** Provenance exposed to public users. Only the fields the UI renders. */
export interface PublicSource {
  readonly productName: string;
  readonly url: string;
}

/** Color-role mapping (optional on the source data). */
export interface PublicColorRoles {
  readonly canvas?: string;
  readonly surface?: string;
  readonly ink?: string;
  readonly muted?: string;
  readonly accent?: string;
}

/**
 * Narrow, read-only view of one corpus entry. The parser refuses to forward
 * any field that the public UI does not need.
 */
export interface PublicEntry {
  readonly id: string;
  readonly title: string;
  readonly patternType: string;
  readonly categories: readonly string[];
  readonly styleTags: readonly string[];
  readonly qualityTier: string;
  readonly qualityScore: number;
  readonly critique: string;
  readonly whatToSteal: readonly string[];
  readonly antiPatterns: readonly string[];
  readonly dominantColors: readonly string[];
  readonly colorRoles?: PublicColorRoles;
  readonly accent?: string;
  readonly critiqueExcerpt?: string;
  /** Original public-safe basename as stored in the snapshot, e.g. "sample-5.png". */
  readonly imagePath: string;
  /** Resolved absolute URL under `${BASE_URL}entries/` — safe by construction. */
  readonly imageUrl: string;
  readonly source: PublicSource;
  /**
   * Optional platform tag. The current snapshot does not carry this field, so
   * the search filter must type-check and match everything when it is absent.
   */
  readonly platform?: string;
}

/** Top-level shape of the tracked snapshot. */
export interface PublicSnapshot {
  readonly count: number;
  readonly generatedAt: string;
  readonly categories: readonly string[];
  readonly styleTags: readonly string[];
  readonly entries: readonly PublicEntry[];
}

/** Untyped input shape used by the parser and by tests. */
export interface PublicSnapshotInput {
  readonly count?: unknown;
  readonly generatedAt?: unknown;
  readonly categories?: unknown;
  readonly styleTags?: unknown;
  readonly entries?: unknown;
}

/** Untyped per-row input shape used by the parser. */
export type PublicEntryInput = Record<string, unknown> & { id?: unknown };

/**
 * Coarse loading state for the public snapshot. The Playground uses this to
 * decide between skeleton, retry, and ready renders.
 */
export type SnapshotLoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; snapshot: PublicSnapshot };

const BASE_URL =
  typeof import.meta !== "undefined" && import.meta.env && import.meta.env.BASE_URL
    ? import.meta.env.BASE_URL
    : "/";

function ensureTrailingSlash(prefix: string): string {
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Validates that `imagePath` is a publication-safe relative filename.
 *
 * Safe means:
 *   - a non-empty string
 *   - relative (no leading `/`)
 *   - contains no URL scheme (rejects `http:`, `https:`, `file:`, etc.)
 *   - contains no `..` segment (defends against traversal)
 *   - does not start with `images-private/` (the curator-only asset folder)
 *   - contains no `?` query or `#` fragment (avoids URL-shaped payloads)
 *
 * Anything that fails this predicate is rejected with an Error whose message
 * matches {@code /safe public image path/i}.
 */
export function isSafePublicImagePath(value: unknown): boolean {
  if (!isNonEmptyString(value)) return false;
  const path = value as string;
  if (path.startsWith("/")) return false;
  if (path.startsWith("images-private/")) return false;
  if (/[?#]/.test(path)) return false;
  // Reject anything that looks like a URL scheme (e.g. "http://", "file://").
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return false;
  // Reject any `..` path segment, whether at the start, middle, or end.
  const segments = path.split("/");
  if (segments.some((segment) => segment === "..")) return false;
  return true;
}

function assertSafePublicImagePath(value: unknown): asserts value is string {
  if (!isSafePublicImagePath(value)) {
    throw new Error(
      `Refusing unsafe public image path: expected a relative filename under entries/, received ${JSON.stringify(
        value,
      )}`,
    );
  }
}

function parsePublicSource(value: unknown): PublicSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("source must be an object with productName and url");
  }
  const record = value as Record<string, unknown>;
  if (!isNonEmptyString(record.productName)) {
    throw new Error("source.productName must be a non-empty string");
  }
  if (!isNonEmptyString(record.url)) {
    throw new Error("source.url must be a non-empty string");
  }
  // Narrow on purpose — extra curator-only fields are dropped.
  return { productName: record.productName, url: record.url };
}

function parseColorRoles(value: unknown): PublicColorRoles | undefined {
  if (value == null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("colorRoles must be an object when present");
  }
  const record = value as Record<string, unknown>;
  const out: PublicColorRoles = {};
  for (const key of ["canvas", "surface", "ink", "muted", "accent"] as const) {
    const candidate = record[key];
    if (candidate === undefined) continue;
    if (!isNonEmptyString(candidate)) {
      throw new Error(`colorRoles.${key} must be a non-empty string when present`);
    }
    out[key] = candidate;
  }
  return out;
}

function requiredString(value: unknown, field: string): string {
  if (!isNonEmptyString(value)) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function requiredStringArray(value: unknown, field: string): string[] {
  if (!isStringArray(value)) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value;
}

function requiredNumber(value: unknown, field: string): number {
  if (!isFiniteNumber(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  return value;
}

/**
 * Parse one untyped snapshot row into a {@link PublicEntry}. Throws on any
 * structural problem; never mutates the input.
 */
export function parsePublicEntry(input: PublicEntryInput): PublicEntry {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("entry must be a plain object");
  }

  const id = requiredString(input.id, "entry.id");
  const title = requiredString(input.title, "entry.title");
  const patternType = requiredString(input.patternType, "entry.patternType");
  const categories = requiredStringArray(input.categories, "entry.categories");
  const styleTags = requiredStringArray(input.styleTags, "entry.styleTags");
  const qualityTier = requiredString(input.qualityTier, "entry.qualityTier");
  const qualityScore = requiredNumber(input.qualityScore, "entry.qualityScore");
  const critique = requiredString(input.critique, "entry.critique");
  const whatToSteal = requiredStringArray(input.whatToSteal, "entry.whatToSteal");
  const antiPatterns = requiredStringArray(input.antiPatterns, "entry.antiPatterns");
  const dominantColors = requiredStringArray(input.dominantColors, "entry.dominantColors");
  const source = parsePublicSource(input.source);
  const colorRoles = parseColorRoles(input.colorRoles);

  // Safe-path validation MUST happen before we resolve the URL. Every invalid
  // shape (missing, empty, wrong type, absolute, traversal, scheme, private
  // folder) is rejected with the uniform "safe public image path" error so the
  // caller sees a single, auditable failure mode.
  assertSafePublicImagePath(input.imagePath);
  const rawImagePath = input.imagePath;

  const optionalString = (value: unknown): string | undefined =>
    isNonEmptyString(value) ? value : undefined;

  const optionalPlatform = optionalString(input.platform);
  const optionalAccent = optionalString(input.accent);
  const optionalExcerpt = optionalString(input.critiqueExcerpt);

  const entriesPrefix = `${ensureTrailingSlash(BASE_URL)}entries/`;
  const imageUrl = `${entriesPrefix}${encodeURIComponent(rawImagePath)}`;

  const entry: PublicEntry = {
    id,
    title,
    patternType,
    categories,
    styleTags,
    qualityTier,
    qualityScore,
    critique,
    whatToSteal,
    antiPatterns,
    dominantColors,
    source,
    imageUrl,
    imagePath: rawImagePath,
  };
  if (colorRoles !== undefined) entry.colorRoles = colorRoles;
  if (optionalPlatform !== undefined) entry.platform = optionalPlatform;
  if (optionalAccent !== undefined) entry.accent = optionalAccent;
  if (optionalExcerpt !== undefined) entry.critiqueExcerpt = optionalExcerpt;
  return entry;
}

/**
 * Validate and adapt the full untyped snapshot. Throws when {@link PublicSnapshotInput.count}
 * does not equal {@code entries.length} or any row fails the per-entry parser.
 */
export function parsePublicSnapshot(input: PublicSnapshotInput): PublicSnapshot {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("snapshot must be a plain object");
  }
  const count = requiredNumber(input.count, "snapshot.count");
  const generatedAt = requiredString(input.generatedAt, "snapshot.generatedAt");
  const categories = requiredStringArray(input.categories, "snapshot.categories");
  const styleTags = requiredStringArray(input.styleTags, "snapshot.styleTags");
  if (!Array.isArray(input.entries)) {
    throw new Error("snapshot.entries must be an array");
  }
  const entries = input.entries as unknown[];
  if (count !== entries.length) {
    throw new Error(
      `snapshot integrity check failed: count=${count} but entries.length=${entries.length}`,
    );
  }
  const parsed = entries.map((raw, index) => {
    try {
      return parsePublicEntry(raw as PublicEntryInput);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`snapshot.entries[${index}] is invalid: ${reason}`);
    }
  });
  return { count, generatedAt, categories, styleTags, entries: parsed };
}
