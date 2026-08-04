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

// ── Corpus defect detectors (C3 trust gate, Stage 1) ──────────────────────────
//
// These eight detectors found 733 of 787 real entries defective, which is why
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
  | "neumorphic-no-shadow"
  | "unassessed-quality"
  | "verified-image-missing"
  | "verified-hash-stale";

export interface CorpusDefectFinding {
  /** The corpus entry id the defect was found on. */
  id: string;
  detector: CorpusDefectDetector;
  /** One line a curator can act on. */
  message: string;
}

/**
 * Filesystem access the two verification-integrity detectors need, INJECTED so
 * the detectors stay pure and unit-testable (same pattern as
 * {@link PublicationContext}'s `imageExists`).
 *
 * `imageSha256` returns null when the file cannot be read. It is called ONLY for
 * entries carrying an `image-confirmed` verification record — hashing every
 * image would make the doctor read the entire corpus off disk on every run.
 */
export interface CorpusDefectContext {
  imageExists: (corpusRelPath: string) => boolean;
  imageSha256: (corpusRelPath: string) => string | null;
}

const HEX_IN_PROSE = /#[0-9a-f]{6}\b/gi;
/** Font families whose name declares a monospace face. */
const MONO_FACE = /\b(mono|menlo|consolas|courier|monaco|inconsolata)\b/i;
/** Prose that CLAIMS a monospace treatment. */
const MONO_CLAIM = /\bmono-?spaced?\b|\bmonospace\b|\btabular (?:figures|numerals)\b/i;
/** Rail roles that a portrait/mobile viewport physically cannot show. */
const RAIL_ROLES = new Set(["primary-nav", "detail-rail"]);

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
 * Findings measured on the real 787-entry corpus (2026-08-04), as the comparison
 * baseline for a future run — 752 of 787 entries carry at least one:
 *
 *   unassessed-quality 725 · role-collapse 168 (144 entries) · fabricated-hex 99
 *   (85 entries) · rail-on-portrait 90 · low-contrast 65 · accent-mismatch 27 ·
 *   mono-unrecorded 26 · neumorphic-no-shadow 24
 *
 * Two of these are HIGHER than the numbers in the plan (role-collapse 81,
 * fabricated-hex 65) because these detectors are broader than the ad-hoc queries
 * that produced those figures, not because they over-report:
 *   - role-collapse checks all 9 role pairs and emits one row per COLLIDING PAIR,
 *     so an entry with two collisions contributes two rows. Every pair is a real
 *     defect: `ink == accent` makes emphasis invisible, `surface == ink` puts
 *     card text in the card's own colour.
 *   - fabricated-hex also reads `whatToSteal` and `typePairing.notes`, not just
 *     `critique`, and counts entries with NO recorded colour fields (where every
 *     hex in prose is unbacked by construction).
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
      // Body text below 3:1 on its own canvas is unreadable at any size, so this
      // is well under even the large-text AA floor.
      const ratio = typeof roles.ink === "string" && typeof roles.canvas === "string"
        ? contrastRatio(roles.ink, roles.canvas)
        : null;
      if (ratio !== null && ratio < 3) {
        push("low-contrast", `ink ${roles.ink} on canvas ${roles.canvas} is ${ratio.toFixed(2)}:1 (below 3:1)`);
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
      if (!faces.some((f) => MONO_FACE.test(f))) {
        push("mono-unrecorded", `prose claims a monospace treatment; no recorded face is a mono family`);
      }
    }

    // Neumorphism IS soft shadows. The style tag and the flag contradict.
    const styleTags = Array.isArray(entry.styleTags) ? entry.styleTags : [];
    if (styleTags.includes("soft-neumorphic") && visual.usesShadows === false) {
      push("neumorphic-no-shadow", `styleTag soft-neumorphic with usesShadows: false`);
    }

    // The tagger's untouched defaults. Score 3 + tier "exceptional" + never
    // reviewed means nothing actually assessed this entry's quality; the score
    // is a placeholder being read as a judgment.
    if (entry.qualityScore === 3 && entry.qualityTier === "exceptional"
      && entry.provenance?.taggedBy !== "auto-reviewed") {
      push("unassessed-quality", `qualityScore 3 + tier "exceptional" + not auto-reviewed — never assessed`);
    }

    // ── Verification integrity. The serve-path gate is PURE and cannot see
    // either of these; doctor.ts owns them. Both apply only to entries that
    // actually carry a verification record.
    const verification = entry.provenance?.verification;
    if (verification) {
      const path = typeof image.path === "string" ? image.path : null;
      if (path === null || !ctx.imageExists(path)) {
        push("verified-image-missing", `verified entry's image is missing: ${path ?? "(no path)"}`);
      } else if (verification.method === "image-confirmed" && verification.imageSha256) {
        const actual = ctx.imageSha256(path);
        if (actual !== null && actual !== verification.imageSha256) {
          push(
            "verified-hash-stale",
            `verification records ${verification.imageSha256.slice(0, 12)}… but ${path} now hashes to ${actual.slice(0, 12)}…`,
          );
        }
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
  const parts = [...tally.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([detector, count]) => `${detector}:${count}`);
  return {
    name: "Corpus defect scan",
    status: "WARN",
    detail: `${affected}/${entries.length} entries carry defects · ${parts.join(" · ")}`,
  };
}
