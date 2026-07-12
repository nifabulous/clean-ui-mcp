/**
 * Corpus version detection — the ONE place that classifies a corpus file on
 * disk before anyone tries to use it.
 *
 * Why this module exists (Gate 1A): the old `tryReadCorpus` collapsed missing,
 * corrupt, AND schema-unparseable files into a single `null`. The fallback
 * chain in loadCorpusSafe then "recovered" by silently rewriting the primary
 * from a snapshot or returning a 1-entry seed — which a later save could
 * persist over a 787-entry working corpus. Classifying the failure mode
 * first lets the loader react correctly:
 *   - missing → fall back to snapshot/seed (read-only)
 *   - corrupt → fall back to snapshot/seed (read-only)
 *   - current / supported-old → use it (writable)
 *   - unsupported-newer → FAIL VISIBLE — never silently fall back. A future
 *     {version:3} file is exactly the case where a fallback would destroy
 *     real data: the loader can't read it, so it must not overwrite it.
 *
 * Version detection happens BEFORE schema validation by inspecting the parsed
 * JSON's `.version` field. This matters because Corpus is `z.literal(2)`: a
 * {version:3} file would fail Corpus.parse (looking like any other parse
 * error) unless we look at `.version` first and route it to unsupported-newer.
 *
 * v2 stays the current version (no bump in this task). The version field is
 * inspected anyway so a future v3 is distinguished from corruption — the
 * decoder is forward-compatible by construction.
 */
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { Corpus, type CorpusEntryT } from "./schema.js";

/** The version the writer currently emits and the reader fully supports. */
export const CURRENT_CORPUS_VERSION = 2;

/**
 * Discriminated result of decoding a corpus file. Every path the loader can
 * take flows from one of these variants — there is no longer a catch-all
 * `null` that hides the difference between "file gone" and "file broken".
 */
export type CorpusDecodeResult =
  | { kind: "missing"; path: string }
  | { kind: "current"; path: string; entries: CorpusEntryT[]; version: number }       // v2 today
  | { kind: "supported-old"; path: string; entries: CorpusEntryT[]; version: number }  // a prior version we can still read
  | { kind: "corrupt"; path: string; error: string }
  | { kind: "unsupported-newer"; path: string; version: number };                       // future version — fail visibly

/**
 * Decode a corpus file at `path`. Pure classification — no fallback, no
 * rewrite, no side effects. Callers decide what to do with each variant.
 *
 * Order of operations:
 *   1. Missing on disk → "missing".
 *   2. JSON-parse failure → "corrupt" (the file is physically there but
 *      unreadable; could be truncation, encoding, or hand-edit damage).
 *   3. Inspect `.version`:
 *        - missing/wrong-typed version field → try the schema; if it parses
 *          it's "current" (a well-formed file that omits version is still v2-
 *          shaped), otherwise "corrupt".
 *        - version > CURRENT → "unsupported-newer". FATAL by design.
 *        - version < CURRENT → try the schema; if the current reader can
 *          still parse it, "supported-old", else "corrupt".
 *   4. version === CURRENT → "current" if schema-valid, else "corrupt".
 */
export function decodeCorpusFile(path: string): CorpusDecodeResult {
  if (!existsSync(path)) {
    return { kind: "missing", path };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    return {
      kind: "corrupt",
      path,
      error: `JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Inspect the version field BEFORE schema validation. This is the
  // load-bearing distinction: a {version:3} file must surface as
  // unsupported-newer, not be silently rejected by z.literal(2) and misfiled
  // as corrupt (which would license a destructive seed/snapshot fallback).
  const versionField = (parsed as { version?: unknown }).version;
  const versionNumber = typeof versionField === "number" ? versionField : undefined;

  if (versionNumber !== undefined && versionNumber > CURRENT_CORPUS_VERSION) {
    // Future schema version. We can't safely read it; we must not overwrite it.
    return { kind: "unsupported-newer", path, version: versionNumber };
  }

  // Version is current, older, or absent — try to validate against the
  // current schema. v2 is the only version the schema accepts today, so a
  // genuinely older version that doesn't match will land in "corrupt".
  const result = Corpus.safeParse(parsed);
  if (result.success) {
    if (versionNumber !== undefined && versionNumber < CURRENT_CORPUS_VERSION) {
      return { kind: "supported-old", path, entries: result.data.entries, version: versionNumber };
    }
    return { kind: "current", path, entries: result.data.entries, version: versionNumber ?? CURRENT_CORPUS_VERSION };
  }

  return {
    kind: "corrupt",
    path,
    error: `schema validation failed: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 500)}`,
  };
}
