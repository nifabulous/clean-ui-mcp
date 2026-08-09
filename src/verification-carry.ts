/**
 * verification-carry.ts — what happens to earned evidence when an entry changes.
 *
 * `stampProvenance` (ui-server.ts) rebuilt `provenance` from four keys while the
 * schema declares seven, so `verification`, `verifyAttempts` and `dataQuality`
 * were silently discarded on every UI save — create, auto-retag and human edit
 * alike. Around 447 records across 50 entries, each bought with a real vision
 * call. Fail-closed, so nothing false was ever served; it just threw the evidence
 * away.
 *
 * The obvious fix — preserve the whole prior map — is WORSE than the bug. A retag
 * re-extracts every value from the same screenshot, and a human edit rewrites
 * prose. Carrying the old records onto new values would serve text nobody checked
 * as `image-confirmed`. That is trust laundering, and it is exactly what the
 * deferred `claimHash` work exists to prevent.
 *
 * The rule this module implements instead:
 *
 *   1. Records come from the STORED entry, never from the request. The PUT path
 *      builds its entry wholly from the client body, so a caller could otherwise
 *      post a verification map and have it served as trust.
 *   2. A record survives only if the field's value is UNCHANGED between the stored
 *      and the incoming entry.
 *   3. A record under a key nothing serves is dropped rather than carried.
 *
 * No `claimHash` needed: at an update both versions of the entry are in hand, so
 * the comparison the hash would enable can be done directly. The canonical
 * comparison here is deliberately the same shape `claimHash` will need — recursive
 * key sort, array order significant, null distinct from absent — so the two cannot
 * disagree when that work lands.
 *
 * PURE. No I/O.
 */
import type { CorpusEntryT } from "./schema.js";
import { SERVABLE_FIELD_KEYS } from "./corpus-trust.js";

/**
 * Where a verification key's CLAIM actually lives, when it differs from the key.
 *
 * `antiPatterns` is a container holding `antiPatterns` (the prose list),
 * `accessibilityRisks`, `whereThisFails` and legacy notes — but the verifier's
 * `antiPatterns` claim is only the prose list (`claimForField`). Comparing the
 * whole container would revoke the record when an unrelated sibling changed, and
 * `antiPatterns.accessibilityRisks` has its own key and its own record.
 */
const CLAIM_PATH: Readonly<Record<string, string>> = {
  antiPatterns: "antiPatterns.antiPatterns",
};

/**
 * The value a verification key refers to. Keys are dotted corpus paths and mix
 * containers with leaves, so this walks rather than switching on a fixed list.
 * Returns `undefined` for an absent or unreachable path instead of throwing.
 */
export function valueAtFieldKey(entry: CorpusEntryT, field: string): unknown {
  const path = CLAIM_PATH[field] ?? field;
  return rawValueAt(entry, path);
}

function rawValueAt(entry: CorpusEntryT, field: string): unknown {
  let node: unknown = entry;
  for (const segment of field.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/** Recursive key sort; array order preserved; `undefined` dropped, `null` kept. */
function canonical(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v === undefined) continue;
    out[key] = canonical(v);
  }
  return out;
}

/**
 * True when two field values represent the same claim.
 *
 * Array order is significant on purpose: `visual.dominantColors` is ranked, so a
 * reordering is a different claim about which colour dominates. Key order is not.
 * `null` differs from absent — nulling a field is a claim change, and after Task 1
 * a null `usesShadows` specifically means "no claim", which must not inherit a
 * record written when the field said `true`.
 */
export function sameClaim(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/**
 * Returns a copy of `next` carrying the prior entry's provenance, with every
 * verification record whose field changed dropped.
 *
 * All three field-keyed maps — `verification`, `verifyAttempts`, `dataQuality` —
 * are filtered the same way; see the note inside. `taggedBy` and `taggedAt`
 * already set on `next` win, so this composes with `stampProvenance` in either
 * order. `prior` may be undefined, in which case every field-keyed map comes back
 * empty rather than the request's own being trusted.
 *
 * Non-mutating.
 */
export function carryVerification(next: CorpusEntryT, prior: CorpusEntryT | undefined): CorpusEntryT {
  const out = structuredClone(next);
  const priorProvenance = prior?.provenance;
  const nextProvenance = out.provenance as Record<string, unknown> | undefined;

  /**
   * All THREE field-keyed maps are filtered by changed value, not just
   * `verification`.
   *
   * An earlier draft carried `verifyAttempts` and `dataQuality` wholesale, on the
   * reasoning that an attempt count is work-done rather than a claim and that
   * dropping a finding would let a rewrite clear a known problem. Review showed
   * both wrong:
   *  - `verifyAttempts` feeds `alreadyProcessedAtVersion`/`selectPending`, so a
   *    stale entry SUPPRESSES re-verification of the value that just changed.
   *  - a `dataQuality` finding is evidence against the OLD value. Keeping it after
   *    a rewrite asserts a contradiction about text that no longer exists.
   * A rewrite legitimately clears a finding about the text it replaced.
   */
  const filtered = (map: Record<string, unknown> | undefined): Record<string, unknown> => {
    const kept: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(map ?? {})) {
      if (!SERVABLE_FIELD_KEYS.has(field)) continue;
      if (prior === undefined) continue;
      if (!sameClaim(valueAtFieldKey(prior, field), valueAtFieldKey(next, field))) continue;
      kept[field] = structuredClone(value);
    }
    return kept;
  };

  // Every field-keyed map is rebuilt from the PRIOR entry. `next`'s own maps are
  // untrusted input on the PUT path (the entry there is the client's body), so
  // they are never read — which is why an absent prior yields empty maps rather
  // than passing the request's through.
  const verification = filtered(priorProvenance?.verification as Record<string, unknown> | undefined);
  const verifyAttempts = filtered(priorProvenance?.verifyAttempts as Record<string, unknown> | undefined);
  const dataQuality = filtered(priorProvenance?.dataQuality as Record<string, unknown> | undefined);

  const merged: Record<string, unknown> = {
    ...priorProvenance,
    // Anything the caller deliberately set on `next` (a taggedBy flip, a fresh
    // taggedAt) outranks the prior value.
    ...nextProvenance,
  };
  // Only emit a map that has something in it, and only if the prior carried one —
  // adding an empty `verification: {}` to an entry that never had provenance would
  // produce a provenance object with no `taggedBy`, which the schema rejects.
  for (const [key, value] of Object.entries({ verification, verifyAttempts, dataQuality })) {
    if (Object.keys(value).length > 0) merged[key] = value;
    else delete merged[key];
  }

  if (Object.keys(merged).length === 0) {
    delete (out as Record<string, unknown>).provenance;
    return out;
  }
  out.provenance = merged as CorpusEntryT["provenance"];
  return out;
}
