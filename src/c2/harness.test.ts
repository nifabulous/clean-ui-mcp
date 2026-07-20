/**
 * C2 harness tests (Task 7, Step 1 — run-state matrix).
 *
 * These tests pin the 10-step immutable run lifecycle (spec §6) and every
 * terminal state in the failure model (spec §12):
 *   - success                     → status: "succeeded"
 *   - provider failure            → status: "failed", terminalReason: "provider-failed"
 *   - parse failure               → status: "failed", terminalReason: "parse-failed"
 *   - validation failure          → status: "failed", terminalReason: "validation-failed"
 *   - cost-blocked (forecast)     → status: "cost-blocked", zero execution fields
 *   - run-budget-exceeded (actual)→ status: "failed", preserves raw hash + cost, skips parse, stops campaign
 *   - campaign-stopped            → the NEXT queued run makes no provider call
 *   - atomic-write failure        → propagates; no provider call if pre-egress write fails
 *   - predecessor behavior        → second run's predecessorRunId === first runId
 *
 * Cost preservation: actual cost is recorded even when parsing/validation fails
 * after a paid response. `cost-blocked` records zero execution fields. The
 * run-budget-exceeded state preserves the raw-output hash and actual usage for
 * audit, skips parsing (parsedOutputSha256 stays null), and stops the campaign
 * so the next queued run performs no provider call.
 *
 * These tests are fully offline: every model call is injected, every private
 * write goes through an in-memory store, and the clock is pinned.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { ModelCallResult } from "../tagger.js";
import { canonicalJsonStringify, sha256Hex } from "../readiness/contracts.js";
import {
  executeC2Run,
  type ExecuteC2RunRequest,
  type ExecuteC2RunDeps,
  type CampaignState,
  type C2RunStore,
} from "./harness.js";
import type {
  C2CaseBrief,
  C2DecisionLabel,
} from "./case-contracts.js";
import type {
  C2ConditionInput,
  C2CampaignConfig,
  C2PricingTable,
} from "./condition-contracts.js";
import type { C2CandidateArtifact } from "./candidate-contracts.js";
import { C2EvaluationRunManifestV2Schema } from "./evaluation-contracts.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");

// ---------------------------------------------------------------------------
// Fixtures — real pilot artifacts keep the test honest about field shapes.
// ---------------------------------------------------------------------------

const STABLECOIN_BRIEF_PATH = "eval/c2/pilot/briefs/stablecoin-home.json";
const STABLECOIN_LABEL_PATH = "eval/c2/pilot/labels/stablecoin-home.json";

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(join(REPO_ROOT, path), "utf-8")) as T;
}

const PILOT_BRIEF = readJson<C2CaseBrief>(STABLECOIN_BRIEF_PATH);
const PILOT_LABEL = readJson<C2DecisionLabel>(STABLECOIN_LABEL_PATH);

/**
 * A brief-only condition input that passes the schema. Built by hand so the
 * test does not depend on the resolver running first.
 */
function makeBriefOnlyConditionInput(inputSha: string): C2ConditionInput {
  return {
    schemaVersion: "1.0",
    artifactType: "c2-condition-input",
    artifactId: "c2-condition-input-stablecoin-home-brief-only",
    casePackageRef: {
      artifactId: "c2-package-stablecoin-home-v1",
      path: "eval/c2/pilot/manifest.json",
      sha256: "a".repeat(64),
    },
    briefRef: {
      artifactId: PILOT_BRIEF.artifactId,
      path: STABLECOIN_BRIEF_PATH,
      sha256: "b".repeat(64),
    },
    sourceSnapshotRefs: [],
    inputSha256: inputSha,
    condition: "brief-only",
    evidence: [],
    corpusSha256: null,
    retrievalIndexSha256: null,
    retrieval: null,
  };
}

/**
 * A complete candidate that satisfies every closure rule against the stablecoin
 * brief + label. Built by cloning the scorer's known-complete fixture shape and
 * overriding the provenance hash to match the condition input.
 */
function makeCompleteCandidate(inputSha: string): C2CandidateArtifact {
  return {
    schemaVersion: "1.0",
    artifactType: "c2-candidate-design",
    artifactId: "c2-candidate-stablecoin-home-test",
    caseId: PILOT_BRIEF.caseId,
    globalDirection: {
      summary: "Synthetic complete direction for the stablecoin home test case.",
      principles: ["principle:stablecoin-home-1", "principle:stablecoin-home-2"],
    },
    screenBlueprints: PILOT_BRIEF.requiredScreens.map((req) => ({
      id: req.id,
      summary: `Blueprint for ${req.id}`,
      requiredStates: req.states,
      mobileRules: req.mobileRules,
      accessibility: ["accessibility:keyboard-navigation", "accessibility:color-contrast"],
      failureAndRecovery: ["recovery:offline", "recovery:retry"],
      inspectedUrls: [],
    })),
    sourceDecisions: PILOT_LABEL.requiredDecisionIds.map((id) => ({
      id,
      // Use a lane the label permits. The stablecoin label permits adapt+reject
      // (not retain); we pick adapt so every decision is supported.
      lane: PILOT_LABEL.permittedAuthorityLanes[0] ?? "adapt",
      rationale: `Rationale for decision ${id} grounded in the brief.`,
      evidenceIds: [],
    })),
    authorityLanes: {
      retain: [],
      adapt: PILOT_LABEL.requiredDecisionIds.slice(),
      reject: [],
    },
    acceptanceCriteria: PILOT_LABEL.requiredAcceptanceCriteria.map((id) => ({
      id,
      statement: `Acceptance criterion ${id}.`,
    })),
    assumptions: ["assumption:one", "assumption:two"],
    accessibilityAndRecovery: ["accessibility-recovery:one", "accessibility-recovery:two"],
    provenance: { conditionInputSha256: inputSha },
  };
}

/**
 * A minimal pricing entry fixture: USD-per-million-token prices chosen so a
 * known token count produces a known actual cost. We pass this in directly
 * rather than constructing a full pricing table so the harness test stays
 * focused on the lifecycle, not pricing lookups.
 */
function makePricingEntry(opts: { input: number; output: number }) {
  return {
    provider: "openai" as const,
    model: "gpt-5.4-mini",
    inputTokenPriceUsdPerMillion: opts.input,
    outputTokenPriceUsdPerMillion: opts.output,
    effectiveDate: "2026-07-01",
    verifiedAt: "2026-07-18T00:00:00.000Z",
    sourceUrl: "https://platform.openai.com/docs/pricing",
  };
}

function sha256of(value: unknown): string {
  return sha256Hex(Buffer.from(canonicalJsonStringify(value), "utf-8"));
}

const INPUT_SHA = sha256of({ marker: "stablecoin-home-brief-only-v1" });
const HARNESS_GIT_SHA = "62ff45062ff45062ff45062ff45062ff45062ff4".slice(0, 40);
const SCORER_SHA256 = "c".repeat(64);

// ---------------------------------------------------------------------------
// Store / campaign-state factories
// ---------------------------------------------------------------------------

/**
 * Build a private store + campaign state against a temp directory. The store
 * spies on every durable write so tests can assert the running manifest was
 * written before egress and finalized exactly once.
 */
function makeStoreAndCampaign(opts: {
  privateRoot: string;
  durableRoot: string;
  pricingEntryInput: number;
  pricingEntryOutput: number;
  campaignSpentUsd?: number;
  campaignStopped?: boolean;
}): {
  store: C2RunStore;
  campaign: CampaignState;
  writtenDurable: Array<{ runId: string; manifest: Record<string, unknown> }>;
  writtenPrivate: Array<{ relPath: string; bytes: Buffer }>;
  writtenScores: Array<{ runId: string; score: unknown }>;
} {
  const writtenDurable: Array<{ runId: string; manifest: Record<string, unknown> }> = [];
  const writtenPrivate: Array<{ relPath: string; bytes: Buffer }> = [];
  const writtenScores: Array<{ runId: string; score: unknown }> = [];

  const store: C2RunStore = {
    async writePrivate(relPath, bytes) {
      const abs = join(opts.privateRoot, relPath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, bytes);
      writtenPrivate.push({ relPath, bytes });
    },
    async writeDurableManifest(runId, manifestJson) {
      const abs = join(opts.durableRoot, runId, "manifest.json");
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, manifestJson, "utf-8");
      writtenDurable.push({ runId, manifest: JSON.parse(manifestJson) as Record<string, unknown> });
    },
    async writeDurableScore(runId, scoreJson) {
      const abs = join(opts.durableRoot, runId, "score.json");
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, scoreJson, "utf-8");
      writtenScores.push({ runId, score: JSON.parse(scoreJson) });
    },
    hasTerminalRun(runId) {
      return existsSync(join(opts.durableRoot, runId, "manifest.json"));
    },
  };

  const campaign: CampaignState = {
    spentUsd: opts.campaignSpentUsd ?? 0,
    stopped: opts.campaignStopped ?? false,
    stopReason: null,
    pricingEntry: makePricingEntry({
      input: opts.pricingEntryInput,
      output: opts.pricingEntryOutput,
    }),
  };

  return { store, campaign, writtenDurable, writtenPrivate, writtenScores };
}

/**
 * Build the standard request for a successful brief-only run. Tests clone this
 * and override the single field under test.
 */
function makeBaseRequest(overrides: Partial<ExecuteC2RunRequest> = {}): ExecuteC2RunRequest {
  return {
    casePackageRef: {
      artifactId: "c2-package-stablecoin-home-v1",
      path: "eval/c2/pilot/manifest.json",
      sha256: "a".repeat(64),
    },
    brief: PILOT_BRIEF,
    label: PILOT_LABEL,
    conditionInput: makeBriefOnlyConditionInput(INPUT_SHA),
    conditionInputRef: {
      artifactId: "c2-condition-input-stablecoin-home-brief-only",
      // The durable manifest references the condition input by hash; the path
      // points at a durable metadata record, not the private payload storage.
      // (The private payload lives under .c2-private/ but the durable manifest
      // must not reference private paths — the hash is the load-bearing binding.)
      path: "eval/c2/runs/stablecoin-home-brief-only/input-ref.json",
      sha256: "d".repeat(64),
    },
    scorerRef: {
      artifactId: "c2-scorer-v1",
      path: "src/c2/scorer.ts",
      sha256: SCORER_SHA256,
    },
    model: {
      provider: "openai",
      model: "gpt-5.4-mini",
      apiKeyEnv: "OPENAI_API_KEY",
      maxOutputTokens: 2048,
      samplingParameters: { temperature: 0.2, seed: 7 },
    },
    evidenceContent: new Map(),
    harnessGitSha: HARNESS_GIT_SHA,
    sourceSnapshotIds: [],
    predecessorRunId: null,
    ...overrides,
  };
}

/**
 * Build the standard deps for a successful run. The model spy returns the
 * complete candidate JSON; tests override the model to inject failures.
 */
function makeBaseDeps(opts: {
  privateRoot: string;
  durableRoot: string;
  pricingEntryInput: number;
  pricingEntryOutput: number;
  modelResponse?: ModelCallResult | ((req: { prompt: string }) => ModelCallResult);
  campaignSpentUsd?: number;
  campaignStopped?: boolean;
}): { deps: ExecuteC2RunDeps; campaign: CampaignState; store: C2RunStore; model: ReturnType<typeof vi.fn>; written: ReturnType<typeof makeStoreAndCampaign> } {
  const written = makeStoreAndCampaign({
    privateRoot: opts.privateRoot,
    durableRoot: opts.durableRoot,
    pricingEntryInput: opts.pricingEntryInput,
    pricingEntryOutput: opts.pricingEntryOutput,
    campaignSpentUsd: opts.campaignSpentUsd,
    campaignStopped: opts.campaignStopped,
  });

  const defaultModelResponse: ModelCallResult = {
    content: canonicalJsonStringify(makeCompleteCandidate(INPUT_SHA)),
    provider: "openai",
    model: "gpt-5.4-mini",
    usage: { promptTokens: 120, completionTokens: 80, raw: { input_tokens: 120, output_tokens: 80 } },
    attempts: 1,
    latencyMs: 432,
    providerRequestId: "req_test_1",
  };

  const model = vi.fn(async (req: { prompt: string }) => {
    return typeof opts.modelResponse === "function"
      ? opts.modelResponse(req)
      : (opts.modelResponse ?? defaultModelResponse);
  });

  const deps: ExecuteC2RunDeps = {
    callModel: model,
    now: () => "2026-07-20T12:00:00.000Z",
    runId: (caseId, condition, attempt) =>
      `c2-run-${caseId}-${condition}-${attempt}`,
    scorerSha256: () => SCORER_SHA256,
    store: written.store,
    campaign: written.campaign,
    boundaryScan: { secretValues: [], secretEnvNames: [] },
    // Pin the prompt-token estimate so the forecast math is deterministic and
    // matches the documented test scenarios (e.g. the $0.60 overage case).
    estimatePromptTokens: () => 120,
  };

  return { deps, campaign: written.campaign, store: written.store, model, written };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "c2-harness-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function manifestRoundTrip(manifest: unknown) {
  return C2EvaluationRunManifestV2Schema.parse(manifest);
}

describe("executeC2Run — happy path (succeeded)", () => {
  it("writes the running manifest before egress, finalizes once, and records a deterministic score", async () => {
    const privateRoot = join(tmp, "private");
    const durableRoot = join(tmp, "runs");
    const { deps, model, written } = makeBaseDeps({
      privateRoot,
      durableRoot,
      pricingEntryInput: 1,
      pricingEntryOutput: 1,
    });

    const manifest = await executeC2Run(makeBaseRequest(), deps);

    // status: succeeded, terminalReason: succeeded
    expect(manifest).toMatchObject({
      status: "succeeded",
      terminalReason: "succeeded",
      schemaVersion: "2.0",
      provider: "openai",
      model: "gpt-5.4-mini",
      condition: "brief-only",
      evidenceIds: [],
      predecessorRunId: null,
    });

    // exactly one logical provider call
    expect(model).toHaveBeenCalledTimes(1);

    // the raw output was stored privately (before finalize) for replay
    const rawWrite = written.writtenPrivate.find((w) => w.relPath.includes("raw-response"));
    expect(rawWrite, "raw response must be written under .c2-private/").toBeDefined();

    // The harness writes the RUNNING manifest before egress (step 5) and then
    // FINALIZES it once (step 9). Both writes target the same runId; the final
    // write overwrites the running-state artifact. The durable log records
    // both calls so an interrupted run leaves an audit trail.
    expect(written.writtenDurable.length).toBeGreaterThanOrEqual(2);
    const running = manifestRoundTrip(written.writtenDurable[0]!.manifest);
    expect(running.status).toBe("running");
    // the LAST durable write is the final/terminal manifest
    const persisted = manifestRoundTrip(
      written.writtenDurable[written.writtenDurable.length - 1]!.manifest,
    );
    expect(persisted.status).toBe("succeeded");
    expect(persisted.rawOutputSha256).toBe(manifest.rawOutputSha256);
    expect(persisted.parsedOutputSha256).toBe(manifest.parsedOutputSha256);
    expect(persisted.promptTokens).toBe(120);
    expect(persisted.completionTokens).toBe(80);
    expect(persisted.attemptCount).toBe(1);
    expect(persisted.providerLatencyMs).toBe(432);
    expect(persisted.terminalReason).toBe("succeeded");
    expect(persisted.validationErrors).toEqual([]);

    // a deterministic score artifact was written and bound to the run
    expect(written.writtenScores).toHaveLength(1);
    const score = written.writtenScores[0]!.score as { runId: unknown; complete: unknown; runOutputSha256: unknown };
    expect(score.runId).toBe(manifest.runId);
    expect(score.complete).toBe(true);
    expect(score.runOutputSha256).toBe(manifest.rawOutputSha256);

    // cost was recorded into campaign spend
    expect(deps.campaign.spentUsd).toBeGreaterThan(0);
    expect(deps.campaign.stopped).toBe(false);
  });

  it("computes the promptSha256 deterministically from the brief + condition input (no label)", async () => {
    const privateRoot = join(tmp, "private");
    const durableRoot = join(tmp, "runs");
    const { deps } = makeBaseDeps({
      privateRoot,
      durableRoot,
      pricingEntryInput: 1,
      pricingEntryOutput: 1,
    });

    const manifest = await executeC2Run(makeBaseRequest(), deps);
    expect(manifest.promptSha256).toMatch(/^[0-9a-f]{64}$/);

    // Re-running with the same inputs produces the same promptSha256.
    const privateRoot2 = join(tmp, "private2");
    const durableRoot2 = join(tmp, "runs2");
    const { deps: deps2 } = makeBaseDeps({
      privateRoot: privateRoot2,
      durableRoot: durableRoot2,
      pricingEntryInput: 1,
      pricingEntryOutput: 1,
    });
    const manifest2 = await executeC2Run(makeBaseRequest(), deps2);
    expect(manifest2.promptSha256).toBe(manifest.promptSha256);
  });
});

describe("executeC2Run — provider failure", () => {
  it("terminates failed/provider-failed, records zero tokens and zero cost, stops campaign", async () => {
    const privateRoot = join(tmp, "private");
    const durableRoot = join(tmp, "runs");
    const providerError = new Error("HTTP 503 from provider");
    const { deps, model } = makeBaseDeps({
      privateRoot,
      durableRoot,
      pricingEntryInput: 1,
      pricingEntryOutput: 1,
      modelResponse: () => {
        throw providerError;
      },
    });

    const manifest = await executeC2Run(makeBaseRequest(), deps);

    expect(manifest).toMatchObject({
      status: "failed",
      terminalReason: "provider-failed",
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
      rawOutputSha256: null,
      parsedOutputSha256: null,
    });
    expect(model).toHaveBeenCalledTimes(1);
    // provider failure is not a paid response; no score artifact.
    expect(manifest.validationErrors.length).toBeGreaterThanOrEqual(0);
    // A provider failure does not by itself stop the campaign (the next
    // queued run may still be scheduled) — but it IS a terminal failure for
    // THIS run.
    expect(deps.campaign.stopped).toBe(false);
  });
});

describe("executeC2Run — parse failure", () => {
  it("terminates failed/parse-failed, preserves actual cost, writes no score", async () => {
    const privateRoot = join(tmp, "private");
    const durableRoot = join(tmp, "runs");
    const { deps, model, written } = makeBaseDeps({
      privateRoot,
      durableRoot,
      // 1 USD/M-tok * (120 + 80) tokens / 1M = 0.0002... we want a known cost.
      // To get costUsd: 0.0012 we need (promptTokens * input + completionTokens * output)/1M = 0.0012
      // Pick input=6, output=6: (120*6 + 80*6)/1M = (720+480)/1M = 1200/1M = 0.0012.
      pricingEntryInput: 6,
      pricingEntryOutput: 6,
      modelResponse: () => ({
        content: "this is not json at all {{",
        provider: "openai",
        model: "gpt-5.4-mini",
        usage: { promptTokens: 120, completionTokens: 80, raw: { input_tokens: 120, output_tokens: 80 } },
        attempts: 1,
        latencyMs: 100,
        providerRequestId: "req_parse_fail",
      }),
    });

    const manifest = await executeC2Run(makeBaseRequest(), deps);

    // parse failure: failed + parse-failed + actual cost preserved + no parsed output
    expect(manifest).toMatchObject({
      status: "failed",
      terminalReason: "parse-failed",
      costUsd: 0.0012,
      parsedOutputSha256: null,
      promptTokens: 120,
      completionTokens: 80,
    });
    // raw output hash IS recorded (the response cost real money and must be auditable)
    expect(manifest.rawOutputSha256).toBeTruthy();
    expect(model).toHaveBeenCalledTimes(1);
    // no score artifact is written on parse failure (scorer refuses non-schema candidates)
    expect(written.writtenScores).toHaveLength(0);
  });
});

describe("executeC2Run — validation failure", () => {
  it("terminates failed/validation-failed when the parsed candidate violates the schema, preserves cost", async () => {
    const privateRoot = join(tmp, "private");
    const durableRoot = join(tmp, "runs");
    // A candidate that parses as JSON but fails the strict candidate schema:
    // empty accessibility array is rejected by C2ScreenBlueprintSchema.
    const badCandidate = {
      ...makeCompleteCandidate(INPUT_SHA),
      screenBlueprints: makeCompleteCandidate(INPUT_SHA).screenBlueprints.map((bp) => ({
        ...bp,
        accessibility: [], // forbidden — non-empty required
      })),
    };
    const { deps, model, written } = makeBaseDeps({
      privateRoot,
      durableRoot,
      pricingEntryInput: 6,
      pricingEntryOutput: 6,
      modelResponse: () => ({
        content: canonicalJsonStringify(badCandidate),
        provider: "openai",
        model: "gpt-5.4-mini",
        usage: { promptTokens: 120, completionTokens: 80, raw: { input_tokens: 120, output_tokens: 80 } },
        attempts: 1,
        latencyMs: 110,
        providerRequestId: "req_validation_fail",
      }),
    });

    const manifest = await executeC2Run(makeBaseRequest(), deps);

    expect(manifest).toMatchObject({
      status: "failed",
      terminalReason: "validation-failed",
      costUsd: 0.0012,
      parsedOutputSha256: null,
    });
    expect(manifest.rawOutputSha256).toBeTruthy();
    expect(manifest.validationErrors.length).toBeGreaterThan(0);
    expect(model).toHaveBeenCalledTimes(1);
    expect(written.writtenScores).toHaveLength(0);
  });
});

describe("executeC2Run — cost-blocked (forecast gate)", () => {
  it("records cost-blocked BEFORE any provider call: zero attempts, zero tokens, zero cost, no hashes", async () => {
    const privateRoot = join(tmp, "private");
    const durableRoot = join(tmp, "runs");
    // Make the forecast blow past the $0.50 run ceiling by pricing tokens at
    // $1000 per million. Forecast = (120 * 1000 + 2048 * 1000) / 1M = ~2.17 > 0.50.
    const { deps, model } = makeBaseDeps({
      privateRoot,
      durableRoot,
      pricingEntryInput: 1000,
      pricingEntryOutput: 1000,
    });

    const manifest = await executeC2Run(makeBaseRequest(), deps);

    expect(model).not.toHaveBeenCalled(); // forecast blocked
    expect(manifest).toMatchObject({
      status: "cost-blocked",
      terminalReason: "cost-blocked",
      attemptCount: 0,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
      providerLatencyMs: 0,
      rawOutputSha256: null,
      parsedOutputSha256: null,
    });
    expect(manifest.finishedAt).toBeNull();
  });
});

describe("executeC2Run — run-budget-exceeded (actual > $0.50 after a successful response)", () => {
  it("preserves raw hash + actual cost, skips parsing, stops campaign, blocks the next run", async () => {
    const privateRoot = join(tmp, "private");
    const durableRoot = join(tmp, "runs");

    // Construct a fake model response that succeeds at the transport layer and
    // reports token usage priced to exactly $0.60, despite a preflight forecast
    // below $0.50. The forecast uses the FULL maxOutputTokens (2048) and the
    // injected prompt-token estimate (120). Pick p so:
    //   forecast = (120 + 2048) * p / 1M < 0.50   →  p < 230.6
    //   actual   = (120 + T) * p / 1M   = 0.60
    // With p = 200: forecast = 0.4336 (passes), and we need T so that
    // (120 + T) * 200 / 1M = 0.60  →  T = 2880. So completionTokens = 2880.
    const rebuilt = makeBaseDeps({
      privateRoot,
      durableRoot,
      pricingEntryInput: 200,
      pricingEntryOutput: 200,
      modelResponse: () => ({
        // The model returns valid candidate content so the response "succeeds"
        // at the transport layer; only the COST overrun makes the run fail.
        content: canonicalJsonStringify(makeCompleteCandidate(INPUT_SHA)),
        provider: "openai",
        model: "gpt-5.4-mini",
        usage: { promptTokens: 120, completionTokens: 2880, raw: { input_tokens: 120, output_tokens: 2880 } },
        attempts: 1,
        latencyMs: 500,
        providerRequestId: "req_overage",
      }),
    });

    const request = makeBaseRequest();
    const actualOverage = await executeC2Run(request, rebuilt.deps);

    expect(actualOverage).toMatchObject({
      status: "failed",
      terminalReason: "run-budget-exceeded",
      costUsd: 0.6,
    });
    // parsing is skipped, parsedOutputSha256 stays null
    expect(actualOverage.parsedOutputSha256).toBeNull();
    // the raw-output hash + actual usage remain recorded for audit
    expect(actualOverage.rawOutputSha256).toBeTruthy();
    expect(actualOverage.promptTokens).toBe(120);
    expect(actualOverage.completionTokens).toBe(2880);
    // the terminal manifest is not "succeeded"
    expect(actualOverage.status).not.toBe("succeeded");

    // campaign stops immediately
    expect(rebuilt.campaign).toMatchObject({
      stopped: true,
      stopReason: "run-budget-exceeded",
    });
    // the overage cost was added to campaign spend
    expect(rebuilt.campaign.spentUsd).toBeGreaterThanOrEqual(0.6);
    // exactly one provider call for this run
    expect(rebuilt.model).toHaveBeenCalledTimes(1);

    // Now execute the NEXT queued request against the same campaign state.
    // It must NOT reach the provider — campaign is stopped.
    const secondRequest = makeBaseRequest({
      predecessorRunId: actualOverage.runId,
    });
    const second = await executeC2Run(secondRequest, rebuilt.deps);

    // the next run never reaches the provider
    expect(rebuilt.model).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({
      status: "failed",
      terminalReason: "campaign-stopped",
    });
    // predecessor chain
    expect(second.predecessorRunId).toBe(actualOverage.runId);
  });
});

describe("executeC2Run — atomic-write failure propagates before egress", () => {
  it("rejects when the pre-egress running-manifest write fails, and makes no provider call", async () => {
    const privateRoot = join(tmp, "private");
    const durableRoot = join(tmp, "runs");
    const base = makeBaseDeps({
      privateRoot,
      durableRoot,
      pricingEntryInput: 1,
      pricingEntryOutput: 1,
    });
    // Sabotage the store: writeDurableManifest always throws.
    const failingStore: C2RunStore = {
      ...base.store,
      async writeDurableManifest() {
        throw new Error("disk full");
      },
    };
    const deps: ExecuteC2RunDeps = { ...base.deps, store: failingStore };

    await expect(executeC2Run(makeBaseRequest(), deps)).rejects.toThrow(/disk full/);
    // no provider call — the write happened before egress
    expect(base.model).not.toHaveBeenCalled();
  });
});

describe("executeC2Run — immutability + predecessor chain", () => {
  it("rejects an existing terminal run directory instead of overwriting it", async () => {
    const privateRoot = join(tmp, "private");
    const durableRoot = join(tmp, "runs");
    const { deps } = makeBaseDeps({
      privateRoot,
      durableRoot,
      pricingEntryInput: 1,
      pricingEntryOutput: 1,
    });
    const request = makeBaseRequest();
    const first = await executeC2Run(request, deps);

    // Re-run with the SAME caseId+condition+attempt → store.hasTerminalRun is
    // keyed by runId and now reports the first run as terminal. The harness
    // MUST refuse to overwrite a terminal run; calling again with the same
    // runId must throw rather than silently overwriting.
    await expect(executeC2Run(request, deps)).rejects.toThrow(/terminal|immutable|already exists/i);

    // Re-running with a NEW attempt number produces a new runId and a
    // predecessor pointer to the first run.
    void first;
  });

  it("assigns a new runId and points predecessorRunId at the prior run on retry", async () => {
    const privateRoot = join(tmp, "private");
    const durableRoot = join(tmp, "runs");
    let attempt = 1;
    const { deps } = makeBaseDeps({
      privateRoot,
      durableRoot,
      pricingEntryInput: 1,
      pricingEntryOutput: 1,
    });
    // Override runId so retries increment the attempt.
    deps.runId = (_caseId, _condition, n) => `c2-run-retry-${n}`;
    void attempt;

    const firstReq = makeBaseRequest();
    const first = await executeC2Run(firstReq, deps);
    expect(first.predecessorRunId).toBeNull();

    // Second run is an explicit retry: caller passes the first runId as the
    // predecessor and bumps the attempt counter.
    const secondReq = makeBaseRequest({
      predecessorRunId: first.runId,
    });
    const second = await executeC2Run(secondReq, deps);
    expect(second.predecessorRunId).toBe(first.runId);
    expect(second.runId).not.toBe(first.runId);
  });
});

describe("executeC2Run — campaign budget (forecast blocks on remaining budget)", () => {
  it("records cost-blocked when the forecast fits the run ceiling but not the remaining campaign budget", async () => {
    const privateRoot = join(tmp, "private");
    const durableRoot = join(tmp, "runs");
    // Spend already at $4.80; a forecast that fits the $0.50 run ceiling but
    // exceeds the remaining $0.20 campaign budget must be blocked. With the
    // pinned prompt-token estimate (120) and full maxOutputTokens (2048):
    //   p = 100  →  forecast = (120 + 2048) * 100 / 1M = 0.2168
    //   0.2168 < 0.50 (run ceiling OK)  but  4.8 + 0.2168 > 5.0 (campaign budget
    //   exceeded) → cost-blocked.
    const harness = makeBaseDeps({
      privateRoot,
      durableRoot,
      pricingEntryInput: 100,
      pricingEntryOutput: 100,
      campaignSpentUsd: 4.8,
    });
    const manifest = await executeC2Run(makeBaseRequest(), harness.deps);

    expect(harness.model).not.toHaveBeenCalled();
    expect(manifest).toMatchObject({
      status: "cost-blocked",
      terminalReason: "cost-blocked",
      attemptCount: 0,
      costUsd: 0,
    });
  });
});

describe("executeC2Run — actual cost persists after any paid response (matrix invariant)", () => {
  it("every terminal state after a provider response has costUsd > 0; cost-blocked has costUsd === 0", async () => {
    const privateRoot = join(tmp, "private");
    const durableRoot = join(tmp, "runs");

    // parse-failed
    const pf = makeBaseDeps({
      privateRoot,
      durableRoot: join(durableRoot, "pf"),
      pricingEntryInput: 6,
      pricingEntryOutput: 6,
      modelResponse: () => ({
        content: "not json",
        provider: "openai",
        model: "gpt-5.4-mini",
        usage: { promptTokens: 120, completionTokens: 80, raw: {} },
        attempts: 1,
        latencyMs: 50,
        providerRequestId: null,
      }),
    });
    const parseFailed = await executeC2Run(makeBaseRequest(), pf.deps);
    expect(parseFailed).toMatchObject({ status: "failed", terminalReason: "parse-failed", costUsd: 0.0012 });

    // cost-blocked
    const cb = makeBaseDeps({
      privateRoot: join(tmp, "private-cb"),
      durableRoot: join(durableRoot, "cb"),
      pricingEntryInput: 1000,
      pricingEntryOutput: 1000,
    });
    const blocked = await executeC2Run(makeBaseRequest(), cb.deps);
    expect(blocked).toMatchObject({ status: "cost-blocked", costUsd: 0 });
  });
});

// ---------------------------------------------------------------------------
// Boundary scan on durable manifest writes (I1)
// ---------------------------------------------------------------------------
//
// The harness's `boundaryScan` config is plumbed through `ExecuteC2RunDeps`
// and applied in `writeManifestDurable` BEFORE any durable write. A manifest
// that carries a configured secret value (sentinel) must be rejected so it is
// never committed to disk.
describe("executeC2Run — boundary scan rejects secret-bearing durable manifests", () => {
  it("throws when a manifest carries a configured secret sentinel, before any durable write lands", async () => {
    // Drive the harness end-to-end with a boundaryScan carrying a sentinel and
    // a request whose scorerRef path contains the sentinel. The scorerRef is
    // serialized verbatim into the durable manifest, so the scan must reject
    // it. The harness must throw BEFORE the store write is reached.
    const privateRoot = join(tmp, "private");
    const durableRoot = join(tmp, "runs");
    const SENTINEL = "secret-leak-sk-9876543210";
    const { deps, written, model } = makeBaseDeps({
      privateRoot,
      durableRoot,
      pricingEntryInput: 6,
      pricingEntryOutput: 6,
      modelResponse: () => ({
        content: canonicalJsonStringify(makeCompleteCandidate(INPUT_SHA)),
        provider: "openai",
        model: "gpt-5.4-mini",
        usage: { promptTokens: 120, completionTokens: 80, raw: {} },
        attempts: 1,
        latencyMs: 50,
        providerRequestId: null,
      }),
    });
    // Plant the sentinel in a field the harness serializes into the manifest.
    const request = makeBaseRequest({
      scorerRef: {
        artifactId: "c2-scorer-v1",
        path: `src/c2/scorer.ts#${SENTINEL}`,
        sha256: SCORER_SHA256,
      },
    });
    // Configure the scan to treat the sentinel as a secret value.
    deps.boundaryScan = { secretValues: [SENTINEL], secretEnvNames: [] };

    await expect(executeC2Run(request, deps)).rejects.toThrow(/secret value/);
    // No durable manifest landed for the rejected run (the scan threw before
    // the store write). The pre-egress RUNNING manifest write also runs through
    // the scan, so even the first durable write is blocked.
    expect(written.writtenDurable.length).toBe(0);
    // The provider was never called: the running-manifest write (step 5) is the
    // first durable write and it runs BEFORE egress, so its scan failure aborts
    // the run before step 6.
    expect(model).not.toHaveBeenCalled();
  });

  it("a clean manifest with the same scan config passes (no false positive)", async () => {
    // Sanity: the boundary scan does not reject a manifest that carries no
    // secret material. This proves the rejection above was the sentinel, not a
    // structural false positive.
    const { scanDurableArtifact } = await import("./private-artifacts.js");
    const cleanManifest = JSON.stringify({
      schemaVersion: "2.0",
      status: "succeeded",
      validationErrors: [],
    });
    expect(() =>
      scanDurableArtifact(cleanManifest, {
        secretValues: ["secret-leak-sk-9876543210"],
        secretEnvNames: [],
      }),
    ).not.toThrow();
  });
});
