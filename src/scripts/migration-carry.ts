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
