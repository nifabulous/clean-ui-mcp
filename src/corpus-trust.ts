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
 * True when the entry carries a verification record this build understands.
 *
 * Fail-closed on every other input: no provenance, no verification, an
 * unrecognised method, or an `image-confirmed` record missing the image hash that
 * binds it to the bytes the verifier saw.
 */
export function isVerified(entry: CorpusEntryT): boolean {
  const verification = entry.provenance?.verification;
  if (!verification) return false;
  if (!VERIFICATION_METHODS.has(verification.method)) return false;
  // `imageSha256` is optional on the type and mandatory by method: the measured
  // tier's evidence is the live DOM, not the pixels, so binding it to an image
  // hash would tie the record to the wrong artifact.
  if (verification.method === "image-confirmed" && !verification.imageSha256) return false;
  return true;
}

/**
 * The evidence ids of the matched entries that pass the gate. Shared by BOTH
 * consumers — the model lane's prompt-grounding filter (create-ui-spec.ts) and
 * the deterministic synthesizer (create-ui-spec-deterministic.ts) — so trust is
 * defined in exactly one place and the two paths cannot drift.
 */
export function trustedEvidenceIdsOf(
  matchedEntries: readonly { readonly evidenceId: string; readonly entry: CorpusEntryT }[],
): Set<string> {
  return new Set(matchedEntries.filter((m) => isVerified(m.entry)).map((m) => m.evidenceId));
}
