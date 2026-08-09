import { CorpusEntry, type CorpusEntryT } from "./schema.js";
import { carryVerification } from "./verification-carry.js";
import { RETAG_FIELDS, canonicalHash, valueForField, type RetagEntryLike, type RetagField } from "./retag-diff.js";

export type RetagCandidate = {
  entryId: string;
  baselineHash: string;
  imageSha256: string;
  candidateHash: string;
  candidate: RetagEntryLike;
};

export type PromotionDecision = {
  entryId: string;
  baselineHash: string;
  fields: RetagField[];
  reviewerId: string;
  decidedAt: string;
};

/**
 * Apply only explicitly accepted fields from an immutable shadow run.
 *
 * This is intentionally all-or-nothing: a stale baseline, unknown ID, invalid
 * candidate, duplicate decision, or attempted protected-field change aborts the
 * entire promotion before returning any entries. Changed claims lose their
 * old field verification via carryVerification and remain draft until the
 * normal review/verifier workflow accepts them.
 */
export function promoteAccepted(
  baseline: readonly CorpusEntryT[],
  candidates: readonly RetagCandidate[],
  decisions: readonly PromotionDecision[],
  imageSha256ForEntry: (entry: CorpusEntryT) => string,
): CorpusEntryT[] {
  const byId = new Map(baseline.map((entry) => [entry.id, entry]));
  const candidateById = new Map(candidates.map((candidate) => [candidate.entryId, candidate]));
  const seen = new Set<string>();
  const next = baseline.map((entry) => ({ ...entry }));

  for (const decision of decisions) {
    if (seen.has(decision.entryId)) throw new Error(`duplicate promotion decision for ${decision.entryId}`);
    seen.add(decision.entryId);
    if (!decision.reviewerId.trim()) throw new Error(`promotion decision for ${decision.entryId} needs reviewerId`);
    if (!Number.isFinite(Date.parse(decision.decidedAt))) throw new Error(`invalid decidedAt for ${decision.entryId}`);
    const before = byId.get(decision.entryId);
    const proposal = candidateById.get(decision.entryId);
    if (!before) throw new Error(`promotion decision names unknown entry ${decision.entryId}`);
    if (!proposal) throw new Error(`no shadow candidate for ${decision.entryId}`);
    if (canonicalHash(before) !== decision.baselineHash || proposal.baselineHash !== decision.baselineHash) {
      throw new Error(`stale baseline for ${decision.entryId}; generate a new shadow run`);
    }
    if (proposal.candidateHash !== canonicalHash(proposal.candidate)) {
      throw new Error(`candidate hash mismatch for ${decision.entryId}; shadow artifact may have been edited`);
    }
    if (!/^[a-f0-9]{64}$/.test(proposal.imageSha256)) {
      throw new Error(`invalid image hash for ${decision.entryId}`);
    }
    const actualImageSha256 = imageSha256ForEntry(before);
    if (proposal.imageSha256 !== actualImageSha256) {
      throw new Error(`image hash mismatch for ${decision.entryId}; generate a new shadow run`);
    }
    if (proposal.candidate.id !== decision.entryId) throw new Error(`candidate ID mismatch for ${decision.entryId}`);
    if (decision.fields.length === 0) throw new Error(`promotion decision for ${decision.entryId} selects no fields`);
    if (new Set(decision.fields).size !== decision.fields.length) throw new Error(`duplicate fields in decision for ${decision.entryId}`);
    for (const field of decision.fields) {
      if (!RETAG_FIELDS.includes(field)) throw new Error(`field ${field} is not promotable`);
      const candidateValue = valueForField(proposal.candidate, field);
      if (!hasValue(candidateValue)) throw new Error(`candidate is absent for selected ${field} on ${decision.entryId}; clearing requires a separate reviewed action`);
    }

    const index = next.findIndex((entry) => entry.id === decision.entryId);
    if (index < 0) throw new Error(`entry disappeared during promotion: ${decision.entryId}`);
    let merged = { ...next[index] } as CorpusEntryT;
    for (const field of decision.fields) merged = setField(merged, field, valueForField(proposal.candidate, field));
    // A retagged value is not trusted merely because a reviewer selected it;
    // reviewStatus is workflow state and field verification remains separate.
    merged.reviewStatus = "draft";
    merged = carryVerification(merged, before);
    const parsed = CorpusEntry.safeParse(merged);
    if (!parsed.success) {
      throw new Error(`promoted candidate for ${decision.entryId} failed corpus schema validation: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`);
    }
    next[index] = parsed.data;
  }
  return next;
}

function hasValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).some(hasValue);
  return true;
}

function setField(entry: CorpusEntryT, field: RetagField, value: unknown): CorpusEntryT {
  if (field === "visual.typePairing") {
    return { ...entry, visual: { ...entry.visual, typePairing: value as CorpusEntryT["visual"]["typePairing"] } };
  }
  return { ...entry, [field]: value } as CorpusEntryT;
}
