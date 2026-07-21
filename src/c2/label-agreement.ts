/**
 * C2 label-agreement computation (Task A3, Pass 3 spec-lock §1 + §2).
 *
 * This module is the pure algorithm that compares two independent
 * label submissions (Gold Label Owner + external QA) against the frozen
 * 40-entry selection, producing a `C2LabelAgreementReport` with:
 *   - 8 metrics (4 fixed-floor, 4 baseline-bound),
 *   - 8 structural hard gates,
 *   - disagreementEntryIds,
 *   - a `terminalOutcome` of "Qualified" iff every metric AND every hard gate
 *     passes.
 *
 * Strict rules (FLAG 7.1/7.3):
 *   - Baseline values MUST come from the `C2LabelIntegrityBaselineMetrics`
 *     artifact — they are NEVER derived from either submission. A missing
 *     baseline artifact makes agreement computation impossible → throw.
 *   - The two recall metrics (`components-recall`, `domain-tags-recall`) have
 *     no fixed floor: their entire `requiredFloor` is `baselineValue`.
 *
 * The function is pure: hashing of input bytes (for `ArtifactFileRef`s) is the
 * caller's job. `resolvedHashes` carries those hashes; `artifactPaths` carries
 * the canonical repo-relative paths. Both are supplied by the caller so this
 * module has zero filesystem / I/O dependency and is fully testable.
 */
import {
  C2_HARD_GATE_IDS,
  C2_REPLACEMENT_METRIC_FLOORS,
  C2LabelAgreementReportSchema,
  METRIC_IDS,
  assertSubmissionMatchesSelection,
  type C2IndependentLabelSubmission,
  type C2LabelAgreementReport,
  type C2LabelIntegrityBaselineMetrics,
  type C2LabelIntegritySelection,
} from "./evaluation-contracts.js";
import type { ArtifactFileRef } from "./primitives.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Hashes the caller computed over the canonical bytes of each artifact. */
export interface AgreementResolvedHashes {
  selectionSha256: string;
  goldOwnerSubmissionSha256: string;
  qaSubmissionSha256: string;
  baselineMetricsSha256: string;
  adjudicationSha256: string;
}

/** Repo-relative paths + artifact IDs for each bound artifact. */
export interface AgreementArtifactBindings {
  selectionArtifactPath: string;
  goldOwnerSubmissionPath: string;
  qaSubmissionPath: string;
  baselineMetricsPath: string;
  adjudicationArtifactId: string;
  adjudicationPath: string;
}

// ---------------------------------------------------------------------------
// Metric IDs + helpers
// ---------------------------------------------------------------------------

// `METRIC_IDS` is imported from evaluation-contracts.ts (S13): a single source
// of truth for the 8 metric IDs. We derive the local `MetricId` union type from
// it so the agreement module stays in lockstep with the schema.

type MetricId = (typeof METRIC_IDS)[number];

const BASELINE_BOUND_METRIC_IDS: ReadonlySet<MetricId> = new Set<MetricId>([
  "pattern-type-exact-accuracy",
  "categories-macro-f1",
  "components-recall",
  "domain-tags-recall",
]);

const VALID_CRITIQUE_QUALITIES = new Set(["insufficient", "acceptable", "strong"]);

interface ComputedMetric {
  metricId: MetricId;
  value: number;
}

interface EntryLabel {
  entryId: string;
  patternType: string;
  categories: string[];
  components: string[];
  domainTags: string[];
  visualFields: Record<string, string>;
  groundedClaimIds: string[];
  accessibilityEvidenceIds: string[];
  critiqueQuality: "insufficient" | "acceptable" | "strong";
  protectedFieldExpectation: "unchanged";
}

// ---------------------------------------------------------------------------
// Pre-flight validation (independent-actor + reproducibility)
// ---------------------------------------------------------------------------

function assertIndependentActors(
  gold: C2IndependentLabelSubmission,
  qa: C2IndependentLabelSubmission,
): void {
  if (gold.actorId === qa.actorId) {
    throw new Error(
      `label agreement requires independent actors: gold.actorId === qa.actorId === "${gold.actorId}"`,
    );
  }
  if (gold.reviewerRole === qa.reviewerRole) {
    throw new Error(
      `label agreement requires distinct reviewer roles: both are "${gold.reviewerRole}"`,
    );
  }
  // S9: roles must be in the CANONICAL ORDER — gold == "Gold Label Owner" and
  // qa == "QA". The two recall/precision metrics are computed against a fixed
  // gold-as-predicted / qa-as-reference convention, so a swapped pair would
  // silently flip precision and recall. Reject that here rather than at metric
  // compute time.
  if (gold.reviewerRole !== "Gold Label Owner" || qa.reviewerRole !== "QA") {
    throw new Error(
      `label agreement requires canonical role assignment: gold.reviewerRole must be "Gold Label Owner" (got "${gold.reviewerRole}") and qa.reviewerRole must be "QA" (got "${qa.reviewerRole}")`,
    );
  }
}

function assertSelectionHashConsistency(
  gold: C2IndependentLabelSubmission,
  qa: C2IndependentLabelSubmission,
  baseline: C2LabelIntegrityBaselineMetrics,
  resolvedHashes: AgreementResolvedHashes,
): void {
  if (gold.selectionSha256 !== qa.selectionSha256) {
    throw new Error(
      `label agreement: gold.selectionSha256 (${gold.selectionSha256}) does not match qa.selectionSha256 (${qa.selectionSha256})`,
    );
  }
  if (gold.selectionSha256 !== resolvedHashes.selectionSha256) {
    throw new Error(
      `label agreement: submission selectionSha256 (${gold.selectionSha256}) does not match resolved selection hash (${resolvedHashes.selectionSha256})`,
    );
  }
  // Baseline artifact must bind the SAME selection (FLAG 7.1/7.3): if the
  // baseline was computed against a different selection revision, its floors
  // cannot be used to evaluate this agreement.
  if (baseline.selectionSha256 !== resolvedHashes.selectionSha256) {
    throw new Error(
      `label agreement: baseline.selectionSha256 (${baseline.selectionSha256}) does not match resolved selection hash (${resolvedHashes.selectionSha256})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Metric computation
// ---------------------------------------------------------------------------

/**
 * Compute all 8 metrics from the 40 entry-label pairs. Honest computation —
 * no short-circuiting on identical submissions (an identical pair produces
 * all-1.0 values naturally).
 *
 * Convention: for set-based metrics, gold is treated as the "predicted" set
 * and qa as the "reference" set. precision = |gold ∩ qa| / |gold|;
 * recall = |gold ∩ qa| / |qa|. Both are macro-averaged over the 40 entries
 * (empty-set entries contribute 0 to avoid divide-by-zero — documented).
 */
function computeMetrics(
  gold: ReadonlyArray<EntryLabel>,
  qa: ReadonlyArray<EntryLabel>,
): ComputedMetric[] {
  const n = gold.length;

  // pattern-type-exact-accuracy: fraction where patternType agrees.
  let pteaMatches = 0;
  for (let i = 0; i < n; i++) {
    if (gold[i].patternType === qa[i].patternType) pteaMatches += 1;
  }
  const ptea = n === 0 ? 0 : pteaMatches / n;

  // categories-macro-f1: macro-averaged F1 over the universe of categories.
  const allCategories = new Set<string>();
  for (let i = 0; i < n; i++) {
    for (const c of gold[i].categories) allCategories.add(c);
    for (const c of qa[i].categories) allCategories.add(c);
  }
  let macroF1Sum = 0;
  let macroF1Denominator = 0;
  for (const category of allCategories) {
    let goldCount = 0;
    let qaCount = 0;
    let bothCount = 0;
    for (let i = 0; i < n; i++) {
      const g = gold[i].categories.includes(category);
      const q = qa[i].categories.includes(category);
      if (g) goldCount += 1;
      if (q) qaCount += 1;
      if (g && q) bothCount += 1;
    }
    // Per-category precision/recall over entries.
    const precision = goldCount === 0 ? 0 : bothCount / goldCount;
    const recall = qaCount === 0 ? 0 : bothCount / qaCount;
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    macroF1Sum += f1;
    macroF1Denominator += 1;
  }
  const categoriesMacroF1 = macroF1Denominator === 0 ? 0 : macroF1Sum / macroF1Denominator;

  // components precision/recall + domain-tags precision/recall.
  let componentsPrecisionSum = 0;
  let componentsPrecisionDenominator = 0;
  let componentsRecallSum = 0;
  let componentsRecallDenominator = 0;
  let domainTagsPrecisionSum = 0;
  let domainTagsPrecisionDenominator = 0;
  let domainTagsRecallSum = 0;
  let domainTagsRecallDenominator = 0;

  for (let i = 0; i < n; i++) {
    const gComp = new Set(gold[i].components);
    const qComp = new Set(qa[i].components);
    const compIntersection = [...gComp].filter((c) => qComp.has(c)).length;
    if (gComp.size > 0) {
      componentsPrecisionSum += compIntersection / gComp.size;
      componentsPrecisionDenominator += 1;
    }
    if (qComp.size > 0) {
      componentsRecallSum += compIntersection / qComp.size;
      componentsRecallDenominator += 1;
    }

    const gTags = new Set(gold[i].domainTags);
    const qTags = new Set(qa[i].domainTags);
    const tagIntersection = [...gTags].filter((t) => qTags.has(t)).length;
    if (gTags.size > 0) {
      domainTagsPrecisionSum += tagIntersection / gTags.size;
      domainTagsPrecisionDenominator += 1;
    }
    if (qTags.size > 0) {
      domainTagsRecallSum += tagIntersection / qTags.size;
      domainTagsRecallDenominator += 1;
    }
  }
  const componentsPrecision = componentsPrecisionDenominator === 0 ? 0 : componentsPrecisionSum / componentsPrecisionDenominator;
  const componentsRecall = componentsRecallDenominator === 0 ? 0 : componentsRecallSum / componentsRecallDenominator;
  const domainTagsPrecision = domainTagsPrecisionDenominator === 0 ? 0 : domainTagsPrecisionSum / domainTagsPrecisionDenominator;
  const domainTagsRecall = domainTagsRecallDenominator === 0 ? 0 : domainTagsRecallSum / domainTagsRecallDenominator;

  // structured-critique-schema-validity: both critiqueQuality values are in
  // the allowed enum set. Honest computation — the schema enforces this on
  // parse, so the value will normally be 1.0, but we compute it.
  let critiqueValid = 0;
  for (let i = 0; i < n; i++) {
    if (VALID_CRITIQUE_QUALITIES.has(gold[i].critiqueQuality) && VALID_CRITIQUE_QUALITIES.has(qa[i].critiqueQuality)) {
      critiqueValid += 1;
    }
  }
  const structuredCritiqueSchemaValidity = n === 0 ? 0 : critiqueValid / n;

  // scorable-recommendation-citation-rate: fraction where (critiqueQuality is
  // acceptable or strong) → groundedClaimIds is non-empty. An entry counts as
  // "passing" if critiqueQuality is "insufficient" (no citation needed).
  let citationPass = 0;
  for (let i = 0; i < n; i++) {
    const needsCitation =
      gold[i].critiqueQuality === "acceptable" || gold[i].critiqueQuality === "strong" ||
      qa[i].critiqueQuality === "acceptable" || qa[i].critiqueQuality === "strong";
    if (!needsCitation) {
      citationPass += 1;
    } else {
      const hasCitation = gold[i].groundedClaimIds.length > 0 && qa[i].groundedClaimIds.length > 0;
      if (hasCitation) citationPass += 1;
    }
  }
  const citationRate = n === 0 ? 0 : citationPass / n;

  return [
    { metricId: "pattern-type-exact-accuracy", value: ptea },
    { metricId: "categories-macro-f1", value: categoriesMacroF1 },
    { metricId: "components-precision", value: componentsPrecision },
    { metricId: "components-recall", value: componentsRecall },
    { metricId: "domain-tags-precision", value: domainTagsPrecision },
    { metricId: "domain-tags-recall", value: domainTagsRecall },
    { metricId: "structured-critique-schema-validity", value: structuredCritiqueSchemaValidity },
    { metricId: "scorable-recommendation-citation-rate", value: citationRate },
  ];
}

// ---------------------------------------------------------------------------
// Hard-gate computation (structural integrity, not metric values)
// ---------------------------------------------------------------------------

/**
 * Compute the 8 structural hard gates. Each gate is a simple, honest structural
 * check — never a deep semantic judgement. If a gate's spec is ambiguous, we
 * implement the narrowest reasonable structural interpretation and document it.
 *
 * All 8 gates must pass for `terminalOutcome: "Qualified"`.
 */
function computeHardGates(
  gold: C2IndependentLabelSubmission,
  qa: C2IndependentLabelSubmission,
  selection: C2LabelIntegritySelection,
  resolvedHashes: AgreementResolvedHashes,
): { gateId: (typeof C2_HARD_GATE_IDS)[number]; passed: boolean; evidence: string }[] {
  const allLabels = [...gold.labels, ...qa.labels];

  // Gate 1: schema-valid-candidate-output. Both submissions parsed through
  // C2IndependentLabelSubmissionSchema to reach us. Defense-in-depth: every
  // label carries the required fields (the .strict() parse already enforced
  // this, but we re-assert honestly).
  const schemaValid = allLabels.every(
    (label) =>
      typeof label.entryId === "string" && label.entryId.length > 0 &&
      typeof label.patternType === "string" && label.patternType.length > 0 &&
      Array.isArray(label.categories) && Array.isArray(label.components) &&
      Array.isArray(label.domainTags) && Array.isArray(label.groundedClaimIds) &&
      Array.isArray(label.accessibilityEvidenceIds) &&
      (label.critiqueQuality === "insufficient" || label.critiqueQuality === "acceptable" || label.critiqueQuality === "strong"),
  );

  // Gate 2: protected-fields-unchanged. The schema enforces the literal
  // "unchanged" already; we re-assert honestly.
  const protectedUnchanged = allLabels.every((label) => label.protectedFieldExpectation === "unchanged");

  // Gate 3: valid-evidence-ids. Every groundedClaimId and accessibilityEvidenceId
  // is a non-empty stable-id string.
  const validEvidenceId = (id: unknown): boolean =>
    typeof id === "string" && /^[a-z0-9]+(?:[.:_-][a-z0-9]+)*$/.test(id);
  const validEvidence = allLabels.every(
    (label) =>
      label.groundedClaimIds.every(validEvidenceId) &&
      label.accessibilityEvidenceIds.every(validEvidenceId),
  );

  // Gate 4: no-banned-phrases. Structural check: no label field string contains
  // a forbidden placeholder marker. This is intentionally narrow — full
  // profanity/SEO-spam detection is out of scope for a structural gate. The
  // schema already enforces non-empty strings via StableId / UniqueNonEmptyStrings
  // / NonEmptyText, so we only scan for literal placeholder markers here. We do
  // NOT include "tbd" — it misfires on legitimate substrings like "tbd-app" or
  // "todo-app" (S6). The list targets unambiguous placeholder tokens only.
  // Scanned fields: patternType, categories, components, domainTags, visualFields
  // values, groundedClaimIds, accessibilityEvidenceIds.
  const BANNED = ["__placeholder__", "TODO", "FIXME", "lorem ipsum"];
  const hasBanned = (text: string): boolean => BANNED.some((b) => text.toLowerCase().includes(b.toLowerCase()));
  let noBannedPhrases = true;
  for (const label of allLabels) {
    const fieldStrings = [
      label.patternType,
      ...label.categories,
      ...label.components,
      ...label.domainTags,
      ...Object.values(label.visualFields),
      ...label.groundedClaimIds,
      ...label.accessibilityEvidenceIds,
    ];
    if (fieldStrings.some((s) => hasBanned(s))) {
      noBannedPhrases = false;
      break;
    }
  }

  // Gate 5: no-unsupported-accessibility-absence-or-icon-only-claims. Narrow
  // structural check: if the visualFields mention "accessibility", "contrast",
  // "icon", or "aria", the entry MUST carry at least one accessibilityEvidenceId.
  const A11Y_KEYS = ["accessibility", "contrast", "icon", "aria", "wcag"];
  let noUnsupportedA11y = true;
  for (const label of allLabels) {
    const visualText = Object.keys(label.visualFields).join(" ").toLowerCase() +
      " " + Object.values(label.visualFields).join(" ").toLowerCase();
    const mentionsA11y = A11Y_KEYS.some((k) => visualText.includes(k));
    if (mentionsA11y && label.accessibilityEvidenceIds.length === 0) {
      noUnsupportedA11y = false;
      break;
    }
  }

  // Gate 6: valid-wcag-identifiers. Structural check: any string in visualFields
  // keys or values that LOOKS like a WCAG reference must be well-formed. We
  // detect broadly (any "wcag" + digits) and accept narrowly (exactly 1-3
  // numeric components separated by . _ or -). So "wcag 1.4.3" passes, but
  // "wcag 1.4.3.5" (4 components) is detected by WCAG_PATTERN and rejected by
  // WCAG_WELLFORMED → the gate fails. We treat the absence of WCAG-like
  // identifiers as a pass.
  //
  // P1/S7 fix: the previous two regexes were functionally identical (both
  // matched the same set), so the gate was dead code. WCAG_PATTERN now matches
  // any wcag+digits; WCAG_WELLFORMED is tightened to 1-3 components via a
  // `{0,2}` quantifier plus a negative lookahead that rejects a trailing
  // fourth component.
  // Detect any WCAG-style reference (broad): wcag followed by digits.
  const WCAG_PATTERN = /\bwcag[\s_-]*\d+/i;
  // Well-formed: 1-3 dot/dash/underscore-separated numeric components, NOT
  // followed by another component (the negative lookahead rejects "wcag
  // 1.4.3.5" because after matching 1.4.3 a fourth ".5" is still present).
  const WCAG_WELLFORMED = /\bwcag[\s_-]*\d+(?:[.\s_-]\d+){0,2}(?![.\s_-]*\d)/i;
  let validWcag = true;
  for (const label of allLabels) {
    const candidates = [...Object.keys(label.visualFields), ...Object.values(label.visualFields)];
    for (const candidate of candidates) {
      if (WCAG_PATTERN.test(candidate) && !WCAG_WELLFORMED.test(candidate)) {
        validWcag = false;
        break;
      }
    }
    if (!validWcag) break;
  }

  // Gate 7: publication-metadata-preserved. The set of entry IDs in each
  // submission exactly matches the set in the selection — no additions,
  // drops, or renames.
  const selectionIds = new Set(selection.entries.map((e) => e.entryId));
  const goldIds = new Set(gold.labels.map((l) => l.entryId));
  const qaIds = new Set(qa.labels.map((l) => l.entryId));
  const publicationMetadataPreserved =
    goldIds.size === selectionIds.size && qaIds.size === selectionIds.size &&
    [...goldIds].every((id) => selectionIds.has(id)) &&
    [...qaIds].every((id) => selectionIds.has(id));

  // Gate 8: provider-model-prompt-rule-reference-reproducible. Both submissions
  // reference the SAME selection artifact id + selectionSha256 (reproducibility).
  const reproducible =
    gold.selectionArtifactId === qa.selectionArtifactId &&
    gold.selectionArtifactId === selection.artifactId &&
    gold.selectionSha256 === qa.selectionSha256 &&
    gold.selectionSha256 === resolvedHashes.selectionSha256;

  return [
    { gateId: "schema-valid-candidate-output", passed: schemaValid, evidence: `${allLabels.length} labels parsed through C2IndependentLabelSubmissionSchema` },
    { gateId: "protected-fields-unchanged", passed: protectedUnchanged, evidence: "every label.protectedFieldExpectation === \"unchanged\"" },
    { gateId: "valid-evidence-ids", passed: validEvidence, evidence: "all groundedClaimIds and accessibilityEvidenceIds are non-empty stable-ids strings" },
    { gateId: "no-banned-phrases", passed: noBannedPhrases, evidence: `no label field contains a banned placeholder: ${BANNED.join(", ")}` },
    { gateId: "no-unsupported-accessibility-absence-or-icon-only-claims", passed: noUnsupportedA11y, evidence: "every accessibility/contrast/icon/aria mention in visualFields carries at least one accessibilityEvidenceId" },
    { gateId: "valid-wcag-identifiers", passed: validWcag, evidence: "any WCAG-style identifier in visualFields is well-formed" },
    { gateId: "publication-metadata-preserved", passed: publicationMetadataPreserved, evidence: `submission entry IDs match the ${selectionIds.size} selection entries exactly` },
    { gateId: "provider-model-prompt-rule-reference-reproducible", passed: reproducible, evidence: `both submissions reference selection ${selection.artifactId} at hash ${resolvedHashes.selectionSha256}` },
  ];
}

// ---------------------------------------------------------------------------
// Disagreement recording
// ---------------------------------------------------------------------------

/**
 * An entry is "in disagreement" if ANY metric-relevant field differs between
 * the gold and QA labels. The metric-relevant fields are exactly those that
 * feed into the 8 metrics:
 *   - patternType (pattern-type-exact-accuracy)
 *   - categories (categories-macro-f1)
 *   - components (components-precision / recall)
 *   - domainTags (domain-tags-precision / recall)
 *   - critiqueQuality (structured-critique-schema-validity, scorable-rec-citation)
 *   - groundedClaimIds (scorable-recommendation-citation-rate)
 */
function computeDisagreementEntryIds(
  gold: ReadonlyArray<EntryLabel>,
  qa: ReadonlyArray<EntryLabel>,
): string[] {
  const disagreement: string[] = [];
  for (let i = 0; i < gold.length; i++) {
    const g = gold[i];
    const q = qa[i];
    const fieldsDiffer =
      g.patternType !== q.patternType ||
      !setEquals(g.categories, q.categories) ||
      !setEquals(g.components, q.components) ||
      !setEquals(g.domainTags, q.domainTags) ||
      g.critiqueQuality !== q.critiqueQuality ||
      !setEquals(g.groundedClaimIds, q.groundedClaimIds);
    if (fieldsDiffer) disagreement.push(g.entryId);
  }
  return disagreement;
}

function setEquals(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  if (a.length !== b.length) return false;
  const bs = new Set(b);
  return a.every((x) => bs.has(x));
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Compute the C2 label-agreement report from two independent submissions.
 *
 * Throws on:
 *   - missing baseline metrics (`baselineMetrics === null/undefined`),
 *   - same-actor or same-role submissions,
 *   - submission/selection mismatch (delegated to assertSubmissionMatchesSelection),
 *   - selection-hash mismatch between gold, qa, baseline, and resolved hashes.
 *
 * The caller supplies `resolvedHashes` (pre-computed over the canonical bytes
 * of each artifact) and `artifactBindings` (canonical repo-relative paths +
 * artifact IDs). This keeps the function pure of filesystem I/O.
 */
export function computeLabelAgreement(
  gold: C2IndependentLabelSubmission,
  qa: C2IndependentLabelSubmission,
  selection: C2LabelIntegritySelection,
  baselineMetrics: C2LabelIntegrityBaselineMetrics | null | undefined,
  resolvedHashes: AgreementResolvedHashes,
  artifactBindings: AgreementArtifactBindings = DEFAULT_BINDINGS,
): C2LabelAgreementReport {
  // FLAG 7.1/7.3: missing baseline → cannot compute recall floors.
  if (baselineMetrics === null || baselineMetrics === undefined) {
    throw new Error(
      "label agreement requires baseline metrics — the recall metrics' floors cannot be computed without a frozen baseline artifact",
    );
  }

  // Pre-flight: independent actors + roles.
  assertIndependentActors(gold, qa);

  // Pre-flight: both submissions match the frozen selection.
  assertSubmissionMatchesSelection(selection, gold, resolvedHashes.selectionSha256);
  assertSubmissionMatchesSelection(selection, qa, resolvedHashes.selectionSha256);

  // Pre-flight: selection-hash consistency across gold/qa/baseline/resolved.
  assertSelectionHashConsistency(gold, qa, baselineMetrics, resolvedHashes);

  // Index labels by entryId in selection order so metric math is stable.
  const goldById = new Map(gold.labels.map((l) => [l.entryId, l as EntryLabel]));
  const qaById = new Map(qa.labels.map((l) => [l.entryId, l as EntryLabel]));
  const goldOrdered: EntryLabel[] = [];
  const qaOrdered: EntryLabel[] = [];
  for (const entry of selection.entries) {
    const g = goldById.get(entry.entryId);
    const q = qaById.get(entry.entryId);
    if (!g) throw new Error(`label agreement: gold submission missing entry "${entry.entryId}"`);
    if (!q) throw new Error(`label agreement: qa submission missing entry "${entry.entryId}"`);
    goldOrdered.push(g);
    qaOrdered.push(q);
  }

  // Metrics + hard gates + disagreements.
  const computed = computeMetrics(goldOrdered, qaOrdered);
  const hardGates = computeHardGates(gold, qa, selection, resolvedHashes);
  const disagreementEntryIds = computeDisagreementEntryIds(goldOrdered, qaOrdered);

  // Build the metric results: bind baseline values for baseline-bound metrics,
  // compute requiredFloor = max(fixedFloor ?? 0, baselineValue ?? 0).
  const metrics = computed.map(({ metricId, value }) => {
    const isBaselineBound = BASELINE_BOUND_METRIC_IDS.has(metricId);
    const baselineValue = isBaselineBound
      ? readBaselineValue(baselineMetrics, metricId)
      : null;
    const fixedFloor = C2_REPLACEMENT_METRIC_FLOORS[metricId as keyof typeof C2_REPLACEMENT_METRIC_FLOORS] ?? 0;
    const requiredFloor = Math.max(fixedFloor, baselineValue ?? 0);
    const passed = value >= requiredFloor;
    return { metricId, value, baselineValue, requiredFloor, passed };
  });

  const allMetricsPass = metrics.every((m) => m.passed);
  const allGatesPass = hardGates.every((g) => g.passed);
  const terminalOutcome: "Qualified" | "Replacement not justified" =
    allMetricsPass && allGatesPass ? "Qualified" : "Replacement not justified";

  const report: C2LabelAgreementReport = {
    schemaVersion: "1.0",
    artifactType: "c2-label-agreement-report",
    artifactId: "c2-label-agreement-report-v1",
    selectionRef: ref(selection.artifactId, artifactBindings.selectionArtifactPath, resolvedHashes.selectionSha256),
    goldOwnerSubmissionRef: ref(gold.artifactId, artifactBindings.goldOwnerSubmissionPath, resolvedHashes.goldOwnerSubmissionSha256),
    qaSubmissionRef: ref(qa.artifactId, artifactBindings.qaSubmissionPath, resolvedHashes.qaSubmissionSha256),
    baselineMetricsRef: ref(baselineMetrics.artifactId, artifactBindings.baselineMetricsPath, resolvedHashes.baselineMetricsSha256),
    goldOwnerActorId: gold.actorId,
    qaActorId: qa.actorId,
    submissionsUnsealedAt: laterOf(gold.sealedAt, qa.sealedAt),
    metrics,
    hardGates,
    disagreementEntryIds,
    adjudicationRef: ref(artifactBindings.adjudicationArtifactId, artifactBindings.adjudicationPath, resolvedHashes.adjudicationSha256),
    terminalOutcome,
  };

  // Fail-closed: the report MUST parse through the agreement schema.
  const parsed = C2LabelAgreementReportSchema.safeParse(report);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`label agreement report failed schema validation: ${issues}`);
  }
  return report;
}

function readBaselineValue(
  baseline: C2LabelIntegrityBaselineMetrics,
  metricId: MetricId,
): number {
  // Direct property access — the baseline-metrics schema names each metric id
  // as a top-level field.
  return baseline[metricId as keyof C2LabelIntegrityBaselineMetrics] as unknown as number;
}

function ref(artifactId: string, path: string, sha256: string): ArtifactFileRef {
  return { artifactId, path, sha256 };
}

function laterOf(a: string, b: string): string {
  return Date.parse(b) > Date.parse(a) ? b : a;
}

const DEFAULT_BINDINGS: AgreementArtifactBindings = {
  selectionArtifactPath: "eval/c2/label-integrity/selection.json",
  goldOwnerSubmissionPath: "eval/c2/label-integrity/gold-owner-submission.json",
  qaSubmissionPath: "eval/c2/label-integrity/qa-submission.json",
  baselineMetricsPath: "eval/c2/label-integrity/baseline-metrics.json",
  adjudicationArtifactId: "c2-adjudication-v1",
  adjudicationPath: "eval/c2/label-integrity/adjudication.json",
};
