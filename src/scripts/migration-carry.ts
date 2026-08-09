import type { CorpusEntryT } from "../schema.js";
import { carryVerification } from "../verification-carry.js";

/**
 * Apply a structural migration without laundering field-level evidence.
 * Verification is rebuilt from the pre-migration entry and survives only for
 * claims whose value is unchanged in the migrated entry.
 */
export function carryMigrationVerification(
  nextEntries: readonly CorpusEntryT[],
  priorEntries: readonly CorpusEntryT[],
): CorpusEntryT[] {
  const priorById = new Map(priorEntries.map((entry) => [entry.id, entry]));
  return nextEntries.map((entry) => carryVerification(entry, priorById.get(entry.id)));
}

/**
 * The pre-migration entries, read from the RAW corpus document.
 *
 * Deliberately does NOT go through `Corpus.safeParse`. `migrate-wcag-ids.ts`
 * exists to migrate a legacy shape and says so itself (":191 — this migration may
 * begin with a legacy shape that the current schema cannot parse"), so a
 * parse-gated derivation returns [] on exactly the input the script is for. With
 * no prior, `carryVerification` drops every record on every entry: fail-closed,
 * but it destroys the ~447 records Task 3 was written to protect.
 *
 * `carryVerification` reads `provenance` and dotted field paths, neither of which
 * needs a parsed entry, so the raw array is sufficient and strictly safer. Cloned
 * so a caller mutating the result cannot reach back into the raw document — these
 * scripts mutate entries in place.
 */
export function priorEntriesFromRaw(raw: unknown): CorpusEntryT[] {
  // A ROOT-ARRAY corpus must be checked first. `[].entries` resolves to
  // `Array.prototype.entries` — a function, not an array — so reading `.entries`
  // off an array falls through to [] and drops every record: the same defect this
  // function was written to fix, in a different shape. Other readers in this repo
  // accept both shapes (`Array.isArray(raw) ? raw : raw.entries`), so both are
  // real inputs.
  if (Array.isArray(raw)) return structuredClone(raw) as CorpusEntryT[];
  const entries = (raw as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries)) return [];
  return structuredClone(entries) as CorpusEntryT[];
}
