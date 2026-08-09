/**
 * gated-fields.ts — authoring writes ABSENCE on fields no lane can confirm.
 *
 * Task 2 of docs/superpowers/specs/2026-08-09-corpus-tag-provenance-design.md.
 *
 * The problem this replaces: the tagger guessed `visual.usesShadows` and
 * `visual.accentColor`, the wizard asked a human to guess them, and both wrote
 * the guess to the served corpus. Those fields are `gated` — the model abstained
 * 92 times across the verification cohort in its own words, and the element-box
 * probe closed the pixel route — so nothing downstream will ever adjudicate the
 * guess. Hand labels put `usesShadows` 6/10 wrong and `accentColor` 5/11 wrong.
 *
 * The earlier design for this was an admission GATE inside `persistEntries`,
 * which review killed across two rounds: it needed a grandfathering baseline for
 * the existing 787, the baseline needed a digest, the digest needed a detached
 * hash, and a copied legacy verification record still walked through. None of
 * that machinery is needed if the value is never authored in the first place.
 *
 * Why not in `persistEntries`: that function also serves the verifier's record
 * writes, `dedup-cleanup` and `restore-corpus`. Stripping there would clear the
 * existing 787's stored values on the next unrelated write. The strip belongs at
 * entry CREATION, and nowhere else.
 *
 * Both the field set and the clear mode are DERIVED — the set from the tier
 * table, the mode from the schema — so gating a field in future needs no edit
 * here.
 */
import { CorpusEntry, type CorpusEntryT } from "./schema.js";
import { GATED_FIELDS } from "./corpus-trust.js";

/** How a field expresses "no value": an explicit null, or absence of the key. */
export type ClearMode = "null" | "omit";

type ZodLeaf = {
  isNullable?: () => boolean;
  isOptional?: () => boolean;
  def?: { innerType?: ZodLeaf; shape?: Record<string, ZodLeaf> };
  shape?: Record<string, ZodLeaf>;
};

/** Walks a dotted field key down `CorpusEntry`'s shape to the leaf schema. */
function leafSchemaFor(field: string): ZodLeaf | null {
  let node: ZodLeaf = CorpusEntry as unknown as ZodLeaf;
  for (const segment of field.split(".")) {
    // Unwrap optional/nullable/default wrappers to reach the object shape.
    let base: ZodLeaf = node;
    while (base?.def?.innerType) base = base.def.innerType;
    const shape = base?.shape ?? base?.def?.shape;
    if (!shape) return null;
    const next = shape[segment];
    if (!next) return null;
    node = next;
  }
  return node;
}

/**
 * The clear mode for a field, read off the schema rather than a second table.
 *
 * Throws when a field can express neither. That is not a hypothetical:
 * `visual.typePairing` is a required object, and the fill spec proposes gating
 * it. Failing loudly here beats writing an entry that cannot parse — or worse,
 * silently skipping the field and serving the guess anyway.
 */
export function clearModeFor(field: string): ClearMode {
  const leaf = leafSchemaFor(field);
  if (!leaf) throw new Error(`gated-fields: ${field} is not a field on CorpusEntry`);
  if (leaf.isNullable?.()) return "null";
  if (leaf.isOptional?.()) return "omit";
  throw new Error(
    `gated-fields: ${field} is gated but cannot express absence — it is neither ` +
    `nullable nor optional on CorpusEntry. Make the schema able to say "not known" ` +
    `before gating the field, or authoring will write a guess it cannot retract.`,
  );
}

/**
 * Init guard: every gated field must be able to express absence.
 *
 * Called at module load so a tier-table edit that outruns the schema fails at
 * startup with the field named, rather than at the first entry write.
 */
export function gatedFieldsCanExpressAbsence(fields: ReadonlySet<string> = GATED_FIELDS): void {
  const broken: string[] = [];
  for (const field of fields) {
    try {
      clearModeFor(field);
    } catch {
      broken.push(field);
    }
  }
  if (broken.length > 0) {
    throw new Error(
      `gated-fields: these gated fields cannot express absence: ${broken.sort().join(", ")}. ` +
      `Make them nullable or optional in schema.ts before gating them.`,
    );
  }
}

gatedFieldsCanExpressAbsence();

/**
 * Returns a copy of `entry` with every gated field cleared.
 *
 * Applied to the ASSEMBLED entry at each creation site, not to tagger output.
 * Round 3 of review caught why that distinction matters: `add-entry`'s gated
 * values are human prompt answers, and the UI's POST body is assembled in the
 * browser — in both cases there is no tagger output left to strip by the time the
 * entry exists.
 *
 * Non-mutating and idempotent.
 */
export function stripGatedFields(entry: CorpusEntryT): CorpusEntryT {
  const out = structuredClone(entry) as unknown as Record<string, unknown>;
  for (const field of GATED_FIELDS) {
    const mode = clearModeFor(field);
    const segments = field.split(".");
    const key = segments.pop()!;
    let parent = out;
    let reachable = true;
    for (const segment of segments) {
      const next = parent[segment];
      if (next === null || typeof next !== "object") { reachable = false; break; }
      parent = next as Record<string, unknown>;
    }
    if (!reachable) continue;
    if (mode === "null") parent[key] = null;
    else delete parent[key];
  }
  return out as unknown as CorpusEntryT;
}

/**
 * Carries the PRIOR value of every gated field onto a re-tagged entry.
 *
 * For updates, not creation. A retag re-runs the tagger over the same screenshot,
 * so for a gated field it produces a fresh guess with no more evidence than the
 * last one — overwriting is pure churn that can flip a served value. Preserving
 * the prior value is the same call `qualityTier` already makes on this path, for
 * the same reason: the model cannot know the thing it would be changing.
 *
 * This deliberately does NOT clear the prior value. Whether to null out the
 * existing 787's wrong values is the open decision in the spec, and a retag is
 * not the place to make it silently.
 */
export function preserveGatedFields(next: CorpusEntryT, prior: CorpusEntryT): CorpusEntryT {
  const out = structuredClone(next) as unknown as Record<string, unknown>;
  const before = prior as unknown as Record<string, unknown>;
  for (const field of GATED_FIELDS) {
    const segments = field.split(".");
    const key = segments.pop()!;
    let target = out;
    let source: Record<string, unknown> | null = before;
    let reachable = true;
    for (const segment of segments) {
      const t = target[segment];
      if (t === null || typeof t !== "object") { reachable = false; break; }
      target = t as Record<string, unknown>;
      const sv: unknown = source === null ? undefined : source[segment];
      source = sv !== null && typeof sv === "object" ? sv as Record<string, unknown> : null;
    }
    if (!reachable) continue;
    if (source && key in source) target[key] = structuredClone(source[key]);
    else delete target[key];
  }
  return out as unknown as CorpusEntryT;
}

/**
 * Refuses an entry that arrives already claiming to be verified.
 *
 * Only the verifier writes `provenance.verification`. A new entry has no
 * legitimate reason to carry one, and `isVerified` trusts a record with no value
 * binding — so a record copied into a hand-edited draft or API payload would
 * serve an unchecked value as verified. Blocking the authoring vector closes that
 * without the `claimHash` machinery the fill spec defers.
 *
 * CREATE ONLY. The update path legitimately round-trips a stored map for the 50
 * entries that have one; refusing there would make every edit of a verified entry
 * fail. (Note that today `stampProvenance` in ui-server.ts drops the map before
 * persist — a separate live bug recorded in the spec — which is precisely why
 * this split has to be deliberate rather than incidental.)
 */
export function assertNoIncomingVerification(entry: CorpusEntryT): void {
  const provenance = (entry as unknown as {
    provenance?: {
      verification?: Record<string, unknown>;
      verifyAttempts?: Record<string, unknown>;
      dataQuality?: Record<string, unknown>;
    };
  }).provenance;
  // All THREE field-keyed maps, not just `verification`. Review caught that the
  // other two are injectable too, and while neither is served as trust directly,
  // `verifyAttempts` SUPPRESSES verification via alreadyProcessedAtVersion and a
  // planted `dataQuality` finding fabricates a contradiction against a value.
  const found: string[] = [];
  for (const map of ["verification", "verifyAttempts", "dataQuality"] as const) {
    for (const key of Object.keys(provenance?.[map] ?? {})) found.push(`${map}.${key}`);
  }
  if (found.length === 0) return;
  throw new Error(
    `Refusing to create entry "${entry.id}": it arrives with verifier-owned records ` +
    `(${found.sort().join(", ")}). Only the verifier (scripts/verify-corpus.ts) writes ` +
    `provenance.verification / verifyAttempts / dataQuality; a new entry cannot ` +
    `already be verified.`,
  );
}
