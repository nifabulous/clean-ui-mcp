/**
 * synthesis-projection.ts — the projection layer for synthesis/aggregation tools.
 *
 * 2d-2 invariant, synthesis half: a pure consumer (generateBrief, contributionNote,
 * collectPalettes, the compare renderer) may only ever read enrichment fields that
 * `isVerified` for the entry. The reader gates on CORE only; this layer strips
 * unverified enrichment BEFORE the pure functions see the entry, so a guarded read
 * becomes a compile-time requirement via the ProjectedEntry type.
 *
 * NEVER MUTATES THE SOURCE. `loadCorpus()` caches entry objects at module level and
 * `entriesForAggregation` hands those same objects to every handler, so stripping a
 * leaf in place would corrupt the shared corpus for all subsequent calls. This module
 * returns NEW entry objects and NEW containers for any nested object it touches.
 */
import type { CorpusEntryT } from "./schema.js";
import { isVerified } from "./corpus-trust.js";

/**
 * The top-level entry keys that any 2d-2 tool's enrichment set can strip. Nested
 * paths (`visual.*`, `antiPatterns.*`) map to their container, which becomes Partial.
 * Derived from the union of the three tools' enrichment keys — a contract test in
 * synthesis-projection.test.ts asserts the mapping stays complete.
 */
export const PROJECTED_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  "visual", "antiPatterns", "voice", "layout", "patternType",
  "styleTags", "categories", "platform", "whatToSteal",
]);

/**
 * An entry after 2d-2 projection: core + metadata untouched; every enrichment
 * container/leaf optional. `visual` and `antiPatterns` are Partial so verified
 * leaves survive while unverified leaves are stripped.
 */
export type ProjectedEntry = Omit<
  CorpusEntryT,
  "visual" | "antiPatterns" | "voice" | "layout" | "patternType"
    | "styleTags" | "categories" | "platform" | "whatToSteal"
> & {
  visual?: Partial<CorpusEntryT["visual"]>;
  antiPatterns?: Partial<CorpusEntryT["antiPatterns"]>;
  voice?: CorpusEntryT["voice"];
  layout?: CorpusEntryT["layout"];
  patternType?: CorpusEntryT["patternType"];
  styleTags?: CorpusEntryT["styleTags"];
  categories?: CorpusEntryT["categories"];
  platform?: CorpusEntryT["platform"];
  whatToSteal?: CorpusEntryT["whatToSteal"];
};

const NESTED_ENRICHMENT_KEYS = ["visual", "antiPatterns"] as const;

/**
 * Enrichment keys that share a name with their JS container. The bare key names
 * an INNER leaf on the container, not the container itself. Wiping the whole
 * container would silently drop verified sibling leaves.
 *
 *   "antiPatterns" (enrichment/servable key) → entry.antiPatterns.antiPatterns[]
 *
 * The nested-key loop below deletes exactly this inner leaf and leaves the
 * container's other leaves (e.g. `accessibilityRisks`) intact when they verified.
 */
const CONTAINER_SELF_LEAF: Readonly<Record<string, string>> = {
  antiPatterns: "antiPatterns",
};

/**
 * Returns a NEW entry with unverified enrichment removed (nested where relevant).
 * When nothing is omitted, returns the SAME entry (no clone churn — callers never
 * mutate). When something is omitted, builds a new entry object and NEW `visual` /
 * `antiPatterns` containers so the source and its nested objects are untouched.
 */
export function projectEntryForSynthesis(
  entry: CorpusEntryT,
  enrichment: readonly string[],
): ProjectedEntry {
  const omitted = enrichment.filter((field) => !isVerified(entry, field));
  if (omitted.length === 0) return entry;

  const projected = { ...entry } as ProjectedEntry;

  for (const container of NESTED_ENRICHMENT_KEYS) {
    const nestedKeys = enrichment.filter((k) => k.startsWith(`${container}.`));
    const nestedTouched = nestedKeys.some((k) => omitted.includes(k));
    const selfLeaf = CONTAINER_SELF_LEAF[container];
    const selfLeafOmitted = selfLeaf !== undefined && omitted.includes(container);
    const sourceContainer = (entry as unknown as Record<string, unknown>)[container];
    if ((nestedTouched || selfLeafOmitted) && sourceContainer && typeof sourceContainer === "object") {
      const copy = { ...(sourceContainer as Record<string, unknown>) };
      for (const k of nestedKeys) {
        const leaf = k.slice(container.length + 1);
        if (omitted.includes(k)) delete copy[leaf];
      }
      if (selfLeafOmitted && selfLeaf !== undefined) delete copy[selfLeaf];
      (projected as unknown as Record<string, unknown>)[container] = copy;
    }
  }

  for (const key of PROJECTED_TOP_LEVEL_KEYS) {
    // Container names (visual, antiPatterns) are handled by the nested loop
    // above. Wiping them here would drop verified sibling leaves — the bug
    // that let a verified `antiPatterns.accessibilityRisks` disappear when the
    // parent `antiPatterns` leaf was unverified.
    if ((NESTED_ENRICHMENT_KEYS as readonly string[]).includes(key)) continue;
    if (omitted.includes(key)) {
      (projected as unknown as Record<string, unknown>)[key] = undefined;
    }
  }

  return projected;
}

/**
 * The K-of-N brief-clause disclosure. Empty string when nothing was dropped —
 * a fully-verified brief renders byte-identically to today.
 */
export function renderCoverageDisclosure(args: {
  used: number;
  total: number;
  dropped: readonly string[];
}): string {
  if (args.used >= args.total) return "";
  const tail = args.dropped.length > 0 ? ` (missing: ${args.dropped.join(", ")})` : "";
  return `_Drawn from ${args.used} of ${args.total} verified entries${tail}._`;
}
