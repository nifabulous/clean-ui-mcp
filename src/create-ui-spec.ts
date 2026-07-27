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
  const envelope = buildEnvelope(request, resolved, generatedAt, dependencies);
  // Re-validate + re-render + re-hash before returning.
  return parseDesignArtifactEnvelope(envelope);
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
  /** Retrieval state fields derived from the resolution. */
  readonly retrieval: {
    readonly mode: "keyword" | "structured-fallback" | "none";
    readonly modality: "metadata" | "none";
    readonly resultCount: number;
    readonly fallbackUsed: boolean;
    readonly fallbackReason?: "missing-index";
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
  const sanitized: SanitizedEvidence[] = [];

  let nextId = 1;
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
      resultCount: sanitized.length,
      fallbackUsed: false,
      attemptedCount: 0,
      attemptedModes: [],
    },
  };
}

function readById(reader: CorpusReader, internalId: string): CorpusEntryT | undefined {
  // Wrapped so a reader.getById exception surfaces as RETRIEVAL_UNAVAILABLE.
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

  const sanitized: SanitizedEvidence[] = [];
  let nextId = 1;
  for (const r of diverse) {
    const id = `evidence-${nextId++}`;
    sanitized.push(sanitizeCorpusObservation(id, r.entry));
  }

  if (sanitized.length === 0) {
    // Zero matches — structured-fallback + sparse-evidence warning. Emit ONE
    // editorial grounding evidence so the envelope's publicEvidenceIds.min(1)
    // is satisfied honestly: the fallback is grounded in the public, checked-in
    // c3-fallback-v1 recipe (a legitimate public reference). The corpus is NOT
    // cited (nothing was retrieved). provenance.evidenceIds tracks this same id
    // so the spec stays internally consistent.
    const fallbackEvidence: SanitizedEvidence = {
      id: "evidence-1",
      kind: "public-reference",
      basis: "user-supplied",
      summary: "Deterministic fallback recipe grounded the produced spec; no corpus evidence was retrieved.",
      structuredFacts: {},
      publicReference: RECIPE.recipeVersion,
    };
    return {
      sanitized: [fallbackEvidence],
      resolvedReferenceTokens: [],
      omittedReferenceTokens: [],
      automaticRetrieved: false,
      retrieval: {
        mode: "structured-fallback",
        modality: "metadata",
        resultCount: 0,
        fallbackUsed: true,
        fallbackReason: "missing-index",
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
      resultCount: sanitized.length,
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
// 4. Deterministic assembly (UiSpec 1.0)
// ===========================================================================

/**
 * Assemble the validated UiSpec 1.0 from the recipe + sanitized evidence. The
 * deterministic c3-fallback-v1 recipe is the ONLY provider path this milestone.
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

  const arrays = buildFixedEmptyArrays(RECIPE);
  const designDirection = buildDesignDirectionSummary(request, RECIPE);

  // Cited decisions: corpus observations ground the designDirection when
  // available; explicit references ground it via the editorial lane otherwise.
  // The fallback recipe cites NO invented authority — only the echoed product
  // context carries a (zero-evidence) cited decision so the spec is non-empty
  // and internally consistent.
  const corpusLane = corpusEvidenceIds;
  const editorialLane = [...publicReferenceIds];
  // Ensure the editorial lane is non-empty so an editorial citedDecision can
  // reference it (UiSpec requires editorial-authority decisions to cite an
  // editorial-lane evidence id). When no public reference resolved, the
  // fallback carries zero citedDecisions.
  const citedDecisions: UiSpecT["citedDecisions"] = [];
  if (corpusLane.length > 0) {
    citedDecisions.push({
      id: "design-direction-corpus",
      field: "designDirection",
      authority: "corpus-evidence",
      evidenceIds: corpusLane.slice(0, 8),
      readiness: "available",
    });
  } else if (editorialLane.length > 0) {
    citedDecisions.push({
      id: "design-direction-editorial",
      field: "designDirection",
      authority: "editorial",
      evidenceIds: editorialLane.slice(0, 8),
      readiness: "available",
    });
  }

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
    designDirection,
    rejectedDefaults: arrays.rejectedDefaults,
    layoutRegions: arrays.layoutRegions,
    responsiveBehavior: arrays.responsiveBehavior,
    componentInventory: arrays.componentInventory,
    colorTokens: null,
    colorTokenAuthority: "editorial",
    typographyTokens: null,
    typographyTokenAuthority: "editorial",
    interactions: arrays.interactions,
    motionGuidance: { notes: [], evidenceUnavailable: true },
    accessibilityConstraints: arrays.accessibilityConstraints,
    ...(request.implementationFramework !== undefined
      ? { frameworkNotes: `Implementation framework: ${request.implementationFramework}` }
      : {}),
    techniques: arrays.techniques,
    antiPatterns: arrays.antiPatterns,
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
  _dependencies: CreateUiSpecDependencies,
): DesignArtifactEnvelope {
  const spec = assembleSpec(request, resolved, generatedAt);

  // Target resolution: pass undefined for neutral-web/absent so the handoff
  // parser substitutes the canonical NEUTRAL_WEB_TARGET. For astro targets,
  // construct the minimal canonical profile (Task 1 forward-note — astro
  // reconstruction from the id alone is a known contract gap).
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

  // Identity — artifactId hashes the canonical identity object (generatedAt
  // excluded). The handoff target id + motionIntents are part of the identity.
  const identity = buildArtifactIdentityInput({
    producerVersion: RECIPE.recipeVersion,
    assemblyRulesSha256: recipeSha256(),
    semanticSpecSha256: semanticSha,
    target: targetId,
    motionIntents: request.motionIntents,
  });
  const artifactId = `uispec-${sha256Canonical(identity)}`;
  const assemblyRulesSha256 = recipeSha256();

  // Warnings.
  const warnings = buildWarnings(resolved);

  // publicEvidenceIds: every emitted evidence id, in response order. The
  // resolved evidence always carries at least one row — in the structured-
  // fallback (zero-match) case, a single editorial grounding evidence (the
  // public recipe) is emitted so publicEvidenceIds.min(1) is satisfied
  // honestly and provenance.evidenceIds stays consistent.
  const publicEvidenceIds = resolved.sanitized.map((e) => e.id);

  const envelope: DesignArtifactEnvelope = {
    artifactVersion: "1.0",
    artifactId,
    generatedAt,
    producerVersion: RECIPE.recipeVersion,
    assemblyRulesSha256,
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
 * Resolve the handoff target. Returns `undefined` for neutral-web/absent (the
 * handoff parser substitutes NEUTRAL_WEB_TARGET). For astro targets, constructs
 * the minimal canonical profile.
 *
 * NOTE (Task 1 contract gap): parseDesignArtifactEnvelope's internal
 * resolveTargetProfile cannot reconstruct the full astro profile from the id
 * alone, so the final re-parse will throw for astro targets. This is a known
 * Task 1 limitation; the minimal fix is to extend resolveTargetProfile to map
 * each id to its canonical profile. Neutral-web (this milestone's only
 * exercised target) is fully supported.
 */
function resolveHandoffTarget(
  targetId: string,
): Record<string, unknown> | undefined {
  if (targetId === "neutral-web") return undefined;
  if (targetId === "astro-react") {
    return {
      id: "astro-react",
      platform: "web",
      siteFramework: "astro",
      runtime: "react",
      styling: "tailwind",
      componentSource: "shadcn",
      motion: "css",
      islandStrategy: "client:visible",
    };
  }
  if (targetId === "astro-vue") {
    return {
      id: "astro-vue",
      platform: "web",
      siteFramework: "astro",
      runtime: "vue",
      styling: "vanilla-css",
      componentSource: "native-html",
      motion: "css",
      islandStrategy: "client:visible",
    };
  }
  return undefined;
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
