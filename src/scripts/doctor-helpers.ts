/**
 * doctor-helpers.ts — pure, testable diagnostics extracted from doctor.ts (F8).
 *
 * doctor.ts is a script that runs at import time (arg parsing at the top,
 * `process.exit` at the bottom), so importing it into a test triggers the
 * whole health check. The two diagnostics added in Task 6 —
 * publication-readiness and loader-health — live HERE as pure functions that
 * doctor.ts calls and that doctor.test.ts exercises directly with fixtures.
 *
 * The {@link Check}/{@link Status} types are shared between this module and
 * doctor.ts so the Check objects produced here drop straight into doctor.ts's
 * `checks` array and therefore into its `--json` output (which serializes that
 * array verbatim). That's the versioned-contract requirement: a curator or CI
 * script can parse the check `name`/`status`/`detail` fields without depending
 * on doctor.ts's display formatting.
 */
import type { CorpusEntryT } from "../schema.js";
import type { LoadedCorpus } from "../persistence.js";
import {
  evaluatePublication,
  type PublicationContext,
  type PublicationReason,
} from "../publication/policy.js";

export type Status = "PASS" | "WARN" | "FAIL";

export interface Check {
  name: string;
  status: Status;
  detail: string;
}

// ── Publication-readiness diagnostic ──────────────────────────────────────────

/**
 * Tallies of why corpus entries are (in)eligible for publication. Each bucket
 * counts entries that carry the corresponding stable reason code from
 * {@link evaluatePublication}.
 *
 * Buckets are NOT mutually exclusive: an entry can land in several (e.g. a
 * public, approved entry whose image is private counts once in `imagePrivate`,
 * and the same entry is NOT also counted as `missingEvidence` because the
 * policy suppresses the evidence gates once a prior gate fails). `eligible`
 * counts entries with no reasons at all.
 *
 * The bucket keys ARE the versioned contract: they map 1:1 to the reason codes
 * in {@link PublicationReason}, so the doctor's detail line and `--json` output
 * stay stable across UI/format changes. The four `missing-*` evidence codes
 * collapse into a single `missingEvidence` bucket (an entry counts once even if
 * several of its evidence fields are blank) — the bucket answers "how many
 * entries have incomplete clearance evidence," not "how many fields are blank."
 */
export interface PublicationSummary {
  /** Entries cleared to ship in the open-source corpus (no reasons). */
  eligible: number;
  /** entry-private — visibility is private, or the publication block is absent. */
  private: number;
  /** clearance-unreviewed. */
  unreviewed: number;
  /** clearance-rejected. */
  rejected: number;
  /** At least one of: missing-rights-basis / missing-evidence / missing-reviewer / missing-review-date. */
  missingEvidence: number;
  /** clearance-expired. */
  expired: number;
  /** image-private. */
  imagePrivate: number;
}

/** The evidence-gate reason codes that roll up into `missingEvidence`. */
const MISSING_EVIDENCE_REASONS: ReadonlySet<PublicationReason> = new Set([
  "missing-rights-basis",
  "missing-evidence",
  "missing-reviewer",
  "missing-review-date",
]);

/**
 * Run {@link evaluatePublication} over every entry and tally the reason codes.
 * PURE: no I/O, no clock — `ctx.now` and `ctx.imageExists` are injected by the
 * caller (the same contract the policy evaluator uses) so tests are deterministic.
 *
 * Reason codes outside the 7-bucket contract (image-path-missing,
 * image-path-not-public, image-metadata-missing, image-file-missing) are not
 * tallied — they're image-availability problems surfaced by the existing "Image
 * references resolve" doctor check, not by the publication tally. An entry that
 * is ineligible solely because of one of those still counts as not-eligible
 * (it's absent from `eligible`), it just doesn't increment a summary bucket.
 */
export function summarizePublication(
  entries: readonly CorpusEntryT[],
  ctx: PublicationContext,
): PublicationSummary {
  const s: PublicationSummary = {
    eligible: 0,
    private: 0,
    unreviewed: 0,
    rejected: 0,
    missingEvidence: 0,
    expired: 0,
    imagePrivate: 0,
  };
  for (const entry of entries) {
    const decision = evaluatePublication(entry, ctx);
    if (decision.eligible) {
      s.eligible++;
      continue;
    }
    let countsAsMissingEvidence = false;
    for (const reason of decision.reasons) {
      switch (reason) {
        case "entry-private":
          s.private++;
          break;
        case "clearance-unreviewed":
          s.unreviewed++;
          break;
        case "clearance-rejected":
          s.rejected++;
          break;
        case "clearance-expired":
          s.expired++;
          break;
        case "image-private":
          s.imagePrivate++;
          break;
        default:
          // The four evidence-gate codes share a single bucket. Defer the
          // increment until after the loop so an entry carrying several of
          // them counts once, not once-per-blank-field.
          if (MISSING_EVIDENCE_REASONS.has(reason)) countsAsMissingEvidence = true;
          break;
      }
    }
    if (countsAsMissingEvidence) s.missingEvidence++;
  }
  return s;
}

/**
 * Build the doctor Check row for publication readiness. WARN when nothing is
 * eligible ("publication pipeline has nothing to publish"); otherwise PASS with
 * a detail line showing the tallies using the stable reason-code slugs.
 *
 * The detail line surfaces non-zero buckets with their stable slug names
 * (entry-private, clearance-unreviewed, …) so a curator or script can parse
 * them — this is the versioned contract.
 */
export function publicationCheck(
  entries: readonly CorpusEntryT[],
  ctx: PublicationContext,
): Check {
  const s = summarizePublication(entries, ctx);
  const total = entries.length;
  const parts: string[] = [];
  if (s.private) parts.push(`entry-private:${s.private}`);
  if (s.unreviewed) parts.push(`clearance-unreviewed:${s.unreviewed}`);
  if (s.rejected) parts.push(`clearance-rejected:${s.rejected}`);
  if (s.missingEvidence) parts.push(`missing-evidence:${s.missingEvidence}`);
  if (s.expired) parts.push(`clearance-expired:${s.expired}`);
  if (s.imagePrivate) parts.push(`image-private:${s.imagePrivate}`);
  const tally = parts.length ? ` · ${parts.join(" · ")}` : "";
  if (s.eligible === 0) {
    const reason = total === 0 ? " (empty corpus)" : "";
    return {
      name: "Publication pipeline",
      status: "WARN",
      detail: `publication pipeline has nothing to publish${reason}${tally}`,
    };
  }
  return {
    name: "Publication pipeline",
    status: "PASS",
    detail: `${s.eligible}/${total} eligible to publish${tally}`,
  };
}

// ── Loader-health diagnostic ──────────────────────────────────────────────────

/**
 * Provenance of the loaded corpus. Mirrors the fields on {@link LoadedCorpus}
 * that a curator needs to answer "is my working corpus backed by the primary
 * file, or am I running on recovered fallback data?"
 */
export interface LoaderHealth {
  source: "primary" | "snapshot" | "seed" | "empty";
  writable: boolean;
  version: number;
  entryCount: number;
}

/**
 * Project a {@link LoadedCorpus} into the flat health view the doctor reports.
 * PURE: just selects/relabels fields — no I/O. Tested directly with fixture
 * LoadedCorpus objects of each source type.
 */
export function summarizeLoaderHealth(loaded: LoadedCorpus): LoaderHealth {
  return {
    source: loaded.source,
    writable: loaded.writable,
    version: loaded.version,
    entryCount: loaded.entries.length,
  };
}

/**
 * Build the doctor Check row for loader health.
 *
 *   - FAIL when source is "seed" or "empty": the curator's working corpus is
 *     missing — a save here would either no-op (read-only) or, worse, risk
 *     clobbering. This is the red alarm the Gate 1A hardening exists to surface.
 *   - WARN when source is "snapshot": recovered data is loaded read-only; the
 *     primary should be re-saved (via restore-corpus) to persist the recovery.
 *   - PASS when source is "primary": the real working corpus is backing the
 *     session and is writable.
 */
export function loaderHealthCheck(loaded: LoadedCorpus): Check {
  const h = summarizeLoaderHealth(loaded);
  const detail = `source:${h.source} · ${h.entryCount} entries · v${h.version} · ${h.writable ? "writable" : "read-only"}`;
  if (h.source === "seed" || h.source === "empty") {
    return {
      name: "Corpus loader source",
      status: "FAIL",
      detail: `${detail} — curator's working corpus is missing; run \`npm run restore-corpus -- --latest\``,
    };
  }
  if (h.source === "snapshot") {
    return {
      name: "Corpus loader source",
      status: "WARN",
      detail: `${detail} — running on recovered data; re-save to persist (run \`npm run restore-corpus -- --latest\`)`,
    };
  }
  return {
    name: "Corpus loader source",
    status: "PASS",
    detail,
  };
}
