/**
 * serving-projection.ts — the SINGLE place enrichment is dropped before serving.
 *
 * 2d-1 invariant, renderer half: a tool emits an enrichment field only when
 * `isVerified` for that entry; anything else is omitted and named in the
 * per-entry disclosure. Projection is per field KEY (nested keys like
 * `antiPatterns` and `antiPatterns.accessibilityRisks` are independent
 * verification keys), so the renderer can strip a leaf without dropping its
 * parent, and vice versa.
 */
import type { CorpusEntryT } from "./schema.js";
import { isVerified } from "./corpus-trust.js";

export interface ServingProjection {
  /** Enrichment keys verified for the entry — safe to render. */
  readonly served: readonly string[];
  /** Enrichment keys NOT verified — must be omitted from the response and disclosed. */
  readonly omitted: readonly string[];
}

export function projectForServing(
  entry: CorpusEntryT,
  enrichment: readonly string[],
): ServingProjection {
  const served: string[] = [];
  const omitted: string[] = [];
  for (const field of enrichment) {
    (isVerified(entry, field) ? served : omitted).push(field);
  }
  return { served, omitted };
}

/**
 * The per-entry disclosure: names the omitted-because-unverified fields. Empty
 * string when nothing was omitted (a fully verified entry discloses nothing).
 * Omitted fields are ABSENT from the response body; this note is the sole
 * "exists but unverified" signal.
 */
export function renderOmittedDisclosure(omitted: readonly string[]): string {
  if (omitted.length === 0) return "";
  return `\n\n_Unverified fields omitted: ${omitted.join(", ")}._`;
}