/**
 * clear-unverified.ts — remove gated values that serve today and that nothing
 * will ever verify.
 *
 * Tasks 1-3 of the corpus-tag-provenance spec stopped NEW guesses entering. They
 * deliberately left the existing corpus alone, which is where the measured error
 * is: `visual.usesShadows` is recorded on 787/787 entries, and the 82 hand labels
 * in `eval/verdicts/labels.jsonl` put it 6 wrong out of 10 (n=10 — directional,
 * not a precision figure). The field is `gated`: the model abstained on it across
 * the verification cohort in its own words, and the element-box probe closed the
 * pixel route, so the entries without a verification record will never be checked
 * by any lane. A value that is wrong ~60% of the time and unverifiable forever is
 * worse than absence — absence is honest, and the serving path already knows how
 * to omit a field.
 *
 * The rule: clear a gated field ONLY where `isVerified` is false. This removes
 * guesses, never evidence. The entries holding real records keep their values.
 *
 * PURE. The CLI wrapper (`scripts/clear-unverified-cli.ts`) owns the I/O.
 */
import type { CorpusEntryT } from "./schema.js";
import { GATED_FIELDS, isVerified } from "./corpus-trust.js";
import { clearModeFor } from "./gated-fields.js";

export interface ClearReport {
  readonly field: string;
  readonly cleared: number;
  readonly kept: number;
  readonly alreadyAbsent: number;
  /** Ids whose value was removed — printed so the change is reviewable, not just counted. */
  readonly clearedIds: string[];
  /** Ids that kept their value, with the evidence method that protected each. */
  readonly keptIds: Array<{ id: string; method: string }>;
  readonly entries: CorpusEntryT[];
}

/**
 * Returns a new entry list with `field` cleared on every entry that carries a
 * value for it but no verification record.
 *
 * Refuses any field that is not gated. A non-gated field still has a lane that
 * can confirm it, so clearing it would destroy data the verifier is about to
 * check — the opposite of the point.
 */
export function clearUnverified(entries: readonly CorpusEntryT[], field: string): ClearReport {
  if (!GATED_FIELDS.has(field)) {
    throw new Error(
      `clear-unverified: "${field}" is not gated. Only fields where BOTH the model ` +
      `lane and the pixel route are exhausted are eligible — anything else still has ` +
      `a verifier that can confirm it, and clearing it would destroy checkable data. ` +
      `Gated: ${[...GATED_FIELDS].sort().join(", ")}.`,
    );
  }
  const mode = clearModeFor(field);
  const segments = field.split(".");
  const key = segments[segments.length - 1];
  const parentPath = segments.slice(0, -1);

  const clearedIds: string[] = [];
  const keptIds: Array<{ id: string; method: string }> = [];
  let alreadyAbsent = 0;

  const out = entries.map((original) => {
    const entry = structuredClone(original) as unknown as Record<string, unknown>;
    let parent: Record<string, unknown> | null = entry;
    for (const segment of parentPath) {
      const next = parent[segment];
      if (next === null || typeof next !== "object") { parent = null; break; }
      parent = next as Record<string, unknown>;
    }
    if (parent === null) { alreadyAbsent += 1; return original; }

    const present = key in parent && parent[key] !== null && parent[key] !== undefined;
    if (!present) { alreadyAbsent += 1; return original; }

    if (isVerified(original, field)) {
      keptIds.push({
        id: original.id,
        method: original.provenance?.verification?.[field]?.method ?? "unknown",
      });
      return original;
    }

    if (mode === "null") parent[key] = null;
    else delete parent[key];
    clearedIds.push(original.id);
    return entry as unknown as CorpusEntryT;
  });

  return {
    field,
    cleared: clearedIds.length,
    kept: keptIds.length,
    alreadyAbsent,
    clearedIds,
    keptIds,
    entries: out,
  };
}
