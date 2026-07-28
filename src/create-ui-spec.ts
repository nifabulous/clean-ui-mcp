/**
 * create-ui-spec.ts — the evidence-grounded create-ui-spec producer (Task 3 of
 * the C3 first slice).
 *
 * This producer ties together Task 1's strict contracts
 * (src/create-ui-spec-contracts.ts) and Task 2's deterministic fallback recipe
 * (src/c3/fallback-recipe-v1.json). It performs:
 *
 *  1. Input normalization — parse the request through CreateUiSpecRequestSchema
 *     (exact fields; no `outputFormat`).
 *  2. Evidence resolution — keyword-only retrieval capped at 20 then sliced,
 *     product-diverse selection of at most five; explicit reference-token
 *     resolution through an injected resolver. The core NEVER dispatches to a
 *     network-backed search path.
 *  3. Typed sanitization — allowlist projection from CorpusEntry into
 *     response-scoped SanitizedEvidence (evidence-1, evidence-2, ...). Recipe-
 *     owned summaries; never critique/voice/product-name/url/prose.
 *  4. Deterministic assembly — via the safe aggregator (SanitizedEvidence ONLY;
 *     never raw CorpusEntry). The c3-fallback-v1 recipe is the ONLY provider
 *     path this milestone.
 *  5. Envelope construction — build the validated handoff, render both formats,
 *     compute every hash, derive artifactId from the canonical identity object
 *     (generatedAt excluded), and re-validate via parseDesignArtifactEnvelope.
 *
 * Hard constraints (plan Global Constraints):
 *  - Private corpus ids/paths/urls/product identities NEVER enter public output.
 *  - Corpus observations are cited ONLY by response-scoped evidence-* ids.
 *  - citedReferences/sourceReferences come ONLY from explicit public references.
 *  - The deterministic c3-fallback-v1 recipe always produces the base candidate.
 *  - artifactId hashes the canonical identity object; generatedAt excluded.
 *
 * Errors are typed: INVALID_INPUT (retryable:false) for unparseable input or
 * all-missing explicit references; RETRIEVAL_UNAVAILABLE (retryable:true) for
 * reader/search failures, wrapped with a safe message.
 */
import type { CorpusReader } from "./corpus-reader.js";
import type { CorpusEntryT } from "./schema.js";
import type { SearchResult } from "./corpus.js";
import {
  CreateUiSpecErrorSchema,
  CreateUiSpecRequestSchema,
  CANONICAL_WEB_TARGET_PROFILES,
  type CreateUiSpecCandidate,
  type CreateUiSpecRequest,
  type CreateUiSpecError,
  type DesignArtifactEnvelope,
  type SanitizedEvidence,
  buildArtifactIdentityInput,
  buildSemanticSpecInput,
  parseCreateUiSpecCandidate,
  parseDesignArtifactEnvelope,
  sha256Canonical,
} from "./create-ui-spec-contracts.js";
import { pickDiverse } from "./recommend.js";
import {
  parseDesignHandoff,
  NEUTRAL_WEB_TARGET,
} from "./design-target-contracts.js";
import {
  renderDesignHandoffMarkdown,
  renderDesignHandoffJson,
} from "./design-handoff.js";
import { canonicalJsonStringify, sha256Hex } from "./readiness/contracts.js";
import { UiSpec, type UiSpecT } from "./tool-contracts.js";
import recipe from "./c3/fallback-recipe-v1.json" with { type: "json" };
import {
  buildCorpusObservationSummary,
  buildDesignDirectionSummary,
  buildFixedEmptyArrays,
  RECIPE,
} from "./c3/safe-aggregator.js";

// ===========================================================================
// Public interface
// ===========================================================================

/**
 * The stable, response-scoped id of the recipe/system evidence item the
 * deterministic fallback ALWAYS emits (the c3-fallback-v1 recipe is operator
 * content that grounds the echo-product-context designDirection under
 * editorial authority, and the zero-match structured fallback). Emitted FIRST
 * so the recipe id is stable across responses regardless of how many corpus
 * observations are retrieved. Must match {@link EvidenceIdSchema}
 * (^evidence-[0-9]+$).
 */
export const RECIPE_EVIDENCE_ID = "evidence-1";

/**
 * Build the single recipe/system evidence item (editorial-guidance grounding).
 * The summary is recipe-owned text — NOT corpus prose, NOT a user/public
 * citation. The recipe is operator content, so `kind: "recipe-system"` and
 * `basis: "aggregate"` (a deterministic aggregate of operator-authored
 * assembly rules), and NO `publicReference` is populated.
 */
function buildRecipeSystemEvidence(): SanitizedEvidence {
  return {
    id: RECIPE_EVIDENCE_ID,
    kind: "recipe-system",
    basis: "aggregate",
    summary: "Deterministic c3-fallback-v1 recipe",
    structuredFacts: {},
  };
}

export interface CreateUiSpecDependencies {
  readonly reader: CorpusReader;
  /**
   * Resolve an opaque caller token to an internal corpus entry ID. Raw corpus
   * IDs are not valid public tokens — the producer rejects a token whose
   * resolver returns undefined (no silent substitution).
   */
  readonly resolveReferenceToken: (token: string) => string | undefined;
  readonly now?: () => Date;
}

/**
 * Produce a re-render-verified design artifact envelope from a request + deps.
 *
 * Throws a typed CreateUiSpecError on INVALID_INPUT (unparseable request or
 * all-missing explicit references) or RETRIEVAL_UNAVAILABLE (reader/search
 * failure, wrapped with a safe message).
 */
export async function createUiSpec(
  input: unknown,
  dependencies: CreateUiSpecDependencies,
): Promise<DesignArtifactEnvelope> {
  // ----- 1. Input normalization -----
  const request = parseRequest(input);

  // ----- 2. Evidence resolution -----
  const resolved = await resolveEvidence(request, dependencies).catch((err: unknown) => {
    // Typed retrieval failure is rethrown as-is; everything else wraps to
    // RETRIEVAL_UNAVAILABLE with a safe message.
    if (isCreateUiSpecError(err)) throw err;
    throw retrievalError(err);
  });

  // ----- 3/4/5. Assemble + build envelope -----
  const generatedAt = (dependencies.now?.() ?? new Date()).toISOString();
  let envelope: DesignArtifactEnvelope;
  try {
    envelope = buildEnvelope(request, resolved, generatedAt);
    // Re-validate + re-render + re-hash before returning.
    return parseDesignArtifactEnvelope(envelope);
  } catch (err) {
    if (isCreateUiSpecError(err)) throw err;
    // Assembly or integrity-verification failure. The deterministic producer
    // should never hit this on a valid recipe; surface a bounded INVALID_INPUT
    // rather than leaking the raw parser error (a bare Error) to callers. This
    // is the load-bearing fix for the typed-error contract: every in-pipeline
    // failure reaches the caller as a CreateUiSpecError, never an untyped Error.
    throw invalidInput("assembled artifact failed integrity verification");
  }
}

// ===========================================================================
// 1. Input normalization
// ===========================================================================

function parseRequest(input: unknown): CreateUiSpecRequest {
  const parsed = CreateUiSpecRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw invalidInput("create-ui-spec request failed input validation");
  }
  return parsed.data;
}

// ===========================================================================
// 2. Evidence resolution
// ===========================================================================

interface ResolvedEvidence {
  /** Sanitized evidence rows in response order (evidence-1, evidence-2, ...). */
  readonly sanitized: readonly SanitizedEvidence[];
  /** Public reference tokens that resolved (populate citedReferences). */
  readonly resolvedReferenceTokens: readonly string[];
  /** Tokens whose resolver returned undefined (omitted, bounded). */
  readonly omittedReferenceTokens: readonly string[];
  /** True when automatic keyword retrieval produced results. */
  readonly automaticRetrieved: boolean;
  /**
   * Retrieval state fields derived from the resolution. `fallbackReason` is
   * either "missing-index" (a genuine retrieval failure was masked — not
   * currently emitted by the producer) or "no-results" (the truthful reason for
   * a zero-match structured fallback: automatic retrieval SUCCEEDED but
   * returned zero matches; nothing was missing).
   */
  readonly retrieval: {
    readonly mode: "keyword" | "structured-fallback" | "none";
    readonly modality: "metadata" | "none";
    readonly resultCount: number;
    readonly fallbackUsed: boolean;
    readonly fallbackReason?: "missing-index" | "no-results";
    readonly attemptedCount: number;
    readonly attemptedModes: readonly "keyword"[];
  };
}

async function resolveEvidence(
  request: CreateUiSpecRequest,
  dependencies: CreateUiSpecDependencies,
): Promise<ResolvedEvidence> {
  const hasExplicit = request.referenceIds.length > 0;

  // Explicit reference-token resolution takes precedence (no automatic
  // retrieval when references are supplied — matches the none/none state).
  if (hasExplicit) {
    return resolveExplicitReferences(request, dependencies);
  }

  // Automatic keyword-only retrieval (capped at 20, then product-diverse 5).
  return resolveAutomaticRetrieval(request, dependencies);
}

async function resolveExplicitReferences(
  request: CreateUiSpecRequest,
  dependencies: CreateUiSpecDependencies,
): Promise<ResolvedEvidence> {
  const resolvedTokens: string[] = [];
  const omittedTokens: string[] = [];
  // The recipe/system evidence is ALWAYS emitted first (evidence-1); explicit
  // public references follow at evidence-2, evidence-3, ...
  const sanitized: SanitizedEvidence[] = [buildRecipeSystemEvidence()];

  let nextId = 2;
  for (const token of request.referenceIds) {
    const internalId = dependencies.resolveReferenceToken(token);
    if (internalId === undefined) {
      omittedTokens.push(token);
      continue;
    }
    // Validate the internal id maps to a real entry. The corpus content is NOT
    // projected into the public reference — only the user-supplied token is
    // retained as the public citation.
    const entry = readById(dependencies.reader, internalId);
    if (entry === undefined) {
      omittedTokens.push(token);
      continue;
    }
    const id = `evidence-${nextId++}`;
    sanitized.push({
      id,
      kind: "public-reference",
      basis: "user-supplied",
      summary: `User-supplied public reference.`,
      structuredFacts: {},
      publicReference: token,
    });
    resolvedTokens.push(token);
  }

  if (resolvedTokens.length === 0) {
    // All explicit references missing — INVALID_INPUT (no silent substitution).
    throw invalidInput("all supplied reference tokens could not be resolved");
  }

  return {
    sanitized,
    resolvedReferenceTokens: resolvedTokens,
    omittedReferenceTokens: omittedTokens,
    automaticRetrieved: false,
    retrieval: {
      mode: "none",
      modality: "none",
      // resultCount counts ONLY the explicit references (the recipe evidence is
      // editorial grounding, not a retrieved reference).
      resultCount: resolvedTokens.length,
      fallbackUsed: false,
      attemptedCount: 0,
      attemptedModes: [],
    },
  };
}

function readById(reader: CorpusReader, internalId: string): CorpusEntryT | undefined {
  // Synchronous lookup; any thrown error propagates to createUiSpec's catch,
  // which wraps it as RETRIEVAL_UNAVAILABLE. This wrapper does NOT itself wrap
  // exceptions — it exists as a single call site for explicit-token resolution.
  return reader.getById(internalId);
}

async function resolveAutomaticRetrieval(
  request: CreateUiSpecRequest,
  dependencies: CreateUiSpecDependencies,
): Promise<ResolvedEvidence> {
  const results = await dependencies.reader.searchRanked({
    query: request.productContext,
    platform: request.platform,
    limit: 20,
    searchMode: "keyword-only",
  });
  // Slice to 20 BEFORE pickDiverse (the reader may ignore the limit).
  const sliced = results.slice(0, 20);
  const diverse = pickDiverse(sliced as SearchResult[], 5, 2);

  // The recipe/system evidence is ALWAYS emitted first (evidence-1); retrieved
  // corpus observations follow at evidence-2, evidence-3, ... The recipe
  // grounds the echo-product-context designDirection under editorial authority
  // (the direction echoes the requester's brief, not corpus content). Corpus
  // observations are recorded in provenance + the corpusEvidence lane without a
  // designDirection authority claim in this slice.
  const sanitized: SanitizedEvidence[] = [buildRecipeSystemEvidence()];
  let nextId = 2;
  let corpusCount = 0;
  for (const r of diverse) {
    const id = `evidence-${nextId++}`;
    sanitized.push(sanitizeCorpusObservation(id, r.entry));
    corpusCount++;
  }

  if (corpusCount === 0) {
    // Zero matches — the query SUCCEEDED but returned zero results. The honest
    // structured-fallback state: the deterministic c3-fallback-v1 recipe
    // grounded the produced spec (the only emitted evidence is the recipe/
    // system item), and a sparse-evidence warning fires. Nothing was missing —
    // the index was queried and simply had no hits — so `fallbackReason` is the
    // truthful "no-results", NOT "missing-index". The corpus is NOT cited.
    return {
      sanitized,
      resolvedReferenceTokens: [],
      omittedReferenceTokens: [],
      automaticRetrieved: false,
      retrieval: {
        mode: "structured-fallback",
        modality: "metadata",
        // resultCount counts ONLY retrieved corpus observations (zero here).
        // The recipe evidence is editorial grounding, not a retrieved result.
        resultCount: 0,
        fallbackUsed: true,
        fallbackReason: "no-results",
        attemptedCount: 1,
        attemptedModes: ["keyword"],
      },
    };
  }

  return {
    sanitized,
    resolvedReferenceTokens: [],
    omittedReferenceTokens: [],
    automaticRetrieved: true,
    retrieval: {
      mode: "keyword",
      modality: "metadata",
      // resultCount counts ONLY retrieved corpus observations.
      resultCount: corpusCount,
      fallbackUsed: false,
      // No fallback attempted: attemptedModes is empty (the RetrievalState
      // schema forbids attemptedModes containing the current mode).
      attemptedCount: 0,
      attemptedModes: [],
    },
  };
}

// ===========================================================================
// 3. Typed sanitization (allowlist projection from CorpusEntry)
// ===========================================================================

/**
 * Project a private CorpusEntry into a response-scoped, private-marker-free
 * SanitizedEvidence of kind corpus-observation. Retains ONLY:
 *  - patternType (closed PatternType enum token),
 *  - regionCount (bounded count from entry.layout?.regions?.length),
 *  - columnCount (not derivable from the corpus schema — omitted),
 *  - usesStickyHeader / usesIconography (defaulted truthfully to undefined when
 *    not derivable; never fabricated).
 *
 * The summary is generated from a FIXED recipe template keyed by those tokens —
 * never from critique/voice/product-name/url/screenshot/prose.
 */
function sanitizeCorpusObservation(id: string, entry: CorpusEntryT): SanitizedEvidence {
  const structuredFacts: SanitizedEvidence["structuredFacts"] = {};
  // patternType is a closed enum token — safe to project.
  if (entry.patternType && typeof entry.patternType === "string") {
    structuredFacts.pattern = entry.patternType;
  }
  // regionCount is a bounded count derived from the optional layout wireframe.
  const regionCount = entry.layout?.regions?.length;
  if (typeof regionCount === "number" && Number.isFinite(regionCount)) {
    structuredFacts.regionCount = Math.min(Math.max(Math.trunc(regionCount), 0), 50);
  }
  // usesStickyHeader / usesIconography: the corpus schema does not record these
  // truthfully, so we OMIT them (undefined) rather than fabricate.

  const evidence: SanitizedEvidence = {
    id,
    kind: "corpus-observation",
    basis: "visible",
    summary: "", // set below from the recipe-owned template
    structuredFacts,
  };
  evidence.summary = buildCorpusObservationSummary(evidence);
  return evidence;
}

// ===========================================================================
// 3b. Candidate construction — route the deterministic recipe through the
//     evidence-aware candidate parser (the safety spine) before mapping any
//     decision into UiSpec.
// ===========================================================================

/**
 * The recipe-owned rationale text for a decision field, bounded to the
 * candidate schema's DecisionRationale limit (1_000 chars). Reads ONLY the
 * recipe's assembly-rule note (never corpus prose); falls back to a generic
 * deterministic string when the recipe carries no note.
 */
function recipeRationale(field: string): string {
  const rule = RECIPE.assemblyRules[field];
  const note = rule?.note?.trim();
  const base = note && note.length > 0
    ? note
    : `Deterministic fallback decision for ${field}; no corpus- or model-derived evidence was invented.`;
  return base.length <= 1_000 ? base : base.slice(0, 1_000);
}

/**
 * Build the deterministic fallback candidate (the Task 1 15-variant
 * discriminated-union shape) from the recipe + sanitized evidence + request.
 *
 * The candidate is an INTERMEDIATE representation of the same recipe — every
 * value it carries is derived from the recipe's fixed assembly rules or echoed
 * from requester-supplied input. It is then parsed through
 * `parseCreateUiSpecCandidate(candidate, allowedEvidenceIds)` (the safety spine:
 * enforces evidence membership, rejects duplicate decision ids, rejects private
 * markers) BEFORE any decision is mapped into UiSpec. Routing the deterministic
 * recipe through this parser on trusted input proves the candidate → UiSpec map
 * works before untrusted live provider input exercises it in Phase 2.
 *
 * Decisions emitted:
 *  - `designDirection` (echo-product-context): value = echoed productContext;
 *    cites the response-scoped corpus evidence ids (when present).
 *  - The fixed-empty array fields whose candidate shape maps cleanly to their
 *    UiSpec destination (`layoutRegions`, `responsiveBehavior`,
 *    `componentInventory`, `interactions`, `accessibilityConstraints`,
 *    `techniques`, `antiPatterns`): value = [] (the truthful zero-evidence
 *    state); cite no evidence.
 *  - `frameworkNotes` ONLY when the requester supplied an implementationFramework
 *    (the recipe's omit strategy otherwise): value = the framework note string.
 *
 * Fields the recipe marks unavailable (colorTokens, typographyTokens, motion)
 * or omits (contentVoiceGuidance; frameworkNotes when unsupplied) produce NO
 * candidate decision — the assembler emits the `unavailableDecisions` + null
 * tokens / omissions for them directly. `rejectedDefaults` is also direct: its
 * candidate variant is a single string summary, which cannot carry the recipe's
 * empty-array state.
 */
export function buildFallbackCandidate(
  request: CreateUiSpecRequest,
  sanitizedEvidence: readonly SanitizedEvidence[],
  recipe: { readonly recipeVersion: string },
): CreateUiSpecCandidate {
  void recipe; // recipeVersion is unused; the recipe's rules are read via RECIPE.
  // The designDirection echoes the requester's productContext (the recipe's
  // echo-product-context strategy) — it is NOT corpus-grounded. It cites ONLY
  // the recipe/system evidence id under editorial authority. Corpus
  // observations that were retrieved are recorded in provenance + the
  // corpusEvidence lane but do NOT ground the echo-only direction.
  const recipeEvidence = sanitizedEvidence.find((e) => e.kind === "recipe-system");
  const designDirectionEvidenceIds = recipeEvidence ? [recipeEvidence.id] : [];

  const designDirection = buildDesignDirectionSummary(request, RECIPE);

  // Build the candidate as a plain object; parseCreateUiSpecCandidate validates
  // it through CreateUiSpecCandidateSchema + evidence membership.
  const decisions: CreateUiSpecCandidate["decisions"] = [
    // The designDirection decision echoes the requester's brief under the
    // deterministic fallback recipe — it cites ONLY the recipe/system evidence
    // id (editorial authority), NEVER corpus ids.
    {
      field: "designDirection",
      id: "fallback-designDirection",
      value: designDirection,
      rationale: recipeRationale("designDirection"),
      evidenceIds: designDirectionEvidenceIds,
    },
    // The fixed-empty array fields (truthful zero-evidence state, cite nothing).
    ...buildFixedEmptyArrayDecisions(),
  ];

  // frameworkNotes is emitted ONLY when the requester supplied an
  // implementationFramework (the recipe's omit strategy otherwise).
  if (request.implementationFramework !== undefined) {
    decisions.push({
      field: "frameworkNotes",
      id: "fallback-frameworkNotes",
      value: `Implementation framework: ${request.implementationFramework}`,
      rationale: recipeRationale("frameworkNotes"),
      evidenceIds: [],
    });
  }

  return {
    candidateVersion: "1.0",
    decisions,
  };
}

/**
 * Emit the array-compatible fixed-empty fallback decisions — the fields whose
 * candidate variant is an array and whose recipe strategy is the truthful
 * zero-evidence empty array. Each cites no evidence. Order matches the original
 * inline declaration so the produced candidate (and thus the assembled UiSpec)
 * is byte-identical to the pre-refactor output.
 *
 * The text-valued decisions (`designDirection`, `frameworkNotes`) stay inline in
 * {@link buildFallbackCandidate} because they carry request-derived values; the
 * recipe-owned unavailable fields (`colorTokens`, `typographyTokens`, `motion`,
 * `contentVoiceGuidance`) produce NO candidate decision (the assembler emits the
 * `unavailableDecisions` + null tokens directly).
 */
function buildFixedEmptyArrayDecisions(): CreateUiSpecCandidate["decisions"] {
  return [
    {
      field: "layoutRegions",
      id: "fallback-layoutRegions",
      value: [],
      rationale: recipeRationale("layoutRegions"),
      evidenceIds: [],
    },
    {
      field: "responsiveBehavior",
      id: "fallback-responsiveBehavior",
      value: [],
      rationale: recipeRationale("responsiveBehavior"),
      evidenceIds: [],
    },
    {
      field: "componentInventory",
      id: "fallback-componentInventory",
      value: [],
      rationale: recipeRationale("componentInventory"),
      evidenceIds: [],
    },
    {
      field: "interactions",
      id: "fallback-interactions",
      value: [],
      rationale: recipeRationale("interactions"),
      evidenceIds: [],
    },
    {
      field: "accessibilityConstraints",
      id: "fallback-accessibilityConstraints",
      value: [],
      rationale: recipeRationale("accessibilityConstraints"),
      evidenceIds: [],
    },
    {
      field: "techniques",
      id: "fallback-techniques",
      value: [],
      rationale: recipeRationale("techniques"),
      evidenceIds: [],
    },
    {
      field: "antiPatterns",
      id: "fallback-antiPatterns",
      value: [],
      rationale: recipeRationale("antiPatterns"),
      evidenceIds: [],
    },
  ];
}

// ===========================================================================
// 4. Deterministic assembly (UiSpec 1.0)
// ===========================================================================

/**
 * Assemble the validated UiSpec 1.0 from the recipe + sanitized evidence. The
 * deterministic c3-fallback-v1 recipe is the ONLY provider path this milestone.
 *
 * Pipeline: the recipe is first materialized as a CreateUiSpecCandidate
 * (buildFallbackCandidate), then parsed through parseCreateUiSpecCandidate —
 * the safety spine that enforces evidence membership, rejects duplicate
 * decision ids, and rejects private markers BEFORE any decision touches UiSpec.
 * The parsed candidate's decisions are then mapped into UiSpec fields. Fields
 * the candidate does not cover (envelope fields, unavailable/omit fields) are
 * constructed directly. If the candidate parser throws (an internal-producer
 * bug — the recipe is deterministic), it is wrapped as INVALID_INPUT.
 *
 * Authority/evidence membership:
 *  - corpus-derived decisions reference ONLY response-scoped evidence-* ids.
 *  - explicit public references populate citedReferences/sourceReferences and
 *    the editorial lane.
 *  - colorTokenAuthority/typographyTokenAuthority = "editorial" (null tokens).
 *  - motionGuidance.evidenceUnavailable = true (truthful).
 */
function assembleSpec(
  request: CreateUiSpecRequest,
  resolved: ResolvedEvidence,
  generatedAt: string,
): UiSpecT {
  const evidence = resolved.sanitized;
  const evidenceIds = evidence.map((e) => e.id);
  const corpusEvidenceIds = evidence
    .filter((e) => e.kind === "corpus-observation")
    .map((e) => e.id);
  const publicReferenceIds = evidence
    .filter((e) => e.kind === "public-reference")
    .map((e) => e.id);
  const citedReferences = [...resolved.resolvedReferenceTokens];

  // ----- Candidate pipeline (recipe → candidate → evidence-aware parse) -----
  // The candidate is the deterministic recipe materialized as the Task 1
  // discriminated-union shape; parsing it proves evidence membership + rejects
  // structural problems before anything maps into UiSpec.
  const candidate = buildFallbackCandidate(request, evidence, RECIPE);
  const allowedEvidenceIds = new Set(evidenceIds);
  let parsedCandidate: CreateUiSpecCandidate;
  try {
    parsedCandidate = parseCreateUiSpecCandidate(candidate, allowedEvidenceIds);
  } catch {
    // The recipe is deterministic, so this should never fire. Surface as an
    // internal INVALID_INPUT rather than letting a raw Error escape.
    throw invalidInput("deterministic fallback candidate failed evidence-aware parse");
  }

  // ----- Map the parsed candidate's decisions into UiSpec fields -----
  const specFields = mapCandidateToSpecFields(parsedCandidate);

  // Cited decisions: the designDirection ALWAYS echoes the requester's brief
  // under the deterministic fallback recipe (editorial authority), citing ONLY
  // the recipe/system evidence id. Corpus observations that were retrieved are
  // recorded in provenance + the corpusEvidence lane but do NOT ground the
  // echo-only direction. Explicit public references sit in the editorial lane
  // alongside the recipe id.
  const corpusLane = corpusEvidenceIds;
  const editorialLane = [RECIPE_EVIDENCE_ID, ...publicReferenceIds];
  const citedDecisions = buildCitedDecisions(editorialLane);

  // Unavailable decisions (model-dependent fields) — recipe-owned reasons.
  const unavailableDecisions: UiSpecT["unavailableDecisions"] = RECIPE.unavailableDecisions.map(
    (d) => ({ field: d.field, reason: d.reason }),
  );

  // Acceptance criteria: the recipe's single manual criterion.
  const criteria = RECIPE.acceptanceCriteria;
  const acceptanceCriteria: UiSpecT["acceptanceCriteria"] = criteria.map((c) => ({
    id: c.id,
    subject: c.subject,
    assertion: c.assertion as UiSpecT["acceptanceCriteria"][number]["assertion"],
    expectedOutcome: c.expectedOutcome,
    verifier: "manual",
    priority: c.priority as "must" | "should",
    evidenceIds: [...c.evidenceIds],
    manualSteps: [...(c.manualSteps ?? [])],
  }));

  // ----- Envelope-only fields: context, provenance, authorityLanes, tokens -----
  const spec: Record<string, unknown> = {
    specVersion: "1.0",
    context: {
      productContext: request.productContext,
      ...(request.platform !== undefined ? { platform: request.platform } : {}),
      ...(request.implementationFramework !== undefined
        ? { implementationFramework: request.implementationFramework }
        : {}),
      ...(request.designSystem !== undefined ? { designSystem: request.designSystem } : {}),
      constraints: request.constraints,
    },
    designDirection: specFields.designDirection,
    rejectedDefaults: specFields.rejectedDefaults,
    layoutRegions: specFields.layoutRegions,
    responsiveBehavior: specFields.responsiveBehavior,
    componentInventory: specFields.componentInventory,
    colorTokens: null,
    colorTokenAuthority: "editorial",
    typographyTokens: null,
    typographyTokenAuthority: "editorial",
    interactions: specFields.interactions,
    motionGuidance: { notes: [], evidenceUnavailable: true },
    accessibilityConstraints: specFields.accessibilityConstraints,
    ...(specFields.frameworkNotes !== undefined ? { frameworkNotes: specFields.frameworkNotes } : {}),
    techniques: specFields.techniques,
    antiPatterns: specFields.antiPatterns,
    unavailableDecisions,
    acceptanceCriteria,
    citedReferences,
    citedDecisions,
    authorityLanes: {
      corpusEvidence: corpusLane,
      machineRules: [],
      editorialGuidance: editorialLane,
    },
    provenance: {
      generatedAt,
      toolVersion: RECIPE.recipeVersion,
      sourceReferences: citedReferences,
      evidenceIds,
    },
  };

  // Validate the assembled spec through the existing UiSpec schema before
  // mapping into the envelope.
  const parsed = UiSpec.safeParse(spec);
  if (!parsed.success) {
    // Defense-in-depth: the recipe is deterministic, so this should never fire.
    // Surface as INVALID_INPUT if it does.
    throw invalidInput("assembled spec failed UiSpec validation");
  }
  return parsed.data;
}

/**
 * The set of UiSpec fields whose values are extracted from the parsed
 * candidate's decisions (designDirection + the seven fixed-empty array fields
 * + the optional frameworkNotes). Fields NOT covered here (colorTokens,
 * typographyTokens, motion, contentVoiceGuidance) are constructed directly in
 * {@link assembleSpec} because the recipe marks them unavailable/omitted.
 */
interface CandidateSpecFields {
  readonly designDirection: string;
  readonly rejectedDefaults: readonly never[];
  readonly layoutRegions: readonly unknown[];
  readonly responsiveBehavior: readonly unknown[];
  readonly componentInventory: readonly unknown[];
  readonly interactions: readonly unknown[];
  readonly accessibilityConstraints: readonly unknown[];
  readonly techniques: readonly unknown[];
  readonly antiPatterns: readonly unknown[];
  readonly frameworkNotes: string | undefined;
}

/**
 * Extract the parsed candidate's decision values into the UiSpec fields they
 * map to. `designDirection` maps string→string; the seven array fields map
 * []→[] (the recipe's truthful zero-evidence state). `rejectedDefaults` is NOT
 * a candidate decision (its candidate variant is a single string summary,
 * which cannot carry the recipe's empty-array state) — it is constructed
 * directly from the recipe's fixed-empty rule.
 */
function mapCandidateToSpecFields(
  parsedCandidate: CreateUiSpecCandidate,
): CandidateSpecFields {
  const decisionsByField = new Map(parsedCandidate.decisions.map((d) => [d.field, d]));
  // rejectedDefaults comes from the recipe's fixed-empty rule (NOT a candidate
  // decision — see the interface doc).
  const arrays = buildFixedEmptyArrays(RECIPE);
  return {
    designDirection: decisionsByField.get("designDirection")?.value as string,
    rejectedDefaults: arrays.rejectedDefaults,
    layoutRegions: (decisionsByField.get("layoutRegions")?.value ?? []) as unknown[],
    responsiveBehavior: (decisionsByField.get("responsiveBehavior")?.value ?? []) as unknown[],
    componentInventory: (decisionsByField.get("componentInventory")?.value ?? []) as unknown[],
    interactions: (decisionsByField.get("interactions")?.value ?? []) as unknown[],
    accessibilityConstraints: (decisionsByField.get("accessibilityConstraints")?.value ?? []) as unknown[],
    techniques: (decisionsByField.get("techniques")?.value ?? []) as unknown[],
    antiPatterns: (decisionsByField.get("antiPatterns")?.value ?? []) as unknown[],
    frameworkNotes: decisionsByField.get("frameworkNotes")?.value as string | undefined,
  };
}

/**
 * Build the citedDecisions block. The designDirection ALWAYS echoes the
 * requester's productContext under the deterministic c3-fallback-v1 recipe —
 * it is editorial authority, citing ONLY the recipe/system evidence id. The
 * fallback recipe cites NO corpus-evidence authority for the direction (the
 * direction is not corpus-grounded), and invents no authority. Retrieved corpus
 * observations are recorded in provenance + the corpusEvidence lane by the
 * assembler without a designDirection authority claim.
 *
 * `editorialLane` is passed only to satisfy the UiSpec superRefine
 * (editorial-authority decisions must cite an evidence id present in the
 * editorialGuidance lane); the recipe id is always the first entry there.
 */
function buildCitedDecisions(
  editorialLane: readonly string[],
): UiSpecT["citedDecisions"] {
  // The recipe/system evidence id must be in the editorial lane so the
  // editorial-authority citedDecision references a lane member.
  if (!editorialLane.includes(RECIPE_EVIDENCE_ID)) {
    return [];
  }
  return [
    {
      id: "design-direction-editorial",
      field: "designDirection",
      authority: "editorial",
      evidenceIds: [RECIPE_EVIDENCE_ID],
      readiness: "available",
    },
  ];
}

// ===========================================================================
// 5. Envelope construction
// ===========================================================================

/**
 * Build the full DesignArtifactEnvelope (un-verified). The caller re-validates
 * via parseDesignArtifactEnvelope, which re-renders + re-hashes everything.
 */
function buildEnvelope(
  request: CreateUiSpecRequest,
  resolved: ResolvedEvidence,
  generatedAt: string,
): DesignArtifactEnvelope {
  const spec = assembleSpec(request, resolved, generatedAt);

  // Target resolution: pass undefined for neutral-web/absent so the handoff
  // parser substitutes the canonical NEUTRAL_WEB_TARGET. For astro targets,
  // resolve the canonical profile from the shared CANONICAL_WEB_TARGET_PROFILES
  // registry (the same registry parseDesignArtifactEnvelope consults).
  const targetId = request.target ?? "neutral-web";
  const handoffTarget = resolveHandoffTarget(targetId);

  const handoff = parseDesignHandoff({
    spec,
    ...(handoffTarget !== undefined ? { target: handoffTarget } : {}),
    motionIntents: request.motionIntents,
    generatedAt,
  });
  const designMarkdown = renderDesignHandoffMarkdown(handoff);
  const designJson = renderDesignHandoffJson(handoff);

  // Hashes.
  const specSha = sha256Hex(Buffer.from(canonicalJsonStringify(spec), "utf-8"));
  const semanticSpec = buildSemanticSpecInput(spec);
  const semanticSha = sha256Canonical(semanticSpec);
  const markdownSha = sha256Hex(Buffer.from(designMarkdown, "utf-8"));
  const jsonSha = sha256Hex(Buffer.from(designJson, "utf-8"));

  // The recipe's assembly-rules SHA, hoisted once and reused for both the
  // artifactId identity object and the stored assemblyRulesSha256 field.
  const assemblyRulesSha = recipeSha256();

  // Identity — artifactId hashes the canonical identity object (generatedAt
  // excluded). The handoff target id + motionIntents are part of the identity.
  const identity = buildArtifactIdentityInput({
    producerVersion: RECIPE.recipeVersion,
    assemblyRulesSha256: assemblyRulesSha,
    semanticSpecSha256: semanticSha,
    target: targetId,
    motionIntents: request.motionIntents,
  });
  const artifactId = `uispec-${sha256Canonical(identity)}`;

  // Warnings.
  const warnings = buildWarnings(resolved);

  // publicEvidenceIds: every emitted evidence id, in response order. The
  // resolved evidence always carries at least one row — the recipe/system
  // evidence (evidence-1) is ALWAYS emitted first so publicEvidenceIds.min(1)
  // is satisfied honestly, with retrieved corpus observations / explicit
  // references following. provenance.evidenceIds tracks these same ids.
  const publicEvidenceIds = resolved.sanitized.map((e) => e.id);

  // The `as DesignArtifactEnvelope` assertion narrows ResolvedEvidence's
  // readonly retrieval shape (readonly arrays) onto the mutable RetrievalState
  // output type. It is IMMEDIATELY verified by the caller's
  // parseDesignArtifactEnvelope, which re-validates the whole envelope through
  // DesignArtifactEnvelopeSchema (no redundant safeParse added here).
  const envelope: DesignArtifactEnvelope = {
    artifactVersion: "1.0",
    artifactId,
    generatedAt,
    producerVersion: RECIPE.recipeVersion,
    assemblyRulesSha256: assemblyRulesSha,
    spec,
    handoff: { target: targetId, motionIntents: request.motionIntents },
    designMarkdown,
    designJson,
    specSha256: specSha,
    designMarkdownSha256: markdownSha,
    designJsonSha256: jsonSha,
    semanticSpecSha256: semanticSha,
    publicEvidenceIds,
    retrieval: resolved.retrieval,
    warnings,
  } as DesignArtifactEnvelope;
  return envelope;
}

/**
 * Resolve the handoff target profile for the request's target id. Returns
 * `undefined` for neutral-web (so the handoff parser substitutes the canonical
 * NEUTRAL_WEB_TARGET — matching how the envelope parser reconstructs the
 * profile from the id). For astro targets, returns the canonical profile from
 * the SHARED CANONICAL_WEB_TARGET_PROFILES registry (the same registry
 * parseDesignArtifactEnvelope consults), guaranteeing the re-render/re-hash
 * verification byte-reproduces this render.
 */
function resolveHandoffTarget(
  targetId: string,
): Record<string, unknown> | undefined {
  if (targetId === "neutral-web") return undefined;
  const profile = CANONICAL_WEB_TARGET_PROFILES[targetId as keyof typeof CANONICAL_WEB_TARGET_PROFILES];
  return profile !== undefined ? { ...profile } : undefined;
}

/**
 * Build the bounded warnings array. sparseCoverage fires when automatic
 * retrieval produced zero results (structured-fallback). motionEvidenceUnavailable
 * always fires (the recipe marks motion model-dependent + unavailable).
 */
function buildWarnings(resolved: ResolvedEvidence): DesignArtifactEnvelope["warnings"] {
  const warnings: DesignArtifactEnvelope["warnings"] = [];
  if (resolved.retrieval.mode === "structured-fallback") {
    warnings.push({
      code: "sparseCoverage",
      message: "Sparse evidence: automatic retrieval returned zero matches; the deterministic fallback recipe was used.",
    });
  }
  // Motion is always model-dependent + unavailable in this milestone.
  warnings.push({
    code: "motionEvidenceUnavailable",
    message: "Motion guidance is model-dependent; no motion direction was invented and evidence is marked unavailable.",
  });
  return warnings;
}

// ===========================================================================
// Helpers: errors + recipe SHA
// ===========================================================================

/** Frozen canonical-JSON SHA-256 of the checked-in recipe. */
function recipeSha256(): string {
  return sha256Hex(Buffer.from(canonicalJsonStringify(recipe), "utf-8"));
}

/** Construct an INVALID_INPUT error (retryable:false) with a safe message. */
function invalidInput(message: string): CreateUiSpecError {
  const err = { code: "INVALID_INPUT" as const, message, retryable: false as const };
  return assertError(err);
}

/**
 * Wrap an unknown retrieval/search failure as RETRIEVAL_UNAVAILABLE
 * (retryable:true) with a safe message. Raw exception text (paths, urls, corpus
 * ids, stack traces) is NEVER included.
 */
function retrievalError(_err: unknown): CreateUiSpecError {
  return assertError({
    code: "RETRIEVAL_UNAVAILABLE",
    message: "Retrieval is temporarily unavailable; the underlying reader or search failed.",
    retryable: true,
  });
}

/** Assert the error parses through CreateUiSpecErrorSchema (bounded + safe). */
function assertError(err: {
  code: "INVALID_INPUT" | "RETRIEVAL_UNAVAILABLE";
  message: string;
  retryable: boolean;
}): CreateUiSpecError {
  const parsed = CreateUiSpecErrorSchema.safeParse(err);
  if (!parsed.success) {
    // The safe message itself failed the SafeErrorMessage refine (defensive).
    return {
      code: err.code,
      message: err.code === "INVALID_INPUT"
        ? "create-ui-spec request failed input validation"
        : "Retrieval is temporarily unavailable.",
      retryable: err.retryable,
    } as CreateUiSpecError;
  }
  return parsed.data;
}

/** Type guard for a thrown CreateUiSpecError. */
function isCreateUiSpecError(err: unknown): err is CreateUiSpecError {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err.code === "INVALID_INPUT" || err.code === "RETRIEVAL_UNAVAILABLE")
  );
}
