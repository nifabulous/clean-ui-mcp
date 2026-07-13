import type { CorpusEntryT } from "../schema.js";

/**
 * publication/policy.ts — the single redistribution-eligibility decision for a
 * corpus entry. Mode-agnostic: consumed identically by readers (Task 4) and the
 * exporter (Task 3). Put no reader/exporter/mode logic in here.
 *
 * PURE: no I/O, no filesystem reads, no clock access. The current date arrives
 * through `ctx.now` and the image-file-existence check arrives through
 * `ctx.imageExists`, so the decision is fully deterministic in tests.
 *
 * The eligibility contract has two independent axes that BOTH must pass:
 *
 *   1. ENTRY axis  — visibility, clearance, and the evidence of that clearance
 *      (rights basis, evidence ref, reviewer, review date, expiry).
 *   2. IMAGE axis  — the raster's visibility, path, path prefix, dimensions,
 *      and on-disk existence. An approved entry with a private image is still
 *      ineligible; a public image does not rescue a private entry.
 *
 * On failure, ALL applicable reasons are returned in the stable order declared
 * by {@link PublicationReason} (entry-axis reasons first, then image-axis). This
 * stable order is what the test suite pins down — do not reorder.
 */

/**
 * Every reason an entry may be ineligible for publication. Order is significant:
 * reasons accumulate in this order. Entry-axis reasons precede image-axis
 * reasons.
 */
export type PublicationReason =
  // ── entry axis ──
  | "entry-private"
  | "clearance-unreviewed"
  | "clearance-rejected"
  | "missing-rights-basis"
  | "missing-evidence"
  | "missing-reviewer"
  | "missing-review-date"
  | "clearance-expired"
  // ── image axis (only for entries that ship a raster; link-only entries with
  // private visibility + null path bypass these — no bytes to redistribute) ──
  | "image-private"
  | "image-path-missing"
  | "image-path-not-public"
  | "image-file-missing"
  | "image-metadata-missing"
  // ── link-only axis (private visibility + null path) ──
  | "link-source-missing";

/**
 * The eligibility decision. `{eligible: true}` when an entry may ship in the
 * open-source corpus; otherwise the exhaustive list of reasons it may not.
 */
export type PublicationDecision =
  | { eligible: true }
  | { eligible: false; reasons: PublicationReason[] };

/**
 * Context injected by the caller so the decision stays pure and deterministic.
 *
 * - `now`: the current date as a YYYY-MM-DD string. Used for the expiry check.
 *   Injected (not `new Date()`) so tests are deterministic.
 * - `imageExists`: given a corpus-relative image path, returns whether the file
 *   exists on disk. Injected (not `existsSync`) so tests run without fixtures.
 */
export interface PublicationContext {
  now: string;
  imageExists: (path: string) => boolean;
}

/**
 * Decide whether `entry` is eligible to ship in the open-source corpus, and if
 * not, why. See the module docstring for the full contract.
 */
export function evaluatePublication(
  entry: CorpusEntryT,
  ctx: PublicationContext,
): PublicationDecision {
  const reasons: PublicationReason[] = [];

  // ── entry axis ────────────────────────────────────────────────────────────
  // Two tiers of reasons:
  //   - Primary gates: visibility + clearance. These explain WHY the entry
  //     isn't shippable on their own. An entry that fails one of these does not
  //     ALSO get its evidence gates (rights/evidence/reviewer/date) flagged —
  //     that would pile redundant noise onto "it's private" or "it's
  //     unreviewed." A reviewer reads one clear reason, not five.
  //   - Evidence gates: only evaluated for an entry that is public AND
  //     approved. At that point the entry is asserting it's ready to ship, so
  //     the evidence of that readiness is the remaining question.
  const pub = entry.publication;

  if (!pub || pub.visibility !== "public") {
    reasons.push("entry-private");
  } else {
    // clearance: exactly one of unreviewed/rejected when not approved. An
    // approved entry passes this gate and proceeds to the evidence gates.
    if (pub.clearance === "unreviewed") {
      reasons.push("clearance-unreviewed");
    } else if (pub.clearance === "rejected") {
      reasons.push("clearance-rejected");
    } else {
      // Approved: the evidence of that approval is now load-bearing. Each
      // missing field is an independent reason.
      if (!pub.rightsBasis) reasons.push("missing-rights-basis");
      if (!pub.evidenceRef) reasons.push("missing-evidence");
      if (!pub.reviewedBy) reasons.push("missing-reviewer");
      if (!pub.reviewedAt) reasons.push("missing-review-date");
    }

    // Expiry: absent expiresAt = no recorded expiry (never expires on this
    // axis). expiresAt >= now is still valid (clearance good through end-of-day).
    // Applies to approved entries only — an unreviewed/rejected entry has no
    // clearance to expire. String comparison is safe here: YYYY-MM-DD lexicographic
    // order equals chronological order for zero-padded ISO dates.
    if (pub.clearance === "approved" && pub.expiresAt && pub.expiresAt < ctx.now) {
      reasons.push("clearance-expired");
    }
  }

  // ── image axis ────────────────────────────────────────────────────────────
  // The image axis gates whether image BYTES may ship. But the corpus's value
  // is the structured analysis (critique, color roles, type pairings, anti-
  // patterns), not the raster pixels. An entry with image.path === null AND
  // image.visibility === "private" is a LINK-ONLY entry: no image bytes ship,
  // the entry's value is its metadata + critique, and source.url links to the
  // original design. This is the safest distribution model — no third-party
  // image redistribution, just knowledge.
  //
  // The link-only exception is restricted to private visibility + null path.
  // A public-own/public-thumb entry with a null path is schema-invalid
  // (ImageRef.superRefine rejects it) — the evaluator is mode-agnostic and
  // must not depend on schema validation, so it catches this independently
  // via image-path-missing.
  //
  // Link-only entries MUST have a non-null source.url — it's the only way
  // users can find the original design when no image ships. A null source.url
  // on a link-only entry makes it an orphan with no reference.
  const image = entry.image;

  if (image.visibility === "private" && image.path === null) {
    // Link-only entry: no image bytes to redistribute. Require source.url
    // so users can find the original design.
    if (!entry.source.url) {
      reasons.push("link-source-missing");
    }
  } else if (image.path === null) {
    // Non-private visibility with null path: schema-invalid, caught here
    // independently (the evaluator must not assume schema enforcement).
    reasons.push("image-path-missing");
  } else {
    const isPublicVisibility = image.visibility === "public-thumb" || image.visibility === "public-own";
    if (!isPublicVisibility) {
      reasons.push("image-private");
    } else {
      if (!image.path.startsWith("images-public/")) {
        reasons.push("image-path-not-public");
      }

      if (image.width === null || image.height === null) {
        reasons.push("image-metadata-missing");
      }

      // File existence: only meaningful when there's a resolvable public path.
      if (image.path.startsWith("images-public/") && !ctx.imageExists(image.path)) {
        reasons.push("image-file-missing");
      }
    }
  }

  if (reasons.length === 0) {
    return { eligible: true };
  }
  return { eligible: false, reasons };
}
