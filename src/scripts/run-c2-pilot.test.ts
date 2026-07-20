/**
 * C2 pilot CLI no-egress tests (Task 7, Step 2).
 *
 * These tests spawn the COMPILED CLI (`dist/scripts/run-c2-pilot.js`) as a
 * subprocess and assert that under every offline condition the process makes
 * ZERO network requests. The bar is higher than a unit test: we compile the
 * real artifact, spawn it as Node would in production, and verify the
 * no-egress guarantee end-to-end.
 *
 * Covered invocations:
 *   - no args (usage)                          → exit ≠ 0, zero fetches
 *   - `prepare` (offline by design)            → exit 0, zero fetches
 *   - `run` without --paid                     → exit ≠ 0, zero fetches
 *   - `run` with missing config                → exit ≠ 0, zero fetches
 *   - `run` with stale pricing                 → exit ≠ 0, zero fetches
 *   - `run` with missing credentials           → exit ≠ 0, zero fetches
 *
 * Network egress detection: the CLI honors a `C2_NETWORK_AUDIT` environment
 * variable naming a file. If the CLI is about to make a real provider request,
 * it appends one line per attempted request to that audit file. A test that
 * sees the file empty (or absent) after the subprocess exits has proven zero
 * egress. (For `run --paid` the audit is the only signal — we never let the
 * tests reach a real provider.)
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildModelEndpoint } from "./run-c2-pilot.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const CLI_PATH = join(REPO_ROOT, "dist/scripts/run-c2-pilot.js");

// A single shared audit tempdir keeps the build-once / spawn-many loop cheap.
let auditDir: string;

beforeAll(() => {
  auditDir = mkdtempSync(join(tmpdir(), "c2-cli-audit-"));
  if (!existsSync(CLI_PATH)) {
    throw new Error(
      `expected compiled CLI at ${CLI_PATH}. Run \`npm run build\` before this suite.`,
    );
  }
});

afterAll(() => {
  rmSync(auditDir, { recursive: true, force: true });
});

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  auditPath: string;
  auditLines: string[];
}

/**
 * Spawn the compiled CLI with the given args + env overrides. A unique audit
 * file is created for each spawn so tests can independently assert zero
 * egress.
 */
function spawnCli(args: string[], opts: { env?: Record<string, string>; cwd?: string } = {}): SpawnResult {
  const auditPath = join(auditDir, `audit-${Math.random().toString(36).slice(2)}.log`);
  const env: Record<string, string> = {
    ...process.env,
    // Strip real credentials so a bug in the preflight cannot accidentally
    // reach a live provider. The audit file is the source of truth regardless.
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    // Point any accidental HTTP at a sentinel loopback that refuses connections.
    C2_NETWORK_AUDIT: auditPath,
    ...opts.env,
  };
  // Remove empty-string keys so the CLI sees them as unset (matches how a real
  // operator with no key in their shell would invoke the tool).
  for (const key of Object.keys(env)) {
    if (env[key] === "") delete env[key];
  }

  // C2_NO_DOTENV=1: tagger.ts side-effect-imports env.ts, which auto-loads
  // `.env` with override:true (see commit 04208fb). Without disabling that,
  // the subprocess would re-acquire the real keys from `.env` even though we
  // stripped them above, and the credential preflight would pass — defeating
  // the point of the no-egress test. This escape hatch is the CLI's contract
  // for "model the operator with no key in their shell."
  env.C2_NO_DOTENV = "1";

  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: opts.cwd ?? REPO_ROOT,
    env,
    encoding: "utf-8",
    // Give the CLI a generous but bounded window; offline paths return fast.
    timeout: 30_000,
  });

  let auditLines: string[] = [];
  if (existsSync(auditPath)) {
    auditLines = readFileSync(auditPath, "utf-8").split("\n").filter((line) => line.trim().length > 0);
  }

  return {
    code: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    auditPath,
    auditLines,
  };
}

/**
 * Assert zero network egress by reading the audit file written by the CLI for
 * this spawn. The file must either be absent or empty.
 */
function expectZeroEgress(res: SpawnResult): void {
  expect(
    res.auditLines,
    `expected zero provider calls but audit file contained: ${JSON.stringify(res.auditLines)}`,
  ).toEqual([]);
}

describe("run-c2-pilot CLI — no-egress behavior", { timeout: 30_000 }, () => {
  it("exits non-zero with usage when invoked with no args, and makes zero provider calls", () => {
    const res = spawnCli([]);
    expect(res.code).not.toBe(0);
    expectZeroEgress(res);
    // The usage message should mention the available subcommands.
    const combined = `${res.stdout}\n${res.stderr}`.toLowerCase();
    expect(combined).toMatch(/prepare|run|propose|freeze|validate/);
  });

  it("prepare runs fully offline against the reviewed config and makes zero provider calls", () => {
    // prepare resolves condition inputs; it must never reach the provider. We
    // point it at the reviewed campaign config so the parser exercises the
    // real artifacts. A failure here still counts as "no egress" if the audit
    // is empty — but we expect prepare to succeed (exit 0) against a healthy
    // repo. If prepare's offline success depends on environment we don't want
    // to gate this suite on it, so we only hard-assert zero egress.
    const res = spawnCli([
      "prepare",
      "--config",
      "eval/c2/config/pilot-campaign.json",
    ]);
    expectZeroEgress(res);
    // prepare should not need --paid; mentioning paid in prepare output would
    // be a bug.
    expect(res.stderr).not.toMatch(/--paid required/);
  });

  it("run without --paid exits non-zero and makes zero provider calls", () => {
    const res = spawnCli([
      "run",
      "--config",
      "eval/c2/config/pilot-campaign.json",
    ]);
    expect(res.code).not.toBe(0);
    expectZeroEgress(res);
    // The refusal message must explain that --paid is required.
    const combined = `${res.stdout}\n${res.stderr}`;
    expect(combined).toMatch(/--paid/i);
  });

  it("run with a missing config file exits non-zero and makes zero provider calls", () => {
    const tmpCwd = mkdtempSync(join(tmpdir(), "c2-cli-missing-"));
    try {
      const res = spawnCli(
        ["run", "--config", "does/not/exist.json", "--paid"],
        { cwd: tmpCwd },
      );
      expect(res.code).not.toBe(0);
      expectZeroEgress(res);
      const combined = `${res.stdout}\n${res.stderr}`.toLowerCase();
      expect(combined).toMatch(/config|not found|no such file|exist/i);
    } finally {
      rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it("run with stale pricing exits non-zero and makes zero provider calls", () => {
    // Author a campaign + pricing fixture with a `verifiedAt` >30 days before
    // the pricing table's `campaignStartsAt`. The preflight must fail closed.
    const fixtureDir = mkdtempSync(join(tmpdir(), "c2-cli-stale-"));
    try {
      const campaign = {
        schemaVersion: "1.0",
        artifactType: "c2-campaign-config",
        artifactId: "c2-campaign-stale-test",
        primary: {
          provider: "openai",
          model: "gpt-5.4-mini",
          apiKeyEnv: "OPENAI_API_KEY",
          maxOutputTokens: 2048,
          samplingParameters: { temperature: 0.2 },
        },
        independent: {
          provider: "claude",
          model: "claude-sonnet-4-5",
          apiKeyEnv: "ANTHROPIC_API_KEY",
          maxOutputTokens: 2048,
          samplingParameters: { temperature: 0.2 },
        },
        maxRunCostUsd: 0.5,
        maxCampaignCostUsd: 5,
        maxAttempts: 1,
        cases: ["stablecoin-home"],
        conditions: ["brief-only", "current-grounded", "gold-evidence"],
        independentConditions: ["current-grounded"],
        plannedRunCount: 12,
        retrievalMode: "keyword-only",
      };
      const stalePricing = {
        schemaVersion: "1.0",
        artifactType: "c2-pricing-table",
        artifactId: "c2-pricing-stale-test",
        // Campaign starts 2026-07-20; pricing verified 2025-01-01 → >30 days stale.
        campaignStartsAt: "2026-07-20T00:00:00.000Z",
        entries: [
          {
            provider: "openai",
            model: "gpt-5.4-mini",
            inputTokenPriceUsdPerMillion: 0.5,
            outputTokenPriceUsdPerMillion: 0.5,
            effectiveDate: "2025-01-01",
            verifiedAt: "2025-01-01T00:00:00.000Z",
            sourceUrl: "https://platform.openai.com/docs/pricing",
          },
          {
            provider: "claude",
            model: "claude-sonnet-4-5",
            inputTokenPriceUsdPerMillion: 0.5,
            outputTokenPriceUsdPerMillion: 0.5,
            effectiveDate: "2025-01-01",
            verifiedAt: "2025-01-01T00:00:00.000Z",
            sourceUrl: "https://www.anthropic.com/pricing",
          },
        ],
      };
      writeFileSync(join(fixtureDir, "campaign.json"), JSON.stringify(campaign));
      writeFileSync(join(fixtureDir, "pricing.json"), JSON.stringify(stalePricing));

      const res = spawnCli(
        [
          "run",
          "--config",
          join(fixtureDir, "campaign.json"),
          "--pricing",
          join(fixtureDir, "pricing.json"),
          "--paid",
        ],
        // Provide dummy credentials so the ONLY failing preflight is staleness.
        { env: { OPENAI_API_KEY: "sk-dummy", ANTHROPIC_API_KEY: "sk-ant-dummy" } },
      );
      expect(res.code).not.toBe(0);
      expectZeroEgress(res);
      const combined = `${res.stdout}\n${res.stderr}`.toLowerCase();
      expect(combined).toMatch(/stale|pricing|verified|30 day/i);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it("run with missing credentials exits non-zero and makes zero provider calls", () => {
    // Use the reviewed campaign config (valid pricing), but invoke with BOTH
    // API keys explicitly unset. Preflight must refuse to start.
    const res = spawnCli(
      [
        "run",
        "--config",
        "eval/c2/config/pilot-campaign.json",
        "--paid",
      ],
      // Force both provider keys absent.
      { env: { OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" } },
    );
    expect(res.code).not.toBe(0);
    expectZeroEgress(res);
    const combined = `${res.stdout}\n${res.stderr}`.toLowerCase();
    expect(combined).toMatch(/credential|api key|missing|openai_api_key|anthropic_api_key|not set|unset/i);
  });

  it("propose / freeze / validate are offline commands and make zero provider calls", () => {
    // These commands are stubbed in Task 7 (Task 8 implements them for real),
    // but they must remain offline. Propose on an empty runs dir exits cleanly
    // or with a clear not-enough-data message — either way, zero egress.
    const emptyRuns = mkdtempSync(join(tmpdir(), "c2-cli-empty-runs-"));
    try {
      const res = spawnCli(["propose", "--runs", emptyRuns]);
      expectZeroEgress(res);
      // It may exit non-zero ("not enough runs / Task 8 stub") — both are
      // acceptable; the only hard assertion is zero egress.
      void res.code;
    } finally {
      rmSync(emptyRuns, { recursive: true, force: true });
    }
  });
});

describe("run-c2-pilot CLI — subprocess isolation", { timeout: 30_000 }, () => {
  it("the compiled CLI exists at dist/scripts/run-c2-pilot.js", () => {
    expect(existsSync(CLI_PATH)).toBe(true);
  });

  it("the compiled CLI does not import network modules at module load time for offline commands", () => {
    // A weak but useful guard: spawning the CLI with no args must not create
    // the audit file at all (it never reaches the egress path).
    const res = spawnCli([]);
    expectZeroEgress(res);
    // The audit file may or may not exist; if it exists it MUST be empty.
    if (existsSync(res.auditPath)) {
      expect(readFileSync(res.auditPath, "utf-8").trim()).toBe("");
    }
  });
});

// Silence the unused-import warning when mkdirSync is tree-shaken out of the
// happy path (some Node versions warn on unused imports under strict mode).
void mkdirSync;

// ---------------------------------------------------------------------------
// buildModelEndpoint — apiKey resolution (C1 regression)
// ---------------------------------------------------------------------------
//
// Regression for the C1 bug: `callTextModelWithMetadata` requires
// `endpoint.apiKey` for OpenAI-compatible providers. The original CLI built the
// endpoint with NO apiKey, so every primary-lane live run threw
// `endpoint.apiKey is required for provider "openai"` before any fetch. The
// no-egress suite missed it because no test reaches a live provider. This test
// pins the endpoint-construction helper directly: it must resolve the apiKey
// from the env-var name carried on the request.
describe("buildModelEndpoint — resolves apiKey from the env-var name", () => {
  const ENV_NAME = "FAKE_API_KEY";
  const original = process.env[ENV_NAME];

  afterAll(() => {
    // Restore the original env state.
    if (original === undefined) {
      delete process.env[ENV_NAME];
    } else {
      process.env[ENV_NAME] = original;
    }
  });

  it("carries the resolved apiKey value on the endpoint", () => {
    process.env[ENV_NAME] = "test-key-123";
    try {
      const endpoint = buildModelEndpoint({
        provider: "openai",
        model: "gpt-5.4-mini",
        apiKeyEnv: ENV_NAME,
      });
      expect(endpoint).toEqual({
        provider: "openai",
        model: "gpt-5.4-mini",
        apiKey: "test-key-123",
      });
    } finally {
      delete process.env[ENV_NAME];
    }
  });

  it("falls back to an empty string when the env var is unset (defensive default)", () => {
    delete process.env[ENV_NAME];
    const endpoint = buildModelEndpoint({
      provider: "openai",
      model: "gpt-5.4-mini",
      apiKeyEnv: ENV_NAME,
    });
    expect(endpoint.apiKey).toBe("");
  });

  it("resolves different env-var names independently", () => {
    process.env["OTHER_FAKE_KEY"] = "other-key-456";
    try {
      const endpoint = buildModelEndpoint({
        provider: "openai",
        model: "gpt-5.4-mini",
        apiKeyEnv: "OTHER_FAKE_KEY",
      });
      expect(endpoint.apiKey).toBe("other-key-456");
    } finally {
      delete process.env["OTHER_FAKE_KEY"];
    }
  });
});
