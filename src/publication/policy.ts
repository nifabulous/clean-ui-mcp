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
  // ── image axis ──
  | "image-private"
  | "image-path-missing"
  | "image-path-not-public"
  | "image-file-missing"
  | "image-metadata-missing";

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
  // Mirrors the cascade in ImageRef.superRefine (schema.ts): a private image is
  // the terminal reason for this axis — its path correctly lives under
  // images-private/ and flagging that as "not public" would be noise. So the
  // path/metadata/file checks only apply to images that are at least trying to
  // be public. This keeps the reasons list focused: a private image reports
  // exactly `image-private`, not a cascade of secondary failures.
  const image = entry.image;
  const isPublicVisibility = image.visibility === "public-thumb" || image.visibility === "public-own";

  if (!isPublicVisibility) {
    reasons.push("image-private");
  } else {
    const path = image.path;
    if (path === null) {
      reasons.push("image-path-missing");
    } else if (!path.startsWith("images-public/")) {
      reasons.push("image-path-not-public");
    }

    if (image.width === null || image.height === null) {
      reasons.push("image-metadata-missing");
    }

    // File existence: only meaningful when there's a resolvable public path.
    // If the path is missing or mis-prefixed, the path reason already explains
    // the failure; naming a file that can't be resolved would be noise.
    if (path !== null && path.startsWith("images-public/") && !ctx.imageExists(path)) {
      reasons.push("image-file-missing");
    }
  }

  if (reasons.length === 0) {
    return { eligible: true };
  }
  return { eligible: false, reasons };
}
