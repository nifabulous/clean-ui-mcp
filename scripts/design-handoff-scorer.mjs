/**
 * design-handoff-scorer.mjs — deterministic offline scorer for C2 design handoff.
 *
 * Scores a design-handoff artifact against gold labels WITHOUT any provider
 * credentials, network, or model calls. The scorer is fully pure: the same
 * (output, label) pair always yields the same ScoreResult.
 *
 * Measured fields (exact-set coverage + violation counts):
 *   - requiredSectionCoverage     — present required sections / total required
 *   - requiredDecisionCoverage    — present required decisions / total required
 *   - acceptanceCriterionCoverage — present required acceptance criteria / total required
 *   - unsupportedClaimCount       — source decisions/observations missing a valid
 *                                    lane or rationale, unsupported source claims,
 *                                    source observations mis-phrased as target
 *                                    authority, and inaccessible URLs claimed as inspected
 *   - forbiddenDisclosureCount    — distinct forbidden claims + private markers in serialized output
 *   - unresolvedEvidenceCount     — evidence references outside the valid set
 *
 * `complete` is true ONLY when all three coverage values are 1 AND all three
 * violation counts are 0.
 *
 * Exported for testing via `export function scoreDesignHandoff(output, label)`.
 */

/**
 * Permitted authority lanes for source decisions and observations (the global
 * universe). A label's `permittedAuthorityLanes` must be a subset of these.
 */
const VALID_LANES = new Set(["retain", "adapt", "reject"]);
const VALID_COVERAGE_EXPECTATIONS = new Set(["low", "moderate", "well-supported"]);

/**
 * Strict semantic label validator (re-review P1 #1 + #2). Earlier versions only
 * checked that required fields were *arrays* — so a label with every field
 * present-but-empty (requiredSections: [], requiredDecisions: [], etc.) passed
 * validation, every empty requirement set was awarded coverage 1, and
 * `scoreDesignHandoff({}, emptyButPresentLabel)` returned `complete: true`.
 * A damaged or placeholder gold label would silently certify an empty handoff.
 *
 * This validator enforces the label CONTRACT, not just its shape:
 *   - `labelVersion === 1` (literal — the only supported version)
 *   - `id` is a non-empty string
 *   - every required array field is a non-empty array of non-empty unique strings
 *   - `requiredScreenStates` is a non-empty map; each value is a non-empty
 *     string array
 *   - `permittedAuthorityLanes` is non-empty and every entry is in
 *     retain|adapt|reject (and unique)
 *   - `requiredDecisions ⊆ validEvidenceIds` (a required decision with no
 *     backing evidence is unsatisfiable — the label itself would be broken)
 *
 * Fail-closed: anything malformed → `false`, and the caller returns the zeroed
 * ScoreResult rather than scoring.
 */
const REQUIRED_NONEMPTY_STRING_ARRAYS = [
  "requiredSections",
  "requiredDecisions",
  "requiredAcceptanceCriteria",
  "requiredMobileRules",
  "forbiddenClaims",
  "privateMarkers",
  "validEvidenceIds",
  "inaccessibleUrls",
];

/** True iff `arr` is a non-empty array of non-empty unique strings. */
function isNonEmptyUniqueStringArray(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return false;
  const seen = new Set();
  for (const el of arr) {
    if (typeof el !== "string" || el.length === 0) return false;
    if (seen.has(el)) return false;
    seen.add(el);
  }
  return true;
}

function isValidGoldLabel(label) {
  if (!label || typeof label !== "object") return false;
  // Scalar + enum checks.
  if (typeof label.id !== "string" || label.id.length === 0) return false;
  if (label.labelVersion !== 1) return false; // literal — only v1 is supported
  if (!VALID_COVERAGE_EXPECTATIONS.has(label.sourceCoverageExpectation)) return false;
  if (typeof label.motionDomGrounded !== "boolean") return false;
  // Required non-empty string arrays.
  for (const field of REQUIRED_NONEMPTY_STRING_ARRAYS) {
    if (!isNonEmptyUniqueStringArray(label[field])) return false;
  }
  // permittedAuthorityLanes: non-empty, unique, each in retain|adapt|reject.
  if (!isNonEmptyUniqueStringArray(label.permittedAuthorityLanes)) return false;
  for (const lane of label.permittedAuthorityLanes) {
    if (!VALID_LANES.has(lane)) return false;
  }
  // requiredScreenStates: non-empty map of blueprintId → non-empty string array.
  const states = label.requiredScreenStates;
  if (
    states === null ||
    typeof states !== "object" ||
    Array.isArray(states) ||
    Object.keys(states).length === 0
  ) {
    return false;
  }
  for (const key of Object.keys(states)) {
    if (key.length === 0) return false;
    if (!isNonEmptyUniqueStringArray(states[key])) return false;
  }
  // requiredDecisions ⊆ validEvidenceIds (else the label is unsatisfiable).
  const validEvidence = new Set(label.validEvidenceIds);
  for (const decisionId of label.requiredDecisions) {
    if (!validEvidence.has(decisionId)) return false;
  }
  return true;
}

/**
 * @typedef {Object} GoldLabel
 * @property {string} id
 * @property {number} labelVersion
 * @property {string[]} requiredSections - top-level output keys that must be present (and non-empty where structural)
 * @property {string[]} requiredDecisions - source decision ids that must each carry a valid lane + rationale
 * @property {Record<string, string[]>} requiredScreenStates - blueprint id → required state strings
 * @property {string[]} requiredAcceptanceCriteria - required acceptance-criterion ids
 * @property {string[]} requiredMobileRules - required mobile-responsive rule strings (must each appear on a blueprint)
 * @property {string[]} permittedAuthorityLanes - allowed lane values (retain/adapt/reject)
 * @property {string[]} forbiddenClaims - strings that must not appear in serialized output
 * @property {string[]} privateMarkers - private identifiers (product names, entry ids, paths) that must not appear
 * @property {string[]} validEvidenceIds - the permitted source-evidence set
 * @property {string[]} inaccessibleUrls - URLs the label marks as inaccessible
 * @property {("low"|"moderate"|"well-supported")} sourceCoverageExpectation - declared source-coverage expectation
 * @property {boolean} motionDomGrounded - whether motion may be DOM-grounded
 */

/**
 * @typedef {Object} ScoreResult
 * @property {boolean} complete
 * @property {number} requiredSectionCoverage
 * @property {number} requiredDecisionCoverage
 * @property {number} acceptanceCriterionCoverage
 * @property {number} unsupportedClaimCount
 * @property {number} forbiddenDisclosureCount
 * @property {number} unresolvedEvidenceCount
 */

/**
 * Score a design-handoff artifact against a gold label.
 * Pure function — no I/O, no network, no model calls, no credentials.
 *
 * @param {Record<string, unknown>} output - the design-handoff artifact
 * @param {GoldLabel} label - the gold label for this fixture
 * @returns {ScoreResult}
 */
export function scoreDesignHandoff(output, label) {
  const result = {
    complete: false,
    requiredSectionCoverage: 0,
    requiredDecisionCoverage: 0,
    acceptanceCriterionCoverage: 0,
    unsupportedClaimCount: 0,
    forbiddenDisclosureCount: 0,
    unresolvedEvidenceCount: 0,
  };

  if (!output || typeof output !== "object") return result;
  // Fail closed on a malformed gold label. A `{}` or partial label previously
  // defaulted every requirement array to `[]`, each empty requirement set was
  // awarded coverage 1, and the scorer returned `complete: true` for an empty
  // handoff (review P1 #1). Strict validation refuses to score a damaged label.
  if (!isValidGoldLabel(label)) return result;

  // ── Required-section coverage ───────────────────────────────────────────────
  // Each required section must be present AND structurally non-empty. Screen
  // states and mobile rules are folded into this gate: a blueprint missing a
  // required state or mobile rule collapses `screenBlueprints` into "incomplete",
  // dropping the section's contribution (mutations 1 and 2).
  const requiredSections = Array.isArray(label.requiredSections) ? label.requiredSections : [];
  if (requiredSections.length > 0) {
    let present = 0;
    for (const section of requiredSections) {
      if (sectionPresent(output, section, label)) present++;
    }
    result.requiredSectionCoverage = present / requiredSections.length;
  } else {
    result.requiredSectionCoverage = 1;
  }

  // ── Required-decision coverage ──────────────────────────────────────────────
  // Each required decision id must appear in sourceDecisions with a valid lane,
  // a non-empty rationale, AND at least one evidence reference. Missing lane /
  // empty rationale both count as uncovered AND increment unsupportedClaimCount.
  // Codex P1 #1: a decision with `evidence: []` previously counted as covered,
  // so an output could assert a decision with NO backing and still reach
  // `complete: true` — certifying an unsupported handoff. An empty evidence
  // array now means the decision is uncovered (claims authority with nothing
  // behind it) and bumps unsupportedClaimCount.
  const requiredDecisions = Array.isArray(label.requiredDecisions) ? label.requiredDecisions : [];
  const sourceDecisions = Array.isArray(output.sourceDecisions) ? output.sourceDecisions : [];
  const validEvidenceSet = new Set(
    Array.isArray(label.validEvidenceIds) ? label.validEvidenceIds : [],
  );
  // Re-review P1 #2: decision and observation lane validation used the GLOBAL
  // VALID_LANES, ignoring label.permittedAuthorityLanes — so a label permitting
  // only `adapt` accepted a `retain` decision. Derive the label-specific
  // permitted set and use it everywhere a lane is checked. (The validator
  // guarantees permittedAuthorityLanes is a non-empty subset of VALID_LANES,
  // so this falls back to VALID_LANES only for a malformed label that slipped
  // past validation — fail-safe, not fail-open.)
  const permittedLaneSet =
    Array.isArray(label.permittedAuthorityLanes) && label.permittedAuthorityLanes.length > 0
      ? new Set(label.permittedAuthorityLanes)
      : VALID_LANES;
  if (requiredDecisions.length > 0) {
    let covered = 0;
    for (const req of requiredDecisions) {
      const decision = sourceDecisions.find((d) => d && d.id === req);
      if (!decision) continue;
      // Lane must be in the LABEL's permitted set, not the global universe.
      const laneOk = typeof decision.lane === "string" && permittedLaneSet.has(decision.lane);
      const rationaleOk =
        typeof decision.rationale === "string" && decision.rationale.trim().length > 0;
      const evidence = Array.isArray(decision.evidence) ? decision.evidence : [];
      const hasEvidence = evidence.length > 0;
      if (laneOk && rationaleOk && hasEvidence) covered++;
    }
    result.requiredDecisionCoverage = covered / requiredDecisions.length;
  } else {
    result.requiredDecisionCoverage = 1;
  }

  // ── Acceptance-criterion coverage ───────────────────────────────────────────
  const requiredCriteria = Array.isArray(label.requiredAcceptanceCriteria)
    ? label.requiredAcceptanceCriteria
    : [];
  const presentCriteria = Array.isArray(output.acceptanceCriteria)
    ? output.acceptanceCriteria.filter((c) => c && typeof c.id === "string").map((c) => c.id)
    : [];
  const criteriaSet = new Set(presentCriteria);
  if (requiredCriteria.length > 0) {
    let present = 0;
    for (const req of requiredCriteria) {
      if (criteriaSet.has(req)) present++;
    }
    result.acceptanceCriterionCoverage = present / requiredCriteria.length;
  } else {
    result.acceptanceCriterionCoverage = 1;
  }

  // ── Unsupported claims (mutations 4, 7, 8 + lane/rationale violations) ──────
  // All of these increment unsupportedClaimCount:
  //   (a) a source decision with no valid lane, or empty rationale
  //   (b) a source decision whose id is NOT in the permitted source-evidence set
  //       (the "unsupported source claim" — mutation 4)
  //   (c) a source observation with no valid lane (presented as target authority
  //       without a retain/adapt/reject disposition — mutation 7)
  //   (d) an inaccessible URL appearing under any blueprint's inspectedUrls
  //       (mutation 8)
  let unsupported = 0;
  for (const decision of sourceDecisions) {
    if (!decision || typeof decision !== "object") continue;
    // Re-review P1 #2: lane must be in the LABEL's permitted set.
    const laneOk = typeof decision.lane === "string" && permittedLaneSet.has(decision.lane);
    const rationaleOk =
      typeof decision.rationale === "string" && decision.rationale.trim().length > 0;
    if (!laneOk || !rationaleOk) unsupported++;
    if (typeof decision.id === "string" && !validEvidenceSet.has(decision.id)) unsupported++;
  }
  const sourceObservations = Array.isArray(output.sourceObservations)
    ? output.sourceObservations
    : [];
  for (const obs of sourceObservations) {
    if (!obs || typeof obs !== "object") continue;
    const laneOk = typeof obs.lane === "string" && permittedLaneSet.has(obs.lane);
    if (!laneOk) unsupported++;
  }
  // Codex P1 #3: inaccessible-URL matching used raw string equality, so an
  // output could claim the same URL in an equivalent form (explicit :443, a
  // fragment, a trailing slash, percent-cased path) and evade the gate. Match
  // on a canonical form instead: parse via WHATWG URL (normalizes default
  // ports, drops the fragment) and compare the href. Unparseable strings are
  // kept as-is so a malformed inaccessible URL still matches its malformed twin.
  const canonicalUrl = (raw) => {
    if (typeof raw !== "string") return raw;
    try {
      const u = new URL(raw);
      u.hash = "";
      // Normalize a trailing slash on a non-root path so `/archived` and
      // `/archived/` match — they are the same resource for gate purposes.
      if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
        u.pathname = u.pathname.replace(/\/+$/, "");
      }
      return u.href;
    } catch {
      return raw;
    }
  };
  const inaccessibleUrls = new Set(
    (Array.isArray(label.inaccessibleUrls) ? label.inaccessibleUrls : []).map(canonicalUrl),
  );
  const blueprints = Array.isArray(output.screenBlueprints) ? output.screenBlueprints : [];
  for (const bp of blueprints) {
    if (!bp || typeof bp !== "object") continue;
    const urls = Array.isArray(bp.inspectedUrls) ? bp.inspectedUrls : [];
    for (const url of urls) {
      if (typeof url === "string" && inaccessibleUrls.has(canonicalUrl(url))) unsupported++;
    }
  }
  result.unsupportedClaimCount = unsupported;

  // ── Forbidden disclosures (forbiddenClaims + privateMarkers — mutation 5) ───
  // Count DISTINCT markers from either set found anywhere in the serialized
  // output. JSON.stringify covers every field, including nested prose.
  const serialized = JSON.stringify(output);
  const forbiddenClaims = Array.isArray(label.forbiddenClaims) ? label.forbiddenClaims : [];
  const privateMarkers = Array.isArray(label.privateMarkers) ? label.privateMarkers : [];
  let disclosures = 0;
  for (const claim of forbiddenClaims) {
    if (typeof claim === "string" && serialized.includes(claim)) disclosures++;
  }
  for (const marker of privateMarkers) {
    if (typeof marker === "string" && serialized.includes(marker)) disclosures++;
  }
  result.forbiddenDisclosureCount = disclosures;

  // ── Unresolved evidence references (mutation 6) ─────────────────────────────
  // Walk every evidence array on every source decision and count references that
  // are not in the valid set. (We intentionally also surface unsupported ids here
  // so mutation 6 flips complete even when the decision itself is "supported".)
  let unresolved = 0;
  for (const decision of sourceDecisions) {
    if (!decision || typeof decision !== "object") continue;
    const evidence = Array.isArray(decision.evidence) ? decision.evidence : [];
    for (const id of evidence) {
      if (!validEvidenceSet.has(id)) unresolved++;
    }
  }
  result.unresolvedEvidenceCount = unresolved;

  // ── Completeness ────────────────────────────────────────────────────────────
  result.complete =
    result.requiredSectionCoverage === 1 &&
    result.requiredDecisionCoverage === 1 &&
    result.acceptanceCriterionCoverage === 1 &&
    result.unsupportedClaimCount === 0 &&
    result.forbiddenDisclosureCount === 0 &&
    result.unresolvedEvidenceCount === 0;

  return result;
}

/**
 * Whether a required top-level section is present and structurally sound for
 * this label. Screen states + mobile rules are enforced here, so a blueprint
 * missing a required state (mutation 1) or a required mobile rule (mutation 2)
 * collapses the `screenBlueprints` section.
 *
 * @param {Record<string, unknown>} output
 * @param {string} section
 * @param {GoldLabel} label
 * @returns {boolean}
 */
function sectionPresent(output, section, label) {
  const value = output[section];
  switch (section) {
    case "globalDirection":
      return value && typeof value === "object" && Object.keys(value).length > 0;
    case "acceptanceCriteria":
      return Array.isArray(value) && value.length > 0;
    case "assumptions":
      return Array.isArray(value) && value.length > 0;
    case "authorityLanes": {
      if (!value || typeof value !== "object") return false;
      const lanes = value;
      const permitted = Array.isArray(label.permittedAuthorityLanes) ? label.permittedAuthorityLanes : [];
      // Each permitted lane must be a non-empty array of {id, rationale}.
      return permitted.every((lane) => {
        const bucket = Array.isArray(lanes[lane]) ? lanes[lane] : [];
        if (bucket.length === 0) return false;
        return bucket.every(
          (entry) =>
            entry &&
            typeof entry.id === "string" &&
            typeof entry.rationale === "string" &&
            entry.rationale.trim().length > 0,
        );
      });
    }
    case "sourceDecisions":
      return Array.isArray(value) && value.length > 0;
    case "screenBlueprints": {
      const blueprints = Array.isArray(value) ? value : [];
      if (blueprints.length === 0) return false;
      const requiredStates =
        label.requiredScreenStates && typeof label.requiredScreenStates === "object"
          ? label.requiredScreenStates
          : {};
      const requiredMobileRules = Array.isArray(label.requiredMobileRules)
        ? label.requiredMobileRules
        : [];
      // Every required blueprint id must be declared, and each declared blueprint
      // must satisfy its required states. Every required mobile rule must appear
      // on at least one blueprint. If a label requires states for a blueprint id
      // that the output never declares, the section is incomplete (I1).
      const declaredBlueprintIds = new Set(
        blueprints.map((bp) => bp && bp.id).filter((id) => id !== undefined && id !== null),
      );
      for (const requiredId of Object.keys(requiredStates)) {
        if (!declaredBlueprintIds.has(requiredId)) return false; // required screen entirely missing
      }
      for (const bp of blueprints) {
        if (!bp || typeof bp !== "object") continue;
        const states = Array.isArray(bp.requiredStates) ? bp.requiredStates : [];
        const needed = requiredStates[bp.id] || [];
        const hasAllStates = needed.every((s) => states.includes(s));
        if (!hasAllStates) return false;
      }
      if (requiredMobileRules.length > 0) {
        const allMobileRules = blueprints.flatMap((bp) =>
          Array.isArray(bp.mobileRules) ? bp.mobileRules : [],
        );
        const mobileOk = requiredMobileRules.every((rule) => allMobileRules.includes(rule));
        if (!mobileOk) return false;
      }
      return true;
    }
    default:
      return value !== undefined && value !== null;
  }
}
