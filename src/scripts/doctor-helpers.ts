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
import { detectPlatform } from "../schema.js";
// The doctor's verification checks MUST agree with the serve gate, so they use
// its predicate rather than a looser local condition.
import { verifiedFields, SERVABLE_FIELD_KEYS, VERIFICATION_METHODS } from "../corpus-trust.js";
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

// ── Corpus defect detectors (C3 trust gate, Stage 1) ──────────────────────────
//
// These detectors found 768 of 787 real entries defective, which is why
// the C3 trust gate serves nothing corpus-derived by default. They live here as
// a STANDING health check so a regression surfaces without a one-off script.
//
// THEY REPORT ONLY. They must never write `provenance.verification` and must
// never un-gate anything. Mechanical cleanliness is necessary and NOT sufficient:
// the worst entry found in the audit had a wholly fabricated critique that trips
// zero of these detectors, so granting trust from a clean bill of health here
// would re-ship the same fabrication class with a trust label attached. Only a
// verifier that actually looks at the image can grant trust.

/** A stable slug per detector, so a curator or CI script can parse the tallies. */
export type CorpusDefectDetector =
  | "role-collapse"
  | "low-contrast"
  | "fabricated-hex"
  | "accent-mismatch"
  | "rail-on-portrait"
  | "mono-unrecorded"
  | "typeface-unrecorded"
  | "neumorphic-no-shadow"
  | "unassessed-quality"
  | "verified-image-missing"
  | "verified-hash-stale"
  | "verification-malformed"
  | "verification-orphan-key"
  | "platform-record-stale"
  | "dataquality-malformed"
  | "dataquality-orphan-key"
  | "dataquality-hash-stale"
  | "dataquality-count";

export interface CorpusDefectFinding {
  /** The corpus entry id the defect was found on. */
  id: string;
  detector: CorpusDefectDetector;
  /** One line a curator can act on. */
  message: string;
}

/**
 * Filesystem access the verification-integrity detectors need, INJECTED so
 * the detectors stay pure and unit-testable (same pattern as
 * {@link PublicationContext}'s `imageExists`).
 *
 * `imageSha256` returns null when the file cannot be read. It is called ONLY for
 * entries carrying an `image-confirmed` verification record or a pixel-pinned
 * `dataQuality` finding — hashing every image would make the doctor read the
 * entire corpus off disk on every run.
 */
export interface CorpusDefectContext {
  imageExists: (corpusRelPath: string) => boolean;
  imageSha256: (corpusRelPath: string) => string | null;
}

/**
 * The lanes a dataQuality record's `source` may name: the detector registry
 * keys (detector name = registry key) plus "vision" for the model lane. Kept
 * local on purpose — importing detector-registry would pull the tagger chain
 * into the doctor hot path. Keep in sync with detector-registry.ts (a test
 * cross-checks this set against the registry keys).
 */
export const DATA_QUALITY_SOURCES = new Set([
  "platform",
  "visual.dominantColors",
  "visual.usesBorders",
  "visual.usesShadows",
  "visual.accentColor",
  "visual.cornerStyle",
  "visual.spacingDensity",
  "visual.colorRoles",
  "antiPatterns.accessibilityRisks",
  "vision",
]);

const HEX_IN_PROSE = /#[0-9a-f]{6}\b/gi;
/** Font families whose name declares a monospace face. */
const MONO_FACE = /\b(mono|menlo|consolas|courier|monaco|inconsolata)\b/i;
/**
 * Prose that CLAIMS a monospace treatment.
 *
 * "tabular figures/numerals" is deliberately NOT here. Tabular figures are an
 * OpenType feature of PROPORTIONAL faces (`font-variant-numeric: tabular-nums`)
 * — Inter ships them — so a tabular claim implies no monospace family at all.
 * Including it produced a provably false finding for
 * `quicken-quicken-web-screens-19-2026-07-05` (records Inter/Inter, says columns
 * are "locked to tabular numerals") and 4 other real entries.
 */
const MONO_CLAIM = /\bmono-?spaced?\b|\bmonospace\b/i;
/**
 * Rail roles that a portrait/mobile viewport physically cannot show. `icon-nav`
 * is included: schema.ts:296 defines it as a "narrow icon-only rail", as
 * impossible on a phone portrait as `primary-nav`. Omitting it left 11 real
 * entries with an icon rail on a portrait capture reporting NO finding at all.
 */
const RAIL_ROLES = new Set(["primary-nav", "icon-nav", "detail-rail"]);

/** sRGB relative luminance per WCAG 2.1 §relativeluminancedef. */
function relativeLuminance(hex: string): number | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const channels = [0, 2, 4].map((i) => {
    const c = parseInt(m[1]!.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

/** WCAG contrast ratio, or null when either colour is unparseable. */
export function contrastRatio(a: string, b: string): number | null {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return null;
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Every hex the entry records in ANY colour field — the fabrication baseline. */
function recordedHexes(entry: CorpusEntryT): Set<string> {
  const visual = (entry.visual ?? {}) as Record<string, unknown>;
  const roles = (visual.colorRoles ?? {}) as Record<string, unknown>;
  const out = new Set<string>();
  const add = (v: unknown): void => {
    if (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v.trim())) out.add(v.trim().toLowerCase());
  };
  add(visual.accentColor);
  for (const v of Object.values(roles)) add(v);
  if (Array.isArray(visual.dominantColors)) for (const v of visual.dominantColors) add(v);
  return out;
}

/** The prose positions a fabricated hex or a mono claim can hide in. */
function proseOf(entry: CorpusEntryT): string {
  const visual = (entry.visual ?? {}) as Record<string, unknown>;
  const pairing = (visual.typePairing ?? {}) as Record<string, unknown>;
  const parts: unknown[] = [
    entry.critique,
    ...(Array.isArray(entry.whatToSteal) ? entry.whatToSteal : []),
    pairing.notes,
  ];
  return parts.filter((p): p is string => typeof p === "string").join(" \n ");
}

/**
 * Every defect finding across the corpus, one row per (entry, detector) pair.
 *
 * Findings measured on the real 787-entry corpus (2026-08-04, after the
 * review-round detector corrections) as the comparison baseline for a future
 * run. 768 of 787 entries carry at least one finding:
 *
 *   low-contrast 1477 rows/646 entries · unassessed-quality 737 · role-collapse
 *   168 rows/144 entries · rail-on-portrait 127 rows/101 entries ·
 *   fabricated-hex 99 rows/85 entries · accent-mismatch 27 ·
 *   neumorphic-no-shadow 24 · mono-unrecorded 12 · typeface-unrecorded 9
 *
 * These supersede an earlier baseline (role-collapse 81, low-contrast 65,
 * fabricated-hex 65, rail-on-portrait 90, mono-unrecorded 26,
 * neumorphic-no-shadow 24, accent-mismatch 27, unassessed-quality 725) taken
 * with ad-hoc queries before these detectors existed. Where the numbers differ:
 *
 *   - low-contrast rose because it now checks all four text-on-background pairs
 *     (ink/muted on canvas/surface) at two tiers, not ink-on-canvas at one.
 *   - rail-on-portrait rose because `icon-nav` joined the rail set.
 *   - mono-unrecorded FELL because a tabular-figures claim is no longer treated
 *     as a monospace claim, and entries with no recorded face split out into
 *     typeface-unrecorded.
 *   - unassessed-quality rose because the exemption is now a real verification
 *     record rather than the machine-stamped `taggedBy`.
 *   - fabricated-hex differs because it reads `whatToSteal` and
 *     `typePairing.notes` in addition to `critique`, and counts rows per colour.
 *   - role-collapse emits one row per COLLIDING PAIR, which explains 168 rows
 *     against 144 entries. It does NOT explain 144 entries against the earlier
 *     81: no pair subset reproduces 81, so that figure could not be reproduced
 *     and is treated as unexplained rather than accounted for.
  */
export function summarizeCorpusDefects(
  entries: readonly CorpusEntryT[],
  ctx: CorpusDefectContext,
): CorpusDefectFinding[] {
  const findings: CorpusDefectFinding[] = [];
  for (const entry of entries) {
    const id = String(entry.id);
    const push = (detector: CorpusDefectDetector, message: string): void => {
      findings.push({ id, detector, message });
    };
    const visual = (entry.visual ?? {}) as Record<string, unknown>;
    const roles = (visual.colorRoles ?? null) as Record<string, string | null> | null;

    if (roles) {
      // Role collapse. `canvas === surface` is EXCLUDED: a flat design with no
      // raised surface is a legitimate choice, not a defect. Every other pair
      // collapsing means two semantic roles resolve to one value — a functional
      // bug (accent invisible against the page, text the colour of its
      // background), not a cosmetic one.
      const names = ["canvas", "surface", "ink", "muted", "accent"] as const;
      for (let i = 0; i < names.length; i += 1) {
        for (let j = i + 1; j < names.length; j += 1) {
          const a = names[i]!;
          const b = names[j]!;
          if (a === "canvas" && b === "surface") continue;
          const va = roles[a];
          const vb = roles[b];
          if (typeof va === "string" && typeof vb === "string" && va.toLowerCase() === vb.toLowerCase()) {
            push("role-collapse", `colorRoles.${a} and colorRoles.${b} are both ${va}`);
          }
        }
      }
      // EVERY text-on-background pair the roles describe, not just ink-on-canvas.
      // CLAUDE.md records `--text-muted` shipping at 1.90:1 as a real defect, and
      // ink-on-canvas alone cannot see it: 432 real entries have muted below 3:1
      // on canvas and 109 have ink below 3:1 on surface, all previously silent.
      // 3:1 is the floor for "unreadable at any size"; the AA 4.5:1 tier is
      // reported separately so a curator can triage the hard failures first.
      for (const [fg, bg] of [["ink", "canvas"], ["ink", "surface"], ["muted", "canvas"], ["muted", "surface"]] as const) {
        const a = roles[fg];
        const b = roles[bg];
        if (typeof a !== "string" || typeof b !== "string") continue;
        const ratio = contrastRatio(a, b);
        if (ratio === null) continue;
        if (ratio < 3) {
          push("low-contrast", `${fg} ${a} on ${bg} ${b} is ${ratio.toFixed(2)}:1 (below the 3:1 readability floor)`);
        } else if (ratio < 4.5) {
          push("low-contrast", `${fg} ${a} on ${bg} ${b} is ${ratio.toFixed(2)}:1 (below the WCAG AA 4.5:1 floor)`);
        }
      }
      // The two accent fields are the same design decision recorded twice; when
      // they disagree there is no way to tell which one a consumer should use.
      const accentColor = visual.accentColor;
      if (typeof accentColor === "string" && typeof roles.accent === "string"
        && accentColor.toLowerCase() !== roles.accent.toLowerCase()) {
        push("accent-mismatch", `visual.accentColor ${accentColor} != colorRoles.accent ${roles.accent}`);
      }
    }

    // A hex cited in prose that appears in NO colour field was invented by the
    // tagger: it describes a colour the entry does not record.
    // Deduped per COLOUR, not per mention: real entries cite the same unrecorded
    // hex twice in one critique, and two rows for one defect inflates the tally.
    const recorded = recordedHexes(entry);
    const prose = proseOf(entry);
    const reported = new Set<string>();
    for (const match of prose.match(HEX_IN_PROSE) ?? []) {
      const hex = match.toLowerCase();
      if (recorded.has(hex) || reported.has(hex)) continue;
      reported.add(hex);
      push("fabricated-hex", `prose cites ${match}, which appears in no colour field`);
    }

    // A left nav or right rail cannot exist on a portrait capture; claiming one
    // means the layout was inferred rather than observed.
    const image = (entry.image ?? {}) as Record<string, unknown>;
    const w = typeof image.width === "number" ? image.width : null;
    const h = typeof image.height === "number" ? image.height : null;
    const portrait = w !== null && h !== null && h > w;
    const layout = (entry.layout ?? null) as { regions?: readonly { role?: string }[] } | null;
    if (portrait && layout?.regions) {
      for (const region of layout.regions) {
        if (region.role && RAIL_ROLES.has(region.role)) {
          push("rail-on-portrait", `region ${region.role} on a ${w}x${h} portrait capture`);
        }
      }
    }

    // TypePairing records only `display` and `body` (schema.ts:405) — there is no
    // mono slot — so prose claiming a monospace treatment has nothing backing it
    // unless one of those two faces is itself a mono family.
    const pairing = (visual.typePairing ?? {}) as Record<string, unknown>;
    if (MONO_CLAIM.test(prose)) {
      const faces = [pairing.display, pairing.body].filter((f): f is string => typeof f === "string");
      if (faces.length === 0) {
        // No face recorded at all. The honest finding is "nothing to check
        // against", NOT "the recorded faces are not mono" — reporting the latter
        // sends a curator to fix a typeface that was never written down.
        push("typeface-unrecorded", `prose claims a typographic treatment but no typeface is recorded`);
      } else if (!faces.some((f) => MONO_FACE.test(f))) {
        push("mono-unrecorded", `prose claims a monospace treatment; no recorded face is a mono family`);
      }
    }

    // Neumorphism IS soft shadows. The style tag and the flag contradict.
    const styleTags = Array.isArray(entry.styleTags) ? entry.styleTags : [];
    if (styleTags.includes("soft-neumorphic") && visual.usesShadows === false) {
      push("neumorphic-no-shadow", `styleTag soft-neumorphic with usesShadows: false`);
    }

    // The tagger's untouched defaults: score 3 + tier "exceptional" is the
    // placeholder being read as a judgment.
    //
    // The exemption is a real VERIFICATION record, never `taggedBy`. An earlier
    // version exempted `taggedBy === "auto-reviewed"`, which `ui/app.js:1375`
    // stamps on save with no quality assessment at all — and which
    // `corpus-trust.ts` documents as carrying no trust information. Simulating
    // that stamp corpus-wide silenced all 737 of this detector's findings without
    // improving one datum, so the metric improved as the data stayed exactly as
    // bad. (Measured against the detectors as they ship now; an earlier figure of
    // 1224 -> 499 predates the low-contrast widening and no longer reproduces.) That is the presence-not-usability failure CLAUDE.md
    // forbids, in the detector meant to measure it.
    // The tagger's untouched defaults: score 3 + tier "exceptional" is the
    // placeholder being read as a judgment. The exemption is a real
    // VERIFICATION record under any servable key — this is the one site where
    // any-key suffices, because it is a curation nag, not a serve gate.
    if (entry.qualityScore === 3 && entry.qualityTier === "exceptional"
      && verifiedFields(entry).size === 0) {
      push("unassessed-quality", `qualityScore 3 + tier "exceptional" with no verification record — never assessed`);
    }

    // ── Verification integrity, per key. One malformed record among ten names
    // the key that is wrong, and a record under a key nothing reads is a
    // silent no-op the serve path would never notice.
    const verification = entry.provenance?.verification;
    if (verification) {
      for (const [field, record] of Object.entries(verification)) {
        if (!VERIFICATION_METHODS.has(record.method)) {
          push(
            "verification-malformed",
            `verification record for "${field}" uses method "${record.method}", `
            + `which is not one this build accepts (${[...VERIFICATION_METHODS].join(", ")})`,
          );
          continue;
        }
        if (record.method === "image-confirmed" && !record.imageSha256) {
          push(
            "verification-malformed",
            `verification record for "${field}" is image-confirmed but has no imageSha256`,
          );
          continue;
        }
        if (!SERVABLE_FIELD_KEYS.has(field)) {
          push(
            "verification-orphan-key",
            `verification record for "${field}" is not in the servable field set — `
            + `nothing reads it, so the verifier's check is a silent no-op`,
          );
        }
        // `platform` is recorded `provable`, not `image-confirmed` — it's
        // arithmetic on recorded dimensions, not pixel evidence, so it carries
        // no image hash and the staleness check below never runs for it. This
        // re-derives detectPlatform from the recorded dims instead, for ANY
        // verified platform record regardless of method: the invariant
        // "recorded platform matches recorded dims" holds independent of tier.
        // A re-capture that changed dimensions (or a bad backfill) would
        // otherwise leave a stale platform serving with no flag at all.
        if (field === "platform") {
          const w = typeof image.width === "number" ? image.width : null;
          const h = typeof image.height === "number" ? image.height : null;
          // Missing dims is a different, pre-handled case (not this detector's
          // job) — skip silently rather than reporting a false staleness.
          if (w !== null && h !== null) {
            const derived = detectPlatform(w, h);
            if (derived !== entry.platform) {
              push(
                "platform-record-stale",
                `platform is recorded as "${entry.platform}" but its dimensions `
                + `(${w}x${h}) now derive "${derived}" via detectPlatform`,
              );
            }
          }
        }
        // Image integrity checks apply ONLY to image-confirmed records. A
        // `measured` (or `provable`) record's evidence is the live DOM / the
        // recorded data, not the pixels — schema.ts and isVerified both say so —
        // so a missing screenshot does not invalidate it, and Stage 1's "Image
        // references resolve" check already reports missing images. Firing
        // verified-image-missing for a measured record would double-report and
        // falsely imply the verification depends on an artifact it does not use.
        if (record.method === "image-confirmed") {
          const path = typeof image.path === "string" ? image.path : null;
          // `imageExists`/`imageSha256` reach the filesystem through
          // `fromCorpusRelativeImagePath`, which THROWS on any path outside
          // images-*/ (paths.ts:132). A malformed path must produce a finding,
          // not abort the whole `npm run doctor` run.
          const exists = ((): boolean => {
            if (path === null) return false;
            try { return ctx.imageExists(path); } catch { return false; }
          })();
          if (!exists) {
            push(
              "verified-image-missing",
              `entry image-confirmed for "${field}" but its image is missing or unresolvable: ${path ?? "(no path)"}`,
            );
          } else if (record.imageSha256) {
            const actual = ((): string | null => {
              try { return ctx.imageSha256(path!); } catch { return null; }
            })();
            if (actual !== null && actual !== record.imageSha256) {
              push(
                "verified-hash-stale",
                `verification for "${field}" records ${record.imageSha256.slice(0, 12)}… `
                + `but ${path} now hashes to ${actual.slice(0, 12)}…`,
              );
            }
          }
        }
      }
    }
    // ── dataQuality integrity, per key. A contradiction is a PROCESSED
    // outcome, so a malformed or orphaned finding is a silent lie (nobody reads
    // a record under a key nothing serves; nobody trusts a record with an
    // unknown lane), and a finding pinned to pixels that no longer exist proves
    // nothing about the current ones — the Task 15 contract ("doctor owns
    // staleness") says a re-capture must surface for a human to --retriage.
    const dataQuality = entry.provenance?.dataQuality;
    if (dataQuality) {
      for (const [field, record] of Object.entries(dataQuality)) {
        if (!SERVABLE_FIELD_KEYS.has(field)) {
          push(
            "dataquality-orphan-key",
            `dataQuality record for "${field}" is not in the servable field set — nobody reads it, so the contradiction is a silent no-op`,
          );
        }
        if (typeof record.source !== "string" || record.source.length === 0
          || !DATA_QUALITY_SOURCES.has(record.source)
          || typeof record.verifierVersion !== "string" || typeof record.verifiedAt !== "string") {
          push(
            "dataquality-malformed",
            `dataQuality record for "${field}" has an unusable source or version — got source "${String(record.source)}"`,
          );
        }
        // Mirrors verified-hash-stale: a pixel-measured finding whose recorded
        // bytes no longer match the entry's image is stale BY CONSTRUCTION
        // (schema.ts's dataQuality.imageSha256 doc says staleness derives from
        // this). Pixel-free records (source "platform") carry no hash and skip.
        if (record.imageSha256) {
          const path = typeof image.path === "string" ? image.path : null;
          const exists = ((): boolean => {
            if (path === null) return false;
            try { return ctx.imageExists(path); } catch { return false; }
          })();
          if (!exists) {
            push(
              "dataquality-hash-stale",
              `dataQuality for "${field}" is pinned to imageSha256 ${record.imageSha256.slice(0, 12)}… but its image is missing or unresolvable`,
            );
          } else {
            const actual = ((): string | null => {
              try { return ctx.imageSha256(path!); } catch { return null; }
            })();
            if (actual !== null && actual !== record.imageSha256) {
              push(
                "dataquality-hash-stale",
                `dataQuality for "${field}" records ${record.imageSha256.slice(0, 12)}… `
                + `but ${path} now hashes to ${actual.slice(0, 12)}… — re-capture changed the pixels; retriage this finding`,
              );
            }
          }
        }
      }
      // The count EXCLUDES dismissed records: a dismissal is a human decision
      // that the finding is a measurement artefact — it stops nagging the
      // doctor while remaining on the record (Task 15 Step 5B's stated
      // contract, which the Task 17 step code contradicted; the prose wins).
      const total = Object.values(dataQuality).filter((r) => !r.dismissed).length;
      if (total > 0) {
        push("dataquality-count", `${total} contradiction(s) recorded — run the suspect report before trusting these entries`);
      }
    }
  }
  return findings;
}

/**
 * The doctor Check row for corpus defects. WARN (never FAIL): these are data
 * quality findings a curator works through, not something that blocks the build,
 * and the trust gate already prevents the defective values from being served.
 *
 * The detail line carries per-detector tallies using the stable slugs, which is
 * the parseable contract — same convention as {@link publicationCheck}.
 */
export function corpusDefectCheck(
  entries: readonly CorpusEntryT[],
  ctx: CorpusDefectContext,
): Check {
  const findings = summarizeCorpusDefects(entries, ctx);
  if (findings.length === 0) {
    return {
      name: "Corpus defect scan",
      status: "PASS",
      detail: `${entries.length} entries, no defects detected`,
    };
  }
  const tally = new Map<CorpusDefectDetector, number>();
  for (const f of findings) tally.set(f.detector, (tally.get(f.detector) ?? 0) + 1);
  const affected = new Set(findings.map((f) => f.id)).size;
  // Units are explicit per tally. The prefix counts ENTRIES while a detector can
  // emit several rows for one entry (role-collapse emits one per colliding
  // pair), so a bare `slug:168` next to an entry-count prefix read as 168
  // entries. publicationCheck — the convention this follows — tallies entries in
  // every bucket, so a CI script written against it would have mis-read this row.
  const entriesPer = new Map<CorpusDefectDetector, Set<string>>();
  for (const f of findings) {
    const seen = entriesPer.get(f.detector) ?? new Set<string>();
    seen.add(f.id);
    entriesPer.set(f.detector, seen);
  }
  const parts = [...tally.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([detector, count]) => {
      const n = entriesPer.get(detector)?.size ?? 0;
      return `${detector}:${count} rows/${n} entr${n === 1 ? "y" : "ies"}`;
    });
  return {
    name: "Corpus defect scan",
    status: "WARN",
    detail: `${affected}/${entries.length} entries carry defects · ${parts.join(" · ")}`,
  };
}
