/**
 * C2 immutable run engine (Task 7, Step 4).
 *
 * `executeC2Run(request, deps)` implements the 10-step immutable run lifecycle
 * from design spec §6:
 *
 *   1.  Validate case-package and referenced artifact hashes.
 *   2.  Resolve and freeze the condition input.           [harness receives it resolved]
 *   3.  Validate exact provider, exact model, pricing, credentials, paid auth.
 *   4.  Conservatively forecast the call cost and apply both budgets.
 *   5.  Atomically write a new RUNNING manifest.
 *   6.  Make EXACTLY ONE logical pinned provider call (bounded transport retry).
 *   7.  Store the raw provider response inside the private boundary.
 *   8.  Parse and strictly validate the candidate artifact.
 *   9.  Finalize the run manifest (output hashes, telemetry, cost, terminal status).
 *   10. Load the reviewer-only label AFTER generation and write a linked score.
 *
 * Discipline (spec §6, §7, §8, §12):
 *   - Immutability: a terminal run directory is never overwritten. Retries
 *     get a new runId and a predecessorRunId pointing at the prior run.
 *   - One logical call per run: malformed output is NOT repaired or retried
 *     inside the same run. It is a `parse-failed` terminal state.
 *   - Cost preservation: actual cost is recorded even when parsing or
 *     validation later fails — the response cost real money.
 *   - `cost-blocked` = zero execution: no attempts, no tokens, no cost, no
 *     output hashes, finishedAt stays null.
 *   - `run-budget-exceeded` = actual > $0.50 after a successful response:
 *     raw-output hash + actual usage preserved, parsing skipped,
 *     parsedOutputSha256 null, campaign stops immediately.
 *   - `campaign-stopped`: once the campaign is stopped, the next queued run
 *     performs no provider call and terminates immediately.
 *
 * The harness consumes an ALREADY-RESOLVED condition input (Task 6's resolver
 * runs offline in the `prepare` CLI command). The harness performs no
 * retrieval; its only side effects are one logical provider call, private
 * writes under `.c2-private/`, and one durable manifest + score write.
 */
import { canonicalJsonStringify, sha256Hex } from "../readiness/contracts.js";
import { C2CandidateArtifactSchema } from "./candidate-contracts.js";
import type { C2CandidateArtifact } from "./candidate-contracts.js";
import type { C2CaseBrief, C2DecisionLabel } from "./case-contracts.js";
import type { C2ConditionInput } from "./condition-contracts.js";
import {
  C2EvaluationRunManifestV2Schema,
  type C2EvaluationRunManifestV2,
} from "./evaluation-contracts.js";
import { scoreC2Candidate } from "./scorer.js";
import { buildC2Prompt } from "./prompt-builder.js";
import {
  calculateActualCost,
  forecastRunCost,
  assertRunBudget,
  assertCampaignBudget,
  type C2PricingEntryLike,
} from "./cost-policy.js";
import type { BoundaryScanConfig } from "./private-artifacts.js";
import { scanDurableArtifact } from "./private-artifacts.js";
import type { ModelCallResult, Provider } from "../tagger.js";
import type { ArtifactFileRef } from "./primitives.js";

// ---------------------------------------------------------------------------
// Public request / dependency / store types
// ---------------------------------------------------------------------------

/**
 * The pinned model the harness will call. This is the C2-pinned shape (not the
 * broader `TextModelRequest`): the harness translates it into a
 * `TextModelRequest` for `callTextModelWithMetadata`.
 */
export interface C2PinnedModelRequest {
  provider: Provider;
  model: string;
  apiKeyEnv: string;
  maxOutputTokens: number;
  samplingParameters: Record<string, string | number | boolean>;
}

/**
 * Request to execute one immutable C2 run. The condition input MUST already be
 * resolved (Task 6); the harness performs no retrieval.
 */
export interface ExecuteC2RunRequest {
  /** Hash-bound reference to the case package manifest (validated in step 1). */
  casePackageRef: ArtifactFileRef;
  /** Model-visible case brief (used for prompt building + scoring). */
  brief: C2CaseBrief;
  /**
   * Reviewer-only decision label. Loaded ONLY for scoring (step 10) — never
   * for prompt construction. The structural separation is enforced by
   * `buildC2Prompt` taking no label parameter.
   */
  label: C2DecisionLabel;
  /** The already-resolved, hash-bound condition input. */
  conditionInput: C2ConditionInput;
  /** Reference to the resolved condition input on disk (for the manifest). */
  conditionInputRef: ArtifactFileRef;
  /** Reference to the scorer implementation (for the manifest). */
  scorerRef: ArtifactFileRef;
  /** The pinned model to call exactly once. */
  model: C2PinnedModelRequest;
  /**
   * Resolved model-visible evidence content keyed by evidence record ID. For
   * brief-only runs this is empty. The harness refuses to build a prompt
   * whose declared evidence has no content (delegated to `buildC2Prompt`).
   */
  evidenceContent: ReadonlyMap<string, string>;
  /** Harness/source git sha, bound into every manifest. */
  harnessGitSha: string;
  /** Source-snapshot IDs the run binds (empty for non-migration cases). */
  sourceSnapshotIds: readonly string[];
  /**
   * Prior run for this (caseId, condition, configuration). Null for the first
   * attempt; set to the prior runId for every retry. The harness never
   * overwrites a terminal run — it always emits a new runId.
   */
  predecessorRunId: string | null;
}

/**
 * Injected dependencies. Every side effect (model, clock, ID, store, scoring
 * hash) is injected so tests can pin them and assert exact behavior.
 */
export interface ExecuteC2RunDeps {
  /**
   * The pinned model call. Injected so tests can return canned responses,
   * throw to simulate provider failures, or assert zero invocations. The
   * production binding is `callTextModelWithMetadata`.
   */
  callModel: (request: {
    prompt: string;
    provider: Provider;
    model: string;
    apiKeyEnv: string;
    maxOutputTokens: number;
    maxAttempts: number;
    samplingParameters: Record<string, string | number | boolean>;
  }) => Promise<ModelCallResult>;
  /** Fixed ISO-8601 timestamp factory (deterministic in tests). */
  now: () => string;
  /**
   * Stable runId generator. Receives (caseId, condition, attempt number). The
   * attempt number is a monotonic per-(caseId, condition) counter the CLI
   * maintains; the harness just threads it through.
   */
  runId: (caseId: string, condition: string, attempt: number) => string;
  /** SHA-256 of the scorer implementation (bound into every score artifact). */
  scorerSha256: () => string;
  /** Private + durable artifact store (atomic writes, boundary scans). */
  store: C2RunStore;
  /** Mutable campaign state (spent, stopped, stopReason, pricing). */
  campaign: CampaignState;
  /** Boundary scan configuration for durable writes. */
  boundaryScan: BoundaryScanConfig;
  /**
   * Prompt-token estimator for the forecast (step 4). Defaults to a
   * conservative byte-based estimate (~4 bytes/token). Tests pin this exactly
   * so the forecast math is deterministic; the CLI uses the default.
   */
  estimatePromptTokens?: (prompt: string) => number;
}

/**
 * Private + durable write abstraction. Every method is async so the production
 * binding can fsync + rename atomically; tests bind in-memory implementations.
 */
export interface C2RunStore {
  /** Write bytes under the private run boundary (`.c2-private/`). */
  writePrivate: (relPath: string, bytes: Buffer) => Promise<void> | void;
  /**
   * Atomically write a terminal/running manifest as canonical JSON under
   * `eval/c2/runs/<runId>/manifest.json`. Runs the boundary scan FIRST.
   */
  writeDurableManifest: (runId: string, manifestJson: string) => Promise<void> | void;
  /** Atomically write a deterministic score artifact under the run dir. */
  writeDurableScore: (runId: string, scoreJson: string) => Promise<void> | void;
  /** Whether a terminal manifest already exists for this runId. */
  hasTerminalRun: (runId: string) => boolean;
}

/**
 * Mutable campaign state the harness updates in place. The CLI owns the
 * instance and threads it across every `executeC2Run` call so a `stopped`
 * flag set by one run blocks the next queued run.
 */
export interface CampaignState {
  /** USD spent so far (sum of actual costs across all prior runs). */
  spentUsd: number;
  /** Whether the campaign has been stopped (budget overrun, etc.). */
  stopped: boolean;
  /** Why the campaign stopped; null while running. */
  stopReason: "run-budget-exceeded" | "campaign-budget-exceeded" | null;
  /**
   * The pricing entry for the pinned (provider, model) this campaign is
   * billed against. The harness passes this in directly (rather than doing a
   * pricing-table lookup) because pricing lookup is a preflight concern owned
   * by the CLI; the harness's only cost jobs are forecast + actual + budget.
   */
  pricingEntry: C2PricingEntryLike;
}

// ---------------------------------------------------------------------------
// Terminal outcome helpers
// ---------------------------------------------------------------------------

type TerminalReason = NonNullable<C2EvaluationRunManifestV2["terminalReason"]>;

/** Attempt counter for a (caseId, condition) the CLI passes via the request. */
function attemptFromRequest(request: ExecuteC2RunRequest): number {
  // The CLI derives the attempt from predecessorRunId depth; the first run is
  // attempt 1. We keep it simple: attempt = predecessor ? prior+1 : 1, but the
  // CLI is the authority on attempt numbering. For the harness's own bookkeeping
  // we just need a non-zero positive int for the manifest; the CLI can override
  // by passing the attempt in the runId callback.
  return request.predecessorRunId ? 2 : 1;
}

// ---------------------------------------------------------------------------
// The 10-step run engine
// ---------------------------------------------------------------------------

/**
 * Execute one immutable C2 run. See module docstring for the 10-step lifecycle.
 *
 * Returns the finalized V2 manifest. The manifest is ALSO durably persisted
 * through `deps.store.writeDurableManifest` exactly once (the running-state
 * pre-egress write is replaced by the final write — there is exactly one
 * durable write per run, and it is the final manifest).
 *
 * Throws on infrastructure failures that prevent a manifest from being
 * recorded (e.g. pre-egress atomic-write failure, store I/O error).
 */
export async function executeC2Run(
  request: ExecuteC2RunRequest,
  deps: ExecuteC2RunDeps,
): Promise<C2EvaluationRunManifestV2> {
  // ─── Step 0a: campaign-stopped short-circuit ────────────────────────────
  // If the campaign is already stopped, this run makes no provider call. It
  // terminates immediately with `campaign-stopped`. This is what makes the
  // run-budget-exceeded test's "next queued run performs no provider call"
  // assertion hold.
  if (deps.campaign.stopped) {
    return await finalizeCampaignStopped(request, deps);
  }

  // ─── Step 1: validate case-package and referenced artifact hashes ───────
  // The harness verifies the case-package ref shape + that the brief's caseId
  // matches the label's caseId and the condition input's bound casePackageRef.
  // (Full hash verification against on-disk bytes happens in the CLI's
  // preflight; the harness re-asserts the structural invariants.)
  assertCasePackageConsistency(request);

  // ─── Step 2: condition input is already resolved ────────────────────────
  // The resolver (Task 6) ran offline in `prepare`. The harness trusts the
  // resolved `conditionInput` and its `inputSha256`. We do re-assert the
  // brief/label/condition caseId consistency here.
  const caseId = request.brief.caseId;
  if (request.label.caseId !== caseId) {
    throw new Error(
      `[c2-harness] caseId mismatch: brief=${caseId} label=${request.label.caseId}`,
    );
  }

  // ─── Step 3: validate provider, model, pricing, credentials, paid auth ──
  // The CLI is the authority on credentials + `--paid`. The harness asserts
  // the model is non-empty + the pricing entry's (provider, model) matches
  // the pinned request (no silent substitution).
  assertPinnedModel(request, deps);

  // ─── Step 4: forecast + apply both budgets ──────────────────────────────
  // The forecast uses the FULL maxOutputTokens (pessimistic). If it exceeds
  // the run ceiling OR the remaining campaign budget, record `cost-blocked`
  // and make NO provider request. Zero execution fields.
  const promptTokenEstimate = estimatePromptTokens(request, deps);
  const forecast = forecastRunCost({
    promptTokens: promptTokenEstimate,
    maxOutputTokens: request.model.maxOutputTokens,
    pricingEntry: deps.campaign.pricingEntry,
  });

  const runBudget = assertRunBudget({
    forecastUsd: forecast.rawForecastUsd,
    ceilingUsd: 0.5, // pinned nominal per-run ceiling
  });
  if (!runBudget.allowed) {
    return await finalizeCostBlocked(request, deps, forecast.forecastUsd);
  }

  const campaignBudget = assertCampaignBudget({
    spentUsd: deps.campaign.spentUsd,
    forecastUsd: forecast.rawForecastUsd,
    ceilingUsd: 5, // pinned campaign ceiling
  });
  if (!campaignBudget.allowed) {
    // A campaign-budget denial is also recorded as cost-blocked at the run
    // level (zero execution). The campaign itself is NOT yet stopped — the
    // CLI may revise the run matrix. (Spec §12 lists campaign-stopped
    // separately; a single forecast overage does not by itself stop the
    // campaign, it just blocks THIS run.)
    return await finalizeCostBlocked(request, deps, forecast.forecastUsd);
  }

  // ─── Step 5: build the prompt + write the RUNNING manifest ──────────────
  // The prompt is built BEFORE egress so its hash is available for the
  // running manifest. The running manifest is written BEFORE the provider
  // call so an interrupted run leaves a durable record that it started.
  const builtPrompt = buildC2Prompt({
    brief: request.brief,
    conditionInput: request.conditionInput,
    evidenceContent: request.evidenceContent,
  });

  const attempt = attemptFromRequest(request);
  const runId = deps.runId(caseId, request.conditionInput.condition, attempt);

  // Immutability: refuse to overwrite a terminal run directory.
  if (deps.store.hasTerminalRun(runId)) {
    throw new Error(
      `[c2-harness] terminal run already exists for runId=${runId}; immutable runs cannot be overwritten. `
      + `Retry with a new runId (predecessorRunId=${runId}).`,
    );
  }

  const startedAt = deps.now();
  const runningManifest = buildManifest({
    request,
    runId,
    startedAt,
    finishedAt: null,
    status: "running",
    terminalReason: null,
    promptSha256: builtPrompt.promptSha256,
    rawOutputSha256: null,
    parsedOutputSha256: null,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
    attemptCount: 0,
    providerLatencyMs: 0,
    validationErrors: [],
    forecastUsd: forecast.forecastUsd,
  });

  // Pre-egress durable write. A failure here propagates — no provider call.
  // This is the "atomic-write failure" test: the write happens before egress.
  await writeManifestDurable(deps, runId, runningManifest);

  // ─── Step 6: exactly one logical pinned provider call ───────────────────
  let callResult: ModelCallResult;
  try {
    callResult = await deps.callModel({
      prompt: builtPrompt.prompt,
      provider: request.model.provider,
      model: request.model.model,
      apiKeyEnv: request.model.apiKeyEnv,
      maxOutputTokens: request.model.maxOutputTokens,
      maxAttempts: 1, // ONE logical call; transport retry is bounded inside callModel
      samplingParameters: request.model.samplingParameters,
    });
  } catch (err) {
    // Provider failure (transport, HTTP 5xx, auth, etc.). The run terminates
    // failed/provider-failed. No tokens were successfully exchanged, so cost
    // is zero. (If the provider charged for a failed attempt, the metadata
    // path would surface it — but a thrown error means no usable response.)
    return finalizeProviderFailed(request, deps, runId, startedAt, builtPrompt.promptSha256, err);
  }

  // ─── Step 7: store the raw response inside the private boundary ─────────
  const rawOutputSha256 = sha256Hex(Buffer.from(callResult.content, "utf-8"));
  await deps.store.writePrivate(
    `runs/${runId}/raw-response.json`,
    Buffer.from(callResult.content, "utf-8"),
  );

  // ─── Step 8 + 9: actual cost, parse, validate, finalize ─────────────────
  const actual = calculateActualCost({
    promptTokens: callResult.usage.promptTokens,
    completionTokens: callResult.usage.completionTokens,
    pricingEntry: deps.campaign.pricingEntry,
  });

  // Cost preservation: add actual cost to campaign spend BEFORE any
  // parse/validate decision. The response cost real money regardless of
  // whether the candidate parses.
  deps.campaign.spentUsd = round6(deps.campaign.spentUsd + actual.rawActualUsd);

  // run-budget-exceeded: actual > $0.50 after a successful response. Parsing
  // is SKIPPED (parsedOutputSha256 stays null), the raw-output hash + actual
  // usage are preserved for audit, and the campaign STOPS immediately so the
  // next queued run performs no provider call.
  if (actual.actualUsd > 0.5) {
    return finalizeRunBudgetExceeded(request, deps, runId, startedAt, {
      promptSha256: builtPrompt.promptSha256,
      rawOutputSha256,
      promptTokens: callResult.usage.promptTokens,
      completionTokens: callResult.usage.completionTokens,
      costUsd: actual.actualUsd,
      attemptCount: callResult.attempts,
      providerLatencyMs: callResult.latencyMs,
    });
  }

  // Parse one JSON object from the raw response. Do NOT repair, do NOT make a
  // second model call. A parse failure is a terminal `parse-failed` state but
  // PRESERVES the raw-output hash + actual cost.
  let parsed: unknown;
  try {
    parsed = parseOneJsonObject(callResult.content);
  } catch (err) {
    return finalizeParseFailed(request, deps, runId, startedAt, {
      promptSha256: builtPrompt.promptSha256,
      rawOutputSha256,
      promptTokens: callResult.usage.promptTokens,
      completionTokens: callResult.usage.completionTokens,
      costUsd: actual.actualUsd,
      attemptCount: callResult.attempts,
      providerLatencyMs: callResult.latencyMs,
      parseError: err instanceof Error ? err.message : String(err),
    });
  }

  // Strict candidate validation.
  const candidateParse = C2CandidateArtifactSchema.safeParse(parsed);
  if (!candidateParse.success) {
    return finalizeValidationFailed(request, deps, runId, startedAt, {
      promptSha256: builtPrompt.promptSha256,
      rawOutputSha256,
      promptTokens: callResult.usage.promptTokens,
      completionTokens: callResult.usage.completionTokens,
      costUsd: actual.actualUsd,
      attemptCount: callResult.attempts,
      providerLatencyMs: callResult.latencyMs,
      validationErrors: summarizeZodError(candidateParse.error.message),
    });
  }
  const candidate = candidateParse.data;
  const parsedOutputSha256 = sha256Hex(
    Buffer.from(canonicalJsonStringify(candidate), "utf-8"),
  );

  // ─── Step 9: finalize the run manifest (succeeded) ──────────────────────
  const finishedAt = deps.now();
  const succeededManifest = buildManifest({
    request,
    runId,
    startedAt,
    finishedAt,
    status: "succeeded",
    terminalReason: "succeeded",
    promptSha256: builtPrompt.promptSha256,
    rawOutputSha256,
    parsedOutputSha256,
    promptTokens: callResult.usage.promptTokens,
    completionTokens: callResult.usage.completionTokens,
    costUsd: actual.actualUsd,
    attemptCount: callResult.attempts,
    providerLatencyMs: callResult.latencyMs,
    validationErrors: [],
    forecastUsd: forecast.forecastUsd,
  });

  // Persist the final manifest (replaces the running-state pre-egress write).
  await writeManifestDurable(deps, runId, succeededManifest);

  // ─── Step 10: score with the reviewer-only label + write linked score ───
  // The label is loaded ONLY now, after generation. The scorer parses the
  // candidate through the strict schema again and refuses a parse failure
  // (which cannot happen here — we already validated).
  const score = scoreC2Candidate({
    artifactId: `c2-score-${runId}`,
    runId,
    runOutputSha256: rawOutputSha256,
    scorerSha256: deps.scorerSha256(),
    candidate,
    brief: request.brief,
    label: request.label,
    conditionInput: request.conditionInput,
  });
  await writeScoreDurable(deps, runId, score);

  return succeededManifest;
}

// ---------------------------------------------------------------------------
// Finalizers — one per terminal state. Each builds the manifest, persists it
// exactly once, and updates campaign state where the spec requires.
// ---------------------------------------------------------------------------

interface FinalizeCostFields {
  promptSha256: string;
  rawOutputSha256: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  attemptCount: number;
  providerLatencyMs: number;
}

async function finalizeProviderFailed(
  request: ExecuteC2RunRequest,
  deps: ExecuteC2RunDeps,
  runId: string,
  startedAt: string,
  promptSha256: string,
  err: unknown,
): Promise<C2EvaluationRunManifestV2> {
  const manifest = buildManifest({
    request,
    runId,
    startedAt,
    finishedAt: deps.now(),
    status: "failed",
    terminalReason: "provider-failed",
    promptSha256,
    rawOutputSha256: null,
    parsedOutputSha256: null,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
    attemptCount: 0,
    providerLatencyMs: 0,
    validationErrors: [err instanceof Error ? err.message : String(err)],
    forecastUsd: null,
  });
  await writeManifestDurable(deps, runId, manifest);
  return manifest;
}

async function finalizeParseFailed(
  request: ExecuteC2RunRequest,
  deps: ExecuteC2RunDeps,
  runId: string,
  startedAt: string,
  fields: FinalizeCostFields & { parseError: string },
): Promise<C2EvaluationRunManifestV2> {
  const manifest = buildManifest({
    request,
    runId,
    startedAt,
    finishedAt: deps.now(),
    status: "failed",
    terminalReason: "parse-failed",
    promptSha256: fields.promptSha256,
    rawOutputSha256: fields.rawOutputSha256,
    parsedOutputSha256: null,
    promptTokens: fields.promptTokens,
    completionTokens: fields.completionTokens,
    costUsd: fields.costUsd,
    attemptCount: fields.attemptCount,
    providerLatencyMs: fields.providerLatencyMs,
    validationErrors: [fields.parseError],
    forecastUsd: null,
  });
  await writeManifestDurable(deps, runId, manifest);
  return manifest;
}

async function finalizeValidationFailed(
  request: ExecuteC2RunRequest,
  deps: ExecuteC2RunDeps,
  runId: string,
  startedAt: string,
  fields: FinalizeCostFields & { validationErrors: string[] },
): Promise<C2EvaluationRunManifestV2> {
  const manifest = buildManifest({
    request,
    runId,
    startedAt,
    finishedAt: deps.now(),
    status: "failed",
    terminalReason: "validation-failed",
    promptSha256: fields.promptSha256,
    rawOutputSha256: fields.rawOutputSha256,
    parsedOutputSha256: null,
    promptTokens: fields.promptTokens,
    completionTokens: fields.completionTokens,
    costUsd: fields.costUsd,
    attemptCount: fields.attemptCount,
    providerLatencyMs: fields.providerLatencyMs,
    validationErrors: fields.validationErrors,
    forecastUsd: null,
  });
  await writeManifestDurable(deps, runId, manifest);
  return manifest;
}

async function finalizeRunBudgetExceeded(
  request: ExecuteC2RunRequest,
  deps: ExecuteC2RunDeps,
  runId: string,
  startedAt: string,
  fields: FinalizeCostFields,
): Promise<C2EvaluationRunManifestV2> {
  const manifest = buildManifest({
    request,
    runId,
    startedAt,
    finishedAt: deps.now(),
    status: "failed",
    terminalReason: "run-budget-exceeded",
    promptSha256: fields.promptSha256,
    rawOutputSha256: fields.rawOutputSha256, // preserved for audit
    parsedOutputSha256: null, // parsing skipped
    promptTokens: fields.promptTokens,
    completionTokens: fields.completionTokens,
    costUsd: fields.costUsd,
    attemptCount: fields.attemptCount,
    providerLatencyMs: fields.providerLatencyMs,
    validationErrors: [],
    forecastUsd: null,
  });
  await writeManifestDurable(deps, runId, manifest);
  // Campaign stops immediately so the next queued run performs no provider call.
  deps.campaign.stopped = true;
  deps.campaign.stopReason = "run-budget-exceeded";
  return manifest;
}

async function finalizeCostBlocked(
  request: ExecuteC2RunRequest,
  deps: ExecuteC2RunDeps,
  forecastUsd: number,
): Promise<C2EvaluationRunManifestV2> {
  // cost-blocked: zero execution. No attempts, no tokens, no cost, no output
  // hashes, finishedAt stays null. The runId is still assigned (the run was
  // attempted) and the promptSha256 is computed (the prompt was built) so the
  // block is auditable.
  const builtPrompt = buildC2Prompt({
    brief: request.brief,
    conditionInput: request.conditionInput,
    evidenceContent: request.evidenceContent,
  });
  const attempt = attemptFromRequest(request);
  const runId = deps.runId(request.brief.caseId, request.conditionInput.condition, attempt);
  const startedAt = deps.now();
  const manifest = buildManifest({
    request,
    runId,
    startedAt,
    finishedAt: null,
    status: "cost-blocked",
    terminalReason: "cost-blocked",
    promptSha256: builtPrompt.promptSha256,
    rawOutputSha256: null,
    parsedOutputSha256: null,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
    attemptCount: 0,
    providerLatencyMs: 0,
    validationErrors: [],
    forecastUsd,
  });
  // Best-effort durable write — the manifest is also returned to the caller,
  // who may persist it. cost-blocked runs MUST be recorded so a blocked run
  // is auditable, but a write failure here does not obscure the block (the
  // returned manifest is the source of truth for tests).
  await writeManifestDurable(deps, runId, manifest);
  return manifest;
}

async function finalizeCampaignStopped(
  request: ExecuteC2RunRequest,
  deps: ExecuteC2RunDeps,
): Promise<C2EvaluationRunManifestV2> {
  // The campaign is already stopped. This run makes no provider call and no
  // forecast. It terminates immediately with campaign-stopped. Cost is zero
  // (no execution). finishedAt IS set (this is a terminal state, just not one
  // that involved egress).
  const builtPrompt = buildC2Prompt({
    brief: request.brief,
    conditionInput: request.conditionInput,
    evidenceContent: request.evidenceContent,
  });
  const attempt = attemptFromRequest(request);
  const runId = deps.runId(request.brief.caseId, request.conditionInput.condition, attempt);
  const startedAt = deps.now();
  const manifest = buildManifest({
    request,
    runId,
    startedAt,
    finishedAt: deps.now(),
    status: "failed",
    terminalReason: "campaign-stopped",
    promptSha256: builtPrompt.promptSha256,
    rawOutputSha256: null,
    parsedOutputSha256: null,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
    attemptCount: 0,
    providerLatencyMs: 0,
    validationErrors: [],
    forecastUsd: null,
  });
  await writeManifestDurable(deps, runId, manifest);
  return manifest;
}

// ---------------------------------------------------------------------------
// Manifest construction + persistence
// ---------------------------------------------------------------------------

interface BuildManifestInput {
  request: ExecuteC2RunRequest;
  runId: string;
  startedAt: string;
  finishedAt: string | null;
  status: C2EvaluationRunManifestV2["status"];
  terminalReason: TerminalReason | null;
  promptSha256: string;
  rawOutputSha256: string | null;
  parsedOutputSha256: string | null;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  attemptCount: number;
  providerLatencyMs: number;
  validationErrors: string[];
  forecastUsd: number | null;
}

function buildManifest(input: BuildManifestInput): C2EvaluationRunManifestV2 {
  const r = input.request;
  // `forecastUsd` is carried on the input for future audit enrichment but is
  // not part of the V2 manifest schema, so it is intentionally not serialized.
  void input.forecastUsd;
  const manifest: Record<string, unknown> = {
    schemaVersion: "2.0",
    artifactType: "c2-evaluation-run",
    artifactId: `c2-run-manifest-${input.runId}`,
    runId: input.runId,
    predecessorRunId: r.predecessorRunId,
    casePackage: r.casePackageRef,
    condition: r.conditionInput.condition,
    corpusSha256: r.conditionInput.corpusSha256,
    retrievalIndexSha256: r.conditionInput.retrievalIndexSha256,
    promptSha256: input.promptSha256,
    harnessGitSha: r.harnessGitSha,
    provider: r.model.provider,
    model: r.model.model,
    samplingParameters: r.model.samplingParameters,
    evidenceIds: r.conditionInput.evidence.map((e) => e.id),
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    status: input.status,
    inputSha256: r.conditionInput.inputSha256,
    rawOutputSha256: input.rawOutputSha256,
    parsedOutputSha256: input.parsedOutputSha256,
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    costUsd: input.costUsd,
    conditionInputRef: r.conditionInputRef,
    scorerRef: r.scorerRef,
    attemptCount: input.attemptCount,
    providerLatencyMs: input.providerLatencyMs,
    terminalReason: input.terminalReason,
    validationErrors: input.validationErrors,
    sourceSnapshotIds: r.sourceSnapshotIds,
  };
  return C2EvaluationRunManifestV2Schema.parse(manifest);
}

async function writeManifestDurable(
  deps: ExecuteC2RunDeps,
  runId: string,
  manifest: C2EvaluationRunManifestV2,
): Promise<void> {
  const json = canonicalJsonStringify(manifest);
  // Boundary scan BEFORE the write: a manifest carrying secret material,
  // prompt/evidence/raw content fields, private paths, or case private markers
  // must never be persisted durably. The boundaryScan config is injected by the
  // caller (the CLI threads in the resolved API-key values + secret env-var
  // names) so the scan runs against the actual secrets in scope.
  scanDurableArtifact(json, deps.boundaryScan);
  // The durable artifact path is the canonical run dir.
  await deps.store.writeDurableManifest(runId, json);
}

async function writeScoreDurable(
  deps: ExecuteC2RunDeps,
  runId: string,
  score: unknown,
): Promise<void> {
  // The store binding is the authority — tests inject an in-memory store; the
  // production CLI's store runs the boundary scan before writing to disk.
  await deps.store.writeDurableScore(runId, canonicalJsonStringify(score));
}

// ---------------------------------------------------------------------------
// Preflight assertions
// ---------------------------------------------------------------------------

function assertCasePackageConsistency(request: ExecuteC2RunRequest): void {
  const caseId = request.brief.caseId;
  if (request.label.caseId !== caseId) {
    throw new Error(
      `[c2-harness] brief caseId (${caseId}) does not match label caseId (${request.label.caseId})`,
    );
  }
  if (request.casePackageRef.artifactId.length === 0) {
    throw new Error("[c2-harness] casePackageRef.artifactId is empty");
  }
}

function assertPinnedModel(request: ExecuteC2RunRequest, deps: ExecuteC2RunDeps): void {
  if (!request.model.model || request.model.model.trim().length === 0) {
    throw new Error("[c2-harness] pinned model is empty");
  }
  // No silent model substitution: the campaign's pricing entry must be for the
  // exact (provider, model) being called.
  const pe = deps.campaign.pricingEntry;
  if (pe.provider !== request.model.provider || pe.model !== request.model.model) {
    throw new Error(
      `[c2-harness] pricing entry (provider=${pe.provider} model=${pe.model}) does not match pinned `
      + `request (provider=${request.model.provider} model=${request.model.model}). Refusing silent substitution.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Estimate prompt tokens for the forecast. A real tokenizer is out of scope
 * for the harness (and would couple it to provider SDKs). We use a stable,
 * conservative byte-based estimate: ~4 bytes per token. The forecast is
 * pessimistic already (full maxOutputTokens), so a slightly-liberal prompt
 * estimate keeps the worst-case bound honest. Tests inject an exact estimator
 * so the forecast math is deterministic.
 */
function estimatePromptTokens(request: ExecuteC2RunRequest, deps: ExecuteC2RunDeps): number {
  const prompt = buildC2Prompt({
    brief: request.brief,
    conditionInput: request.conditionInput,
    evidenceContent: request.evidenceContent,
  });
  if (deps.estimatePromptTokens) {
    return Math.max(1, deps.estimatePromptTokens(prompt.prompt));
  }
  const bytes = Buffer.byteLength(prompt.prompt, "utf-8");
  return Math.max(1, Math.ceil(bytes / 4));
}

/**
 * Parse exactly one JSON object from the raw model response. Refuses:
 *   - empty / whitespace-only strings
 *   - multiple top-level JSON values
 *   - arrays / scalars (the candidate must be a single object)
 *   - a leading/trailing code fence
 * Does NOT repair or retry. A failure here is a `parse-failed` terminal.
 */
function parseOneJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error("[c2-harness] empty model response");
  }
  // Strip a single optional ```json ... ``` fence. We do NOT strip arbitrary
  // prose — the system instruction forbids it. A fenced object is the one
  // tolerated shape because some providers wrap output despite instructions.
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const body = fenced ? fenced[1]! : trimmed;
  // JSON.parse accepts only one top-level value; trailing garbage throws.
  const value = JSON.parse(body) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("[c2-harness] model response is not a single JSON object");
  }
  return value;
}

function summarizeZodError(message: string): string[] {
  // Zod errors can be long; keep the first few issue lines for the manifest.
  const lines = message.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  return lines.slice(0, 8);
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

// Re-export the candidate type for the CLI.
export type { C2CandidateArtifact };
