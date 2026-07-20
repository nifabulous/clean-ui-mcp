/**
 * C2 native deterministic scorer.
 *
 * `scoreC2Candidate` is pure: it consumes a candidate artifact, a case brief,
 * a decision label, and a condition input, and produces a `C2DeterministicScore`
 * bound to the run + scorer provenance. The scorer refuses to score a candidate
 * that fails the strict `C2CandidateArtifactSchema` parse — the schema's
 * non-empty accessibility and failureAndRecovery requirements are part of the
 * deterministic gate even though the scorer does not semantically judge prose.
 *
 * Closure rules (spec §9 + plan OV2):
 *   - Every required top-level section is structurally non-empty.
 *   - Every brief-required screen, state, and mobile rule is present.
 *   - Every required decision ID is present.
 *   - Every required acceptance criterion is present.
 *   - Every cited evidence ID exists in the condition input's evidence set.
 *   - Every evidence-bearing decision uses a label-permitted lane with a
 *     non-empty rationale.
 *   - No forbidden claim or private marker appears in the serialized candidate.
 *   - Candidate provenance matches the condition input's `inputSha256`.
 *
 * Brief-only candidates may make brief-grounded decisions without corpus
 * citations (their evidence array is empty, so citing nothing is valid).
 * Grounded candidates may cite only evidence supplied in their condition input.
 */
import { canonicalJsonStringify } from "../readiness/contracts.js";
import {
  C2CandidateArtifactSchema,
  type C2CandidateArtifact,
  C2DeterministicScoreSchema,
  type C2DeterministicScore,
} from "./candidate-contracts.js";
import type { C2CaseBrief, C2DecisionLabel } from "./case-contracts.js";
import type { C2ConditionInput } from "./condition-contracts.js";

/** Inputs to a single scoring call. The returned score is bound to all four. */
export interface ScoreC2CandidateInput {
  /** Stable id of the candidate artifact being scored. */
  artifactId: string;
  /** Run that produced the candidate. */
  runId: string;
  /** SHA-256 of the model's raw run output (for replay binding). */
  runOutputSha256: string;
  /** SHA-256 of this scorer implementation (for replay binding). */
  scorerSha256: string;
  /** Unknown candidate JSON; parsed through the strict schema before scoring. */
  candidate: unknown;
  /** The case brief that declares the required screens/states/mobile rules. */
  brief: C2CaseBrief;
  /** The decision label that declares required decisions/criteria/forbiddens. */
  label: C2DecisionLabel;
  /** The condition input whose evidence universe and hash gate citations. */
  conditionInput: C2ConditionInput;
}

// ---------------------------------------------------------------------------
// Local helpers — implementation details of the scorer (not exported).
// ---------------------------------------------------------------------------

/**
 * Whether a required top-level section is present and structurally non-empty on
 * the parsed candidate. The candidate has already been through the strict
 * schema, so every present key is well-formed; this helper enforces that the
 * key exists AND is non-empty in the structural sense appropriate to its shape
 * (object with keys, non-empty array, non-empty string). Exact key membership —
 * no fuzzy matching.
 */
function sectionPresent(candidate: C2CandidateArtifact, section: string): boolean {
  switch (section) {
    case "globalDirection":
      return (
        candidate.globalDirection !== null &&
        typeof candidate.globalDirection === "object" &&
        Object.keys(candidate.globalDirection).length > 0
      );
    case "screenBlueprints":
      return Array.isArray(candidate.screenBlueprints) && candidate.screenBlueprints.length > 0;
    case "sourceDecisions":
      return Array.isArray(candidate.sourceDecisions) && candidate.sourceDecisions.length > 0;
    case "authorityLanes":
      return (
        candidate.authorityLanes !== null &&
        typeof candidate.authorityLanes === "object" &&
        Object.keys(candidate.authorityLanes).length > 0
      );
    case "acceptanceCriteria":
      return (
        Array.isArray(candidate.acceptanceCriteria) && candidate.acceptanceCriteria.length > 0
      );
    case "assumptions":
      return Array.isArray(candidate.assumptions) && candidate.assumptions.length > 0;
    case "accessibilityAndRecovery":
      return (
        Array.isArray(candidate.accessibilityAndRecovery) &&
        candidate.accessibilityAndRecovery.length > 0
      );
    case "provenance":
      return (
        candidate.provenance !== null &&
        typeof candidate.provenance === "object" &&
        Object.keys(candidate.provenance).length > 0
      );
    default:
      // Unknown required section name — there is no candidate key for it, so it
      // cannot be present. (Fail closed rather than silently awarding coverage.)
      return false;
  }
}

/**
 * Produce one descriptive string per brief-required screen requirement that the
 * candidate's blueprints fail to satisfy. Each returned string is a stable,
 * human-readable identifier of the exact gap:
 *   - "screen:<id>"              — required screen entirely missing
 *   - "screen:<id>:state:<name>" — required state absent from the blueprint
 *   - "screen:<id>:mobile:<name>"— required mobile rule absent from the blueprint
 *
 * Exact-set membership on the blueprint's declared states/mobile rules. Returns
 * an empty array when every required screen, state, and mobile rule is present.
 */
function findMissingScreenRequirements(
  blueprints: ReadonlyArray<C2CandidateArtifact["screenBlueprints"][number]>,
  requirements: C2CaseBrief["requiredScreens"],
): string[] {
  const byId = new Map<string, C2CandidateArtifact["screenBlueprints"][number]>();
  for (const bp of blueprints) byId.set(bp.id, bp);

  const missing: string[] = [];
  for (const req of requirements) {
    const bp = byId.get(req.id);
    if (!bp) {
      missing.push(`screen:${req.id}`);
      continue;
    }
    const declaredStates = new Set(bp.requiredStates);
    for (const state of req.states) {
      if (!declaredStates.has(state)) missing.push(`screen:${req.id}:state:${state}`);
    }
    const declaredMobile = new Set(bp.mobileRules);
    for (const rule of req.mobileRules) {
      if (!declaredMobile.has(rule)) missing.push(`screen:${req.id}:mobile:${rule}`);
    }
  }
  return missing;
}

/**
 * Count source decisions that are unsupported by their lane/rationale: a
 * decision whose `lane` is not in the label's permitted set OR whose
 * `rationale` is empty. Each offending decision contributes exactly one to the
 * count. Exact-set membership against the label's permitted lanes.
 */
function countUnsupportedClaims(
  decisions: ReadonlyArray<C2CandidateArtifact["sourceDecisions"][number]>,
  permittedLanes: Readonly<C2DecisionLabel["permittedAuthorityLanes"]>,
): number {
  const permitted = new Set(permittedLanes);
  let unsupported = 0;
  for (const decision of decisions) {
    const laneOk = permitted.has(decision.lane);
    const rationaleOk =
      typeof decision.rationale === "string" && decision.rationale.trim().length > 0;
    if (!laneOk || !rationaleOk) unsupported += 1;
  }
  return unsupported;
}

/**
 * Count how many configured markers (forbidden claims + private markers) appear
 * anywhere in the candidate's canonical JSON serialization. Each marker is
 * counted at most once — a marker that appears several times still bumps the
 * count by exactly one (the disclosure happened, not "N disclosures").
 *
 * Serialization uses `canonicalJsonStringify` so the result is stable regardless
 * of object key order, and nested prose (rationale, summaries, principles) is
 * covered uniformly.
 */
function countForbiddenText(
  candidate: C2CandidateArtifact,
  markers: readonly string[],
): number {
  const serialized = canonicalJsonStringify(candidate);
  let count = 0;
  for (const marker of markers) {
    if (serialized.includes(marker)) count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Scorer
// ---------------------------------------------------------------------------

/**
 * Score a C2 candidate deterministically. Throws if the candidate fails strict
 * parsing (the schema is part of the gate). The returned score is fully bound
 * to the supplied run + scorer provenance.
 */
export function scoreC2Candidate(input: ScoreC2CandidateInput): C2DeterministicScore {
  const {
    artifactId,
    runId,
    runOutputSha256,
    scorerSha256,
    candidate: rawCandidate,
    brief,
    label,
    conditionInput,
  } = input;

  // Parse through the strict schema before scoring. A parse failure refuses to
  // score — the schema's non-empty accessibility / failureAndRecovery rules are
  // part of the deterministic gate.
  const parseResult = C2CandidateArtifactSchema.safeParse(rawCandidate);
  if (!parseResult.success) {
    throw new Error(
      `scoreC2Candidate: candidate failed strict parse — refusing to score: ${parseResult.error.message}`,
    );
  }
  const candidate = parseResult.data;

  const suppliedEvidence = new Set(conditionInput.evidence.map((item) => item.id));
  const requiredDecisions = new Set(label.requiredDecisionIds);
  const requiredCriteria = new Set(label.requiredAcceptanceCriteria);

  const requiredSectionCoverage =
    label.requiredSections.filter((name) => sectionPresent(candidate, name)).length /
    label.requiredSections.length;

  const decisionCoverage =
    [...requiredDecisions].filter((id) =>
      candidate.sourceDecisions.some((item) => item.id === id),
    ).length / requiredDecisions.size;

  const criterionCoverage =
    [...requiredCriteria].filter((id) =>
      candidate.acceptanceCriteria.some((item) => item.id === id),
    ).length / requiredCriteria.size;

  const missingScreenRequirements = findMissingScreenRequirements(
    candidate.screenBlueprints,
    brief.requiredScreens,
  );

  const unresolvedEvidenceCount = candidate.sourceDecisions
    .flatMap((item) => item.evidenceIds)
    .filter((id) => !suppliedEvidence.has(id)).length;

  const unsupportedClaimCount = countUnsupportedClaims(
    candidate.sourceDecisions,
    label.permittedAuthorityLanes,
  );

  const forbiddenDisclosureCount = countForbiddenText(candidate, [
    ...label.forbiddenClaims,
    ...label.privateMarkers,
  ]);

  const provenanceMismatch =
    candidate.provenance.conditionInputSha256 !== conditionInput.inputSha256;

  const complete =
    requiredSectionCoverage === 1 &&
    decisionCoverage === 1 &&
    criterionCoverage === 1 &&
    missingScreenRequirements.length === 0 &&
    unsupportedClaimCount === 0 &&
    forbiddenDisclosureCount === 0 &&
    unresolvedEvidenceCount === 0 &&
    !provenanceMismatch;

  return C2DeterministicScoreSchema.parse({
    schemaVersion: "1.0",
    artifactType: "c2-deterministic-score",
    artifactId,
    runId,
    runOutputSha256,
    scorerSha256,
    requiredSectionCoverage,
    requiredDecisionCoverage: decisionCoverage,
    acceptanceCriterionCoverage: criterionCoverage,
    missingScreenRequirements,
    unsupportedClaimCount,
    forbiddenDisclosureCount,
    unresolvedEvidenceCount,
    provenanceMismatch,
    complete,
  });
}
