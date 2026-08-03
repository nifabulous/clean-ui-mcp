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
 *  4. Deterministic assembly — via the safe aggregator (SanitizedEvidence for
 *     the structured signals) plus the INTERNAL `ResolvedEvidence.matchedEntries`
 *     channel for the six prose fields (C3 Phase 1); every prose string is
 *     identity-screened before emission, and `matchedEntries` never reaches a
 *     transport projection. The c3-fallback-v1 recipe is the ONLY provider
 *     path this milestone.
 *  5. Envelope construction — build the validated handoff, render both formats,
 *     compute every hash, derive artifactId from the canonical identity object
 *     (generatedAt excluded), and re-validate via parseDesignArtifactEnvelope.
 *
 * Hard constraints (plan Global Constraints):
 *  - Private corpus ids/paths/urls/product identities NEVER enter public output.
 *  - Corpus observations are cited ONLY by response-scoped evidence-* ids.
 *  - citedReferences/sourceReferences contain ONLY deterministic opaque digests
 *    derived from explicit public-reference tokens.
 *  - The deterministic c3-fallback-v1 recipe always produces the base candidate.
 *  - artifactId hashes the canonical identity object; generatedAt excluded.
 *
 * Two entry points, ONE pipeline:
 *  - createUiSpec(input, deps)           → DesignArtifactEnvelope (unchanged)
 *  - createUiSpecForAdapter(input, deps) → { envelope, sanitizedEvidence }
 * The first delegates to the second and drops the evidence rows. Transport
 * adapters (MCP, loopback HTTP) call the second so they never re-run retrieval,
 * sanitization, assembly or rendering, and turn the rows into shared MCP
 * `Evidence` via the single projection in create-ui-spec-contracts.ts. No
 * transport-only presentation field is ever added to the persisted envelope.
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
  type CreateUiSpecAdapterResult,
  type CreateUiSpecCandidate,
  type CreateUiSpecRequest,
  type CreateUiSpecError,
  type DesignArtifactEnvelope,
  type SanitizedEvidence,
  SanitizedEvidenceSchema,
  buildArtifactIdentityInput,
  buildSemanticSpecInput,
  parseCreateUiSpecCandidate,
  parseDesignArtifactEnvelope,
  sha256Canonical,
} from "./create-ui-spec-contracts.js";
import {
  parseDesignHandoff,
  NEUTRAL_WEB_TARGET,
} from "./design-target-contracts.js";
import {
  renderDesignHandoffMarkdown,
  renderDesignHandoffJson,
} from "./design-handoff.js";
import { canonicalJsonStringify, sha256Hex } from "./readiness/contracts.js";
import { UiSpec, type ModelProposal, type UiSpecT } from "./tool-contracts.js";
import {
  createUiSpecModel,
  type CreateUiSpecModelRuntime,
} from "./create-ui-spec-model.js";
import {
  ModelArtifactRecordSchema,
  ModelExecutionSchema,
  type ModelExecution,
} from "./create-ui-spec-model-contracts.js";
import { createUiSpecDeterministic } from "./create-ui-spec-deterministic.js";
import { ModelArtifactRollbackIncompleteError } from "./model-artifact-store.js";
import {
  buildCorpusObservationSummary,
  buildDesignDirectionSummary,
  buildFixedEmptyArrays,
  getCitedDecisionRecipe,
  RECIPE,
  type FallbackRecipe,
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
export const RECIPE_EVIDENCE_ID = RECIPE.recipeEvidence.id;

export type CreateUiSpecModelDependency =
  | { kind: "not-configured" }
  | { kind: "invalid-configuration" }
  | { kind: "configured"; runtime: CreateUiSpecModelRuntime };

/**
 * Build the single recipe/system evidence item (editorial-guidance grounding).
 * The summary is recipe-owned text — NOT corpus prose, NOT a user/public
 * citation. The recipe is operator content, so `kind: "recipe-system"` and
 * `basis: "aggregate"` (a deterministic aggregate of operator-authored
 * assembly rules), and NO `publicReference` is populated.
 */
function buildRecipeSystemEvidence(): SanitizedEvidence {
  const { id, kind, basis, summary, structuredFacts } = RECIPE.recipeEvidence;
  return SanitizedEvidenceSchema.parse({ id, kind, basis, summary, structuredFacts });
}

export interface CreateUiSpecDependencies {
  readonly reader: CorpusReader;
  readonly model?: CreateUiSpecModelDependency;
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
 * The envelope-only public core function. It delegates to
 * {@link createUiSpecForAdapter} and returns ONLY the envelope, so existing
 * callers (and the artifact-identity tests) see exactly the value they saw
 * before the adapter result path existed. There is no second pipeline: this is
 * the same retrieval, sanitization, assembly and rendering, projected down.
 *
 * Throws a typed CreateUiSpecError on INVALID_INPUT (unparseable request or
 * all-missing explicit references) or RETRIEVAL_UNAVAILABLE (reader/search
 * failure, wrapped with a safe message).
 */
export async function createUiSpec(
  input: unknown,
  dependencies: CreateUiSpecDependencies,
): Promise<DesignArtifactEnvelope> {
  const { envelope } = await createUiSpecForAdapter(input, dependencies);
  return envelope;
}

/**
 * The internal result path both transport adapters use — the MCP adapter and the
 * loopback HTTP adapter. It runs the SAME pipeline as {@link createUiSpec} and
 * additionally preserves the response-scoped {@link SanitizedEvidence} rows the
 * pipeline already produced and validated, so an adapter never has to re-run
 * retrieval, sanitization, assembly or rendering to obtain them.
 *
 * It does NOT render a second handoff, assign any additional authority, or add
 * a transport-only field to the envelope. The evidence rows are the core's own
 * sanitized rows; an adapter turns them into shared MCP `Evidence` rows through
 * the single `projectSanitizedEvidenceToMcpEvidence` projection exported by
 * create-ui-spec-contracts.ts.
 *
 * `sanitizedEvidence` is in response order, and its ids are exactly
 * `envelope.publicEvidenceIds` in the same order.
 *
 * Throws the same typed CreateUiSpecError values as {@link createUiSpec}.
 */
export async function createUiSpecForAdapter(
  input: unknown,
  dependencies: CreateUiSpecDependencies,
): Promise<CreateUiSpecAdapterResult> {
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
  // The identity screen's denied-name set is CORPUS-WIDE (design spec §3:
  // "any of the ... distinctive product names in the corpus"), not just the
  // matched entries — a prose row naming a corpus product outside the top
  // matches must still be dropped. The reader's entriesForAggregation is the
  // mode-appropriate full corpus (private mode: all 787; public mode: the
  // eligible snapshot).
  const corpusEntries = dependencies.reader.entriesForAggregation();
  try {
    const envelope = await buildModelAwareEnvelope(
      request,
      resolved,
      corpusEntries,
      generatedAt,
      dependencies.model ?? { kind: "not-configured" },
    );
    return { envelope, sanitizedEvidence: resolved.sanitized };
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

async function buildModelAwareEnvelope(
  request: CreateUiSpecRequest,
  resolved: ResolvedEvidence,
  corpusEntries: readonly CorpusEntryT[],
  generatedAt: string,
  model: CreateUiSpecModelDependency,
): Promise<DesignArtifactEnvelope> {
  // Validate the deterministic scaffold and all authority decisions before an
  // optional provider can run. This is also the exact envelope every model
  // failure returns after adding only bounded execution metadata.
  const deterministicEnvelope = buildValidatedEnvelope(request, resolved, corpusEntries, generatedAt);

  if (model.kind === "not-configured") {
    return deterministicEnvelope;
  }

  if (model.kind === "invalid-configuration") {
    console.error("[create-ui-spec] model lane not usable: invalid-configuration");
    return attachModelExecution(
      deterministicEnvelope,
      ModelExecutionSchema.parse({ state: "invalid-configuration" }),
    );
  }

  const outcome = await createUiSpecModel(
    { request, sanitizedEvidence: resolved.sanitized },
    model.runtime,
  );
  if (outcome.kind === "fallback") {
    return attachModelExecution(deterministicEnvelope, outcome.execution);
  }

  let proposedEnvelope: DesignArtifactEnvelope;
  let record: ReturnType<typeof ModelArtifactRecordSchema.parse>;
  try {
    proposedEnvelope = buildValidatedEnvelope(
      request,
      resolved,
      corpusEntries,
      generatedAt,
      outcome.proposal,
      outcome.execution,
    );
    record = ModelArtifactRecordSchema.parse({
      recordVersion: "1.0",
      artifactId: proposedEnvelope.artifactId,
      specSha256: proposedEnvelope.specSha256,
      semanticSpecSha256: proposedEnvelope.semanticSpecSha256,
      ...outcome.recordInput,
      storedAt: generatedAt,
      retention: "until-explicit-delete",
    });
  } catch {
    return attachModelExecution(
      deterministicEnvelope,
      ModelExecutionSchema.parse({ state: "proposal-rejected" }),
    );
  }

  try {
    await model.runtime.store.save(record);
  } catch (error) {
    if (error instanceof ModelArtifactRollbackIncompleteError) {
      throw invalidInput("Model artifact persistence rollback did not complete.");
    }
    return attachModelExecution(
      deterministicEnvelope,
      ModelExecutionSchema.parse({ state: "persistence-failed" }),
    );
  }

  return proposedEnvelope;
}

/**
 * Attach bounded execution metadata to the already-validated deterministic
 * envelope.
 *
 * NO try/catch, DELIBERATELY. The re-parse can only fail if two fields this
 * function computed itself — from a `ModelExecutionSchema`-validated value, onto
 * an envelope that already passed `parseDesignArtifactEnvelope` — somehow make
 * that same envelope invalid. That is an internal inconsistency, not a model
 * failure, and the honest response is to fail loudly.
 *
 * Catching here would be actively worse than throwing: the only thing a catch
 * could return is the deterministic envelope WITHOUT `modelExecution`, which is
 * the exact shape of "no model was configured". The operator would be told no
 * model was attempted when one was, and would go looking in the wrong place. A
 * lost request is recoverable; a false claim about what ran is the thing this
 * whole surface exists to prevent.
 */
function attachModelExecution(
  deterministicEnvelope: DesignArtifactEnvelope,
  execution: ModelExecution,
): DesignArtifactEnvelope {
  return parseDesignArtifactEnvelope({
    ...deterministicEnvelope,
    modelExecution: execution,
    modelExecutionSha256: sha256Canonical(execution),
  });
}

function buildValidatedEnvelope(
  request: CreateUiSpecRequest,
  resolved: ResolvedEvidence,
  corpusEntries: readonly CorpusEntryT[],
  generatedAt: string,
  proposal?: ModelProposal,
  execution?: ModelExecution,
): DesignArtifactEnvelope {
  return parseDesignArtifactEnvelope(
    buildEnvelope(request, resolved, corpusEntries, generatedAt, proposal, execution),
  );
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
  /**
   * Sanitized evidence rows in response order (evidence-1, evidence-2, ...).
   * EVERY row is parsed through `SanitizedEvidenceSchema` at construction, so
   * this list is what {@link createUiSpecForAdapter} can preserve verbatim for a
   * transport adapter. Two construction sites, deliberately different in how a
   * failure surfaces:
   *  - the corpus-observation and public-reference rows go through
   *    {@link parseSanitizedEvidence}, which converts a schema failure into a
   *    bounded INVALID_INPUT;
   *  - the recipe row goes through `SanitizedEvidenceSchema.parse` directly in
   *    {@link buildRecipeSystemEvidence} (the recipe is frozen JSON, so a failure
   *    means the frozen artifact itself is wrong); its raw ZodError is caught by
   *    `resolveEvidence`'s caller and surfaces as RETRIEVAL_UNAVAILABLE.
   * Both paths guarantee the same property for this list: no row reaches it
   * unvalidated.
   */
  readonly sanitized: readonly SanitizedEvidence[];
  /**
   * INTERNAL ONLY. Matched corpus entries paired with the response-scoped
   * evidence id assigned to each, so the synthesizer can read prose the
   * sanitized rows deliberately exclude (structuredFacts is a closed,
   * prose-free allowlist). These are RAW entries — title, source.productName,
   * image. Nothing may project this field; the transport adapters read
   * `sanitized`, never this. Pinned by the leak test in create-ui-spec.test.ts.
   */
  readonly matchedEntries: readonly { readonly evidenceId: string; readonly entry: CorpusEntryT }[];
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
    // projected into the public reference — only a deterministic opaque digest
    // of the user token is retained as the public citation.
    const entry = readById(dependencies.reader, internalId);
    if (entry === undefined) {
      omittedTokens.push(token);
      continue;
    }
    const id = `evidence-${nextId++}`;
    const publicReference = `ref-${sha256Hex(Buffer.from(token.trim(), "utf-8"))}`;
    sanitized.push(parseSanitizedEvidence({
      id,
      kind: "public-reference",
      basis: "user-supplied",
      summary: `User-supplied public reference.`,
      structuredFacts: {},
      publicReference,
    }));
    resolvedTokens.push(publicReference);
  }

  if (resolvedTokens.length === 0) {
    // All explicit references missing — INVALID_INPUT (no silent substitution).
    throw invalidInput(
      "all supplied reference tokens could not be resolved; omit them to use automatic retrieval",
    );
  }

  return {
    sanitized,
    matchedEntries: [],
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
  // Plan 2: top-3 by rank — no product-diversity pick. A diverse-but-
  // irrelevant slice was the original sin: it traded relevance for coverage
  // and left thin briefs steered by label classes. The corpus long tail is
  // honest about weak matches instead.
  // Pattern-dedupe (eng review D2): keep the FIRST entry per patternType so a
  // repeated pattern class cannot crowd out grounding diversity (measured: a
  // habit brief returned onboarding twice in the top 3). Scan up to 20 ranked
  // rows and fill distinct patterns up to 3, preserving rank order.
  // Keyword search first; when it matches nothing, seed the id-based
  // similarity index (findSimilar) from the plain search's top hit.
  // SearchResult requires `score` and `searchMode` (src/corpus.ts:116-120);
  // the similarity fallback yields { entry } rows, so the declared type is the
  // common { entry } shape and the ranked slice is structurally assignable.
  const distinctPatterns = (rows: readonly { entry: CorpusEntryT }[]): { entry: CorpusEntryT }[] => {
    const picked: { entry: CorpusEntryT }[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (picked.length >= 3) break;
      const pattern = row.entry.patternType;
      // Entries with no patternType are deliberately NOT deduped against each
      // other — there is no class to collide on, and two untyped entries are
      // two distinct references. Only a present pattern is recorded, so the
      // set never holds a sentinel that nothing can match.
      if (pattern !== undefined) {
        if (seen.has(pattern)) continue;
        seen.add(pattern);
      }
      picked.push({ entry: row.entry });
    }
    return picked;
  };
  let top: { entry: CorpusEntryT }[] = distinctPatterns(results.slice(0, 20));
  if (top.length === 0) {
    const seeded = await dependencies.reader.search({
      query: request.productContext,
      platform: request.platform,
      limit: 1,
    });
    const seed = seeded[0];
    if (seed) {
      const similar = dependencies.reader.findSimilar(seed.id, 3);
      // SimilarResult is { entry: CorpusEntryT, score: number } —
      // src/corpus.ts:414-427. The entry is always present.
      top = distinctPatterns(similar.map((s) => ({ entry: s.entry })));
    }
  }

  // The recipe/system evidence is ALWAYS emitted first (evidence-1); retrieved
  // corpus observations follow at evidence-2, evidence-3, ... The recipe
  // grounds the echo-product-context designDirection under editorial authority
  // (the direction echoes the requester's brief, not corpus content). Corpus
  // observations are recorded in provenance + the corpusEvidence lane without a
  // designDirection authority claim in this slice.
  const sanitized: SanitizedEvidence[] = [buildRecipeSystemEvidence()];
  const matchedEntries: { evidenceId: string; entry: CorpusEntryT }[] = [];
  let nextId = 2;
  let corpusCount = 0;
  for (const r of top) {
    const id = `evidence-${nextId++}`;
    sanitized.push(sanitizeCorpusObservation(id, r.entry));
    matchedEntries.push({ evidenceId: id, entry: r.entry });
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
      matchedEntries: [],
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
    matchedEntries,
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
  const visual = entry.visual;
  if (visual?.spacingDensity) structuredFacts.spacingDensity = visual.spacingDensity;
  if (visual?.cornerStyle) structuredFacts.cornerStyle = visual.cornerStyle;
  if (typeof visual?.usesShadows === "boolean") structuredFacts.usesShadows = visual.usesShadows;
  if (typeof visual?.usesBorders === "boolean") structuredFacts.usesBorders = visual.usesBorders;
  if (visual?.accentColor) structuredFacts.accentColor = visual.accentColor;
  if (visual?.colorRoles) structuredFacts.colorRoles = {
    canvas: visual.colorRoles.canvas,
    surface: visual.colorRoles.surface,
    ink: visual.colorRoles.ink,
    muted: visual.colorRoles.muted, // nullable per the corpus schema
    accent: visual.colorRoles.accent,
  };
  const pairing = visual?.typePairing;
  if (pairing?.display && pairing.body) {
    // `+` separator, NOT "/" — the summary content screen rejects path-like
    // strings (PATH_OR_URL_PATTERN), and "Display / Body" trips it.
    structuredFacts.typePairing = `${pairing.display} + ${pairing.body}`;
  }
  const layoutStructure = entry.layout;
  if (layoutStructure?.form) structuredFacts.layoutForm = layoutStructure.form;
  const roles = layoutStructure?.regions?.map((r) => r.role).filter(Boolean);
  if (roles && roles.length > 0) structuredFacts.layoutRoles = roles.slice(0, 8);

  const evidence: SanitizedEvidence = {
    id,
    kind: "corpus-observation",
    basis: "visible",
    summary: "", // set below from the recipe-owned template
    structuredFacts,
  };
  evidence.summary = buildCorpusObservationSummary(evidence);
  // Parse the finished row so EVERY row in ResolvedEvidence.sanitized is
  // schema-validated. The adapter result path preserves this list verbatim, so
  // the "already-schema-validated" guarantee has to hold at construction — not
  // at the adapter boundary, which would put a validation concern in transport.
  return parseSanitizedEvidence(evidence);
}

/**
 * Parse a candidate row through {@link SanitizedEvidenceSchema}, converting a
 * schema failure into a bounded INVALID_INPUT rather than letting a raw ZodError
 * escape.
 *
 * This is NOT merely defensive. `buildCorpusObservationSummary` interpolates
 * `structuredFacts.pattern` verbatim into the summary, and the summary is
 * published at `evidence[].summary` by the adapter path (the persisted envelope
 * carries only `publicEvidenceIds`). A reader that hands back an entry whose
 * `patternType` is outside the closed `PatternType` enum would therefore publish
 * that raw corpus string. StructuredFacts pins `pattern` to the enum, so parsing
 * here refuses the row instead — the leak surface the preserved evidence list
 * newly exposes is closed at construction, not at the transport boundary.
 */
function parseSanitizedEvidence(row: unknown): SanitizedEvidence {
  const parsed = SanitizedEvidenceSchema.safeParse(row);
  if (!parsed.success) {
    throw invalidInput("sanitized evidence row failed SanitizedEvidence validation");
  }
  return parsed.data;
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
function recipeRationale(field: string, recipe: FallbackRecipe = RECIPE): string {
  const rule = recipe.assemblyRules[field];
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
 *    cites the recipe/system evidence declared by the recipe.
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
  recipe: FallbackRecipe,
): CreateUiSpecCandidate {
  // The designDirection echoes the requester's productContext (the recipe's
  // echo-product-context strategy) — it is NOT corpus-grounded. It cites ONLY
  // the recipe/system evidence id under editorial authority. Corpus
  // observations that were retrieved are recorded in provenance + the
  // corpusEvidence lane but do NOT ground the echo-only direction.
  const recipeEvidence = sanitizedEvidence.find((e) => e.kind === "recipe-system");
  const designDirectionEvidenceIds = recipeEvidence ? [recipeEvidence.id] : [];

  const designDirection = buildDesignDirectionSummary(request, recipe);

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
      rationale: recipeRationale("designDirection", recipe),
      evidenceIds: designDirectionEvidenceIds,
    },
    // The fixed-empty array fields (truthful zero-evidence state, cite nothing).
    ...buildFixedEmptyArrayDecisions(recipe),
  ];

  // frameworkNotes is emitted ONLY when the requester supplied an
  // implementationFramework (the recipe's omit strategy otherwise).
  if (request.implementationFramework !== undefined) {
    decisions.push({
      field: "frameworkNotes",
      id: "fallback-frameworkNotes",
      value: `Implementation framework: ${request.implementationFramework}`,
      rationale: recipeRationale("frameworkNotes", recipe),
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
function buildFixedEmptyArrayDecisions(recipe: FallbackRecipe): CreateUiSpecCandidate["decisions"] {
  const arrays = buildFixedEmptyArrays(recipe);
  return [
    {
      field: "layoutRegions",
      id: "fallback-layoutRegions",
      value: [...arrays.layoutRegions],
      rationale: recipeRationale("layoutRegions", recipe),
      evidenceIds: [],
    },
    {
      field: "responsiveBehavior",
      id: "fallback-responsiveBehavior",
      value: [...arrays.responsiveBehavior],
      rationale: recipeRationale("responsiveBehavior", recipe),
      evidenceIds: [],
    },
    {
      field: "componentInventory",
      id: "fallback-componentInventory",
      value: [...arrays.componentInventory],
      rationale: recipeRationale("componentInventory", recipe),
      evidenceIds: [],
    },
    {
      field: "interactions",
      id: "fallback-interactions",
      value: [...arrays.interactions],
      rationale: recipeRationale("interactions", recipe),
      evidenceIds: [],
    },
    {
      field: "accessibilityConstraints",
      id: "fallback-accessibilityConstraints",
      value: [...arrays.accessibilityConstraints],
      rationale: recipeRationale("accessibilityConstraints", recipe),
      evidenceIds: [],
    },
    {
      field: "techniques",
      id: "fallback-techniques",
      value: [...arrays.techniques],
      rationale: recipeRationale("techniques", recipe),
      evidenceIds: [],
    },
    {
      field: "antiPatterns",
      id: "fallback-antiPatterns",
      value: [...arrays.antiPatterns],
      rationale: recipeRationale("antiPatterns", recipe),
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
 *  - deterministic opaque digests of explicit public references populate
 *    citedReferences/sourceReferences and the editorial lane.
 *  - colorTokenAuthority/typographyTokenAuthority = "editorial" (null tokens).
 *  - motionGuidance.evidenceUnavailable = true (truthful).
 */
function assembleSpec(
  request: CreateUiSpecRequest,
  resolved: ResolvedEvidence,
  corpusEntries: readonly CorpusEntryT[],
  generatedAt: string,
  proposal?: ModelProposal,
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

  // Deterministic synthesis (Plan 2): corpus-grounded direction, token
  // plurality, and layout regions — ONLY on the no-model path. When a model
  // proposal is present, NONE of the synthesis applies: the root direction
  // keeps the recipe echo, root tokens stay null (UiSpec superRefine), and
  // the proposal is the only direction content. Gating the whole synthesis
  // object (not just the token fields) is deliberate — a corpus-synthesized
  // root direction on the model path would be a behavior change the spec
  // never approved.
  const synthesis = proposal === undefined
    ? createUiSpecDeterministic(evidence, resolved.matchedEntries, corpusEntries, request)
    : null;

  // Cited decisions: the designDirection ALWAYS echoes the requester's brief
  // under the deterministic fallback recipe (editorial authority), citing ONLY
  // the recipe/system evidence id. Corpus observations that were retrieved are
  // recorded in provenance + the corpusEvidence lane but do NOT ground the
  // echo-only direction. Explicit public references sit in the editorial lane
  // alongside the recipe id.
  const corpusLane = corpusEvidenceIds;
  const editorialLane = [RECIPE_EVIDENCE_ID, ...publicReferenceIds];
  const recipeDecisions = buildCitedDecisions(editorialLane);
  // The synthesized direction text cites the corpus observation ids, so the
  // citation ledger must match: the recipe's editorial designDirection
  // decision is REPLACED (not augmented) by a corpus-authority decision
  // citing those ids, when synthesis supplied the direction.
  const directionDecisions: UiSpecT["citedDecisions"] = synthesis?.designDirection
    ? [
        ...recipeDecisions.filter((d) => d.field !== "designDirection"),
        {
          // NOT "corpus-..." prefixed: the no-secret-in-served-bytes sweep
          // treats any "corpus-" token as private corpus identity.
          id: "designDirection-evidence-synthesis",
          field: "designDirection",
          // "corpus-evidence" is the CitedDecision authority enum token
          // (tool-contracts.ts:537), NOT the camelCase lane field name.
          authority: "corpus-evidence",
          evidenceIds: corpusEvidenceIds,
          readiness: "available",
        },
      ]
    : recipeDecisions;
  // The palette is a plurality vote over the matched entries' visual.colorRoles
  // — corpus-evidence authorship, exactly like the synthesized direction above.
  // Leaving colorTokenAuthority "editorial" with no ledger row would declare an
  // authority the product did not derive (the governing invariant) and would
  // drop the trace from the served palette back to the entries that produced
  // it. The gate's authority-prerequisite check then verifies this decision
  // cites the corpusEvidence lane.
  const citedDecisions: UiSpecT["citedDecisions"] = synthesis?.colorTokens
    ? [
        ...directionDecisions.filter((d) => d.field !== "colorTokens"),
        {
          id: "colorTokens-evidence-synthesis",
          field: "colorTokens",
          authority: "corpus-evidence",
          evidenceIds: corpusEvidenceIds,
          readiness: "available",
        },
      ]
    : directionDecisions;
  // The composed contentVoiceGuidance is corpus-authority content (design spec
  // §5): it rides a citedDecision row with corpus-evidence authority, citing
  // exactly the entries whose voice content survived the screen.
  const citedDecisionsWithVoice = synthesis?.contentVoiceGuidance
    ? [
        ...citedDecisions,
        {
          id: "contentVoiceGuidance-evidence-synthesis",
          field: "contentVoiceGuidance",
          authority: "corpus-evidence" as const,
          evidenceIds: synthesis.contentVoiceEvidenceIds,
          readiness: "available" as const,
        },
      ]
    : citedDecisions;

  // C3 served-content posture: prose-judgment fields WITHOUT surviving corpus
  // content keep their unavailable reasons (the voice row is dropped exactly
  // when synthesis serves contentVoiceGuidance below); rejectedDefaults and
  // mood have no served slot in Phase 1.
  const c3Unavailable: UiSpecT["unavailableDecisions"] = [
    { field: "rejectedDefaults", reason: "Anti-pattern prose is not served; derived from corpus judgments after governance." },
    // Once synthesis serves contentVoiceGuidance, the voice-unavailable row
    // would be false; it is dropped below exactly when voice content survives.
    ...(synthesis?.contentVoiceGuidance ? [] : [{ field: "voice", reason: "Voice analysis prose is not served until provenance governance lands." }]),
    { field: "mood", reason: "Mood is not served until provenance governance lands." },
  ];
  // The recipe ALREADY declares a colorTokens unavailableDecision
  // (fallback-recipe-v1.json); the UiSpec gate requires unavailableDecisions
  // fields to be UNIQUE (tool-contracts.ts:778-781) and forbids a colorTokens
  // row when tokens are available (:803-804). So: when synthesis runs, drop
  // the recipe's colorTokens row and re-add exactly ONE row only when the
  // synthesis leaves tokens null. When synthesis did not run (no corpus match
  // or model path), the recipe's row survives untouched.
  const unavailableDecisions: UiSpecT["unavailableDecisions"] = [
    ...RECIPE.unavailableDecisions
      .filter((d) => synthesis === null || d.field !== "colorTokens")
      .map((d) => ({ field: d.field, reason: d.reason })),
    ...(synthesis !== null && synthesis.colorTokens === null
      ? [{ field: "colorTokens", reason: "Fewer than 3 matched entries contribute color roles." }]
      : []),
    ...c3Unavailable,
  ];

  // Acceptance criteria: the recipe's single manual criterion.
  const criteria = RECIPE.acceptanceCriteria;
  const recipeCriteria: UiSpecT["acceptanceCriteria"] = criteria.map((c) => ({
    id: c.id,
    subject: c.subject,
    assertion: c.assertion as UiSpecT["acceptanceCriteria"][number]["assertion"],
    expectedOutcome: c.expectedOutcome,
    verifier: "manual",
    priority: c.priority as "must" | "should",
    evidenceIds: [...c.evidenceIds],
    manualSteps: [...(c.manualSteps ?? [])],
  }));

  // Caller-supplied constraints are FACTS THE CALLER STATED, not invented judgment,
  // so echoing them as checkable criteria is inside the honesty invariant. `manual`
  // because nothing here can verify them; no evidenceIds because no evidence grounds
  // a caller assertion; `should` because the caller stated no priority and there is
  // no "unspecified" member of AcceptancePriority. The constraint text is the
  // `subject` so the design-handoff renderer's "<subject> <assertion> →
  // <expectedOutcome>" sentence parses (src/design-handoff.ts:403-406).
  //
  // COVERAGE NOTE: `assemblyRulesSha256` hashes the recipe FILE, and
  // RECIPE.acceptanceCriteria holds one entry while an artifact may now carry up
  // to 13. Nothing breaks — that hash never covered the produced output — but
  // `spec.acceptanceCriteria` is no longer fully derivable from the frozen rules.
  const callerCriteria: UiSpecT["acceptanceCriteria"] = request.constraints.map((text, i) => ({
    id: `caller-constraint-${i + 1}`,
    subject: text,
    assertion: "exists" as const,
    expectedOutcome: `The delivered UI satisfies this caller-stated constraint: ${text}`,
    verifier: "manual" as const,
    priority: "should" as const,
    evidenceIds: [],
    manualSteps: [`Confirm by inspection that the UI satisfies: ${text}`],
  }));

  // Appended, never prepended: acceptanceCriteria[0] stays the recipe criterion.
  const acceptanceCriteria: UiSpecT["acceptanceCriteria"] = [...recipeCriteria, ...callerCriteria];

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
      // Caller-supplied design intent is RECORDED here and nowhere else.
      // `spec.context` is the annotated caller-supplied lane, it is what
      // design-handoff renders from, and it is what buildSemanticSpecInput
      // hashes — so recording it here is simultaneously the visible proof the
      // intent was honored and the reason two intents produce two artifactIds.
      // Tokens stay null: intent is not a token decision.
      ...(request.colorIntent !== undefined ? { colorIntent: request.colorIntent } : {}),
      ...(request.typeIntent !== undefined ? { typeIntent: request.typeIntent } : {}),
    },
    designDirection: synthesis?.designDirection ?? specFields.designDirection,
    rejectedDefaults: specFields.rejectedDefaults,
    layoutRegions: synthesis && synthesis.layoutRegions.length > 0
      ? synthesis.layoutRegions
      : specFields.layoutRegions,
    responsiveBehavior: synthesis && synthesis.responsiveBehavior.length > 0
      ? synthesis.responsiveBehavior
      : specFields.responsiveBehavior,
    componentInventory: synthesis && synthesis.componentInventory.length > 0
      ? synthesis.componentInventory
      : specFields.componentInventory,
    colorTokens: synthesis?.colorTokens ?? null,
    // Corpus-derived when synthesis populated them (see the colorTokens
    // citedDecision above); "editorial" ONLY when they stay null, which the
    // null-token refinement also requires.
    colorTokenAuthority: synthesis?.colorTokens ? "corpus-evidence" : "editorial",
    typographyTokens: null,
    typographyTokenAuthority: "editorial",
    ...(proposal !== undefined ? { modelProposal: proposal } : {}),
    interactions: specFields.interactions,
    motionGuidance: { notes: [], evidenceUnavailable: true },
    accessibilityConstraints: synthesis && synthesis.accessibilityConstraints.length > 0
      ? synthesis.accessibilityConstraints
      : specFields.accessibilityConstraints,
    ...(specFields.frameworkNotes !== undefined ? { frameworkNotes: specFields.frameworkNotes } : {}),
    ...(synthesis?.contentVoiceGuidance ? { contentVoiceGuidance: synthesis.contentVoiceGuidance } : {}),
    techniques: synthesis && synthesis.techniques.length > 0 ? synthesis.techniques : specFields.techniques,
    antiPatterns: synthesis && synthesis.antiPatterns.length > 0 ? synthesis.antiPatterns : specFields.antiPatterns,
    unavailableDecisions,
    acceptanceCriteria,
    citedReferences,
    citedDecisions: citedDecisionsWithVoice,
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
 * Build the citedDecisions block from the checked-in recipe. The current
 * recipe declares editorial recipe/system decisions only; that constraint is
 * parsed at runtime so a future recipe cannot be silently rewritten into this
 * producer's old hardcoded authority shape.
 *
 * `editorialLane` is passed only to satisfy the UiSpec superRefine
 * (editorial-authority decisions must cite an evidence id present in the
 * editorialGuidance lane); the recipe id is always the first entry there.
 */
function buildCitedDecisions(
  editorialLane: readonly string[],
  recipe: FallbackRecipe = RECIPE,
): UiSpecT["citedDecisions"] {
  const recipeEvidenceId = recipe.recipeEvidence.id;
  // The recipe/system evidence id must be in the editorial lane so the
  // editorial-authority citedDecision references a lane member.
  if (!editorialLane.includes(recipeEvidenceId)) {
    return [];
  }
  const values = getCitedDecisionRecipe(recipe);
  return values.map((row, index) => {
    return {
      id: `${row.field}-editorial-${index + 1}`,
      field: row.field,
      authority: row.authority,
      evidenceIds: [recipeEvidenceId],
      readiness: "available" as const,
    };
  });
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
  corpusEntries: readonly CorpusEntryT[],
  generatedAt: string,
  proposal?: ModelProposal,
  execution?: ModelExecution,
): DesignArtifactEnvelope {
  const spec = assembleSpec(request, resolved, corpusEntries, generatedAt, proposal);

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
    ...(execution !== undefined
      ? {
          modelExecution: execution,
          modelExecutionSha256: sha256Canonical(execution),
        }
      : {}),
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
  return sha256Canonical(RECIPE);
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
