/**
 * corpus-trust.ts — the trust gate for corpus-derived values.
 *
 * The corpus records who TOUCHED an entry (`provenance.taggedBy`) and never what
 * was CHECKED. `taggedBy: "auto-reviewed"` is machine-stamped (`ui/app.js:1375`,
 * `:1488`) and `reviewStatus` is `approved` on 787/787 entries, so neither field
 * carries trust information. This module reads a different record —
 * `provenance.verification` — which states HOW a value was checked.
 *
 * PURE AND SYNCHRONOUS BY DESIGN. It performs no I/O. An earlier draft took a
 * `resolveImagePath` so it could refuse entries whose image had gone missing;
 * that resolver validates path SHAPE only (`paths.ts:132`), and more importantly
 * a missing image does not invalidate a past verification — the record attests a
 * claim was checked when the image existed, and the caller never sees the
 * screenshot. Image existence and hash staleness are corpus-integrity checks and
 * live in `doctor.ts`.
 */
import type { CorpusEntryT } from "./schema.js";

/**
 * The evidence tiers a verification record may claim. Anything else — including a
 * tier a NEWER verifier introduces — reads as not verified, so an old build can
 * never serve a value it does not understand.
 */
export const VERIFICATION_METHODS: ReadonlySet<string> = new Set([
  "measured",
  "provable",
  "image-confirmed",
]);

/**
 * The corpus field keys the gate knows how to serve. This is the contract
 * between the verifier (Stage 2b/2c) and the gate: every served field must be
 * reachable through exactly one key, and a key names a claim a verifier can
 * check. Keys are corpus field paths (`visual.colorRoles`, `critique`, …). A
 * record written under any other key is a silent no-op; `doctor.ts` reports it
 * as `verification-orphan-key`.
 */
export const SERVABLE_FIELD_KEYS: ReadonlySet<string> = new Set([
  "visual.colorRoles",
  "visual.accentColor",
  "visual.dominantColors",
  "visual.spacingDensity",
  "visual.cornerStyle",
  "visual.usesShadows",
  "visual.usesBorders",
  "visual.typePairing",
  "layout",
  "critique",
  "whatToSteal",
  "antiPatterns",
  "antiPatterns.accessibilityRisks",
  "voice",
  "components",
  "responsiveBehavior",
  "patternType",
  "platform",
  "styleTags",
  "categories",
  "mood",
  "colorScheme",
  "domainTags",
]);

/**
 * True when the entry carries a verification record for THIS field that this
 * build understands. The field parameter is REQUIRED: every call site must
 * state which claim it is asking about, and a site that cannot name its field
 * has not understood what it gates.
 *
 * Fail-closed on every other input: no provenance, no record under the key, an
 * unrecognised method, or an `image-confirmed` record missing the image hash
 * that binds it to the bytes the verifier saw.
 */
export function isVerified(entry: CorpusEntryT, field: string): boolean {
  const record = entry.provenance?.verification?.[field];
  if (!record) return false;
  // A record under a key nothing serves is a silent no-op: trust attaches only
  // to the servable field keys (the contract between verifier and gate).
  if (!SERVABLE_FIELD_KEYS.has(field)) return false;
  if (!VERIFICATION_METHODS.has(record.method)) return false;
  // `imageSha256` is optional on the type and mandatory by method: the measured
  // tier's evidence is the live DOM, not the pixels, so binding it to an image
  // hash would tie the record to the wrong artifact.
  if (record.method === "image-confirmed" && !record.imageSha256) return false;
  return true;
}

/**
 * The set of fields the entry is verified for. For the sites that need the set
 * rather than a single answer: the per-tool field-set wiring in `createServer`,
 * doctor's per-key reporting, and the `unassessed-quality` exemption.
 */
export function verifiedFields(entry: CorpusEntryT): ReadonlySet<string> {
  const verification = entry.provenance?.verification;
  if (!verification) return new Set();
  return new Set(Object.keys(verification).filter((field) => isVerified(entry, field)));
}

/**
 * The evidence method behind a verified field — for disclosure, so an agent
 * can weigh "recomputed from data" (provable) vs "confirmed against the
 * image" (image-confirmed). Null when the field is not verified. Reuses
 * `isVerified` so a record this build does not understand never leaks its
 * method string into a disclosure.
 */
export function verifiedMethodFor(entry: CorpusEntryT, field: string): string | null {
  const record = entry.provenance?.verification?.[field];
  if (!record || !isVerified(entry, field)) return null;
  return record.method;
}

/**
 * The evidence ids of the matched entries verified FOR THE GIVEN FIELD. Shared
 * by BOTH consumers — the model lane's prompt-grounding filter (superseded by
 * the per-field strip in Task 3) and the deterministic synthesizer — so trust
 * is defined in exactly one place and the two paths cannot drift.
 */
export function trustedEvidenceIdsOf(
  matchedEntries: readonly { readonly evidenceId: string; readonly entry: CorpusEntryT }[],
  field: string,
): Set<string> {
  return new Set(matchedEntries.filter((m) => isVerified(m.entry, field)).map((m) => m.evidenceId));
}
