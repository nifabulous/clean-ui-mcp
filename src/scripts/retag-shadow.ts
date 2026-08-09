#!/usr/bin/env node
/**
 * Non-mutating shadow retag.
 *
 * This command deliberately has no persistence import and no corpus write
 * path. It freezes a sample, records the inputs/model identity, writes raw
 * candidates, and reports field-level changes with explicit presence
 * denominators. A later promotion tool may consume these artifacts, but this
 * command can never promote them itself.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { loadEnv } from "../env.js";
import { loadCorpus } from "../corpus.js";
import { tagImage, type Provider, type TaggerOutput } from "../tagger.js";
import { canonicalHash, pickStratifiedSample, compareEntry, summarize, type EntryComparison, type RetagEntryLike } from "../retag-diff.js";
import { assertGoldBindings, evaluateGold, type GoldLabel } from "../retag-eval.js";
import { RetagGoldSubmissionSchema, toGoldLabels } from "../retag-gold.js";

loadEnv();

const MODEL_ENV_BY_PROVIDER: Readonly<Record<string, string>> = {
  openai: "OPENAI_AUTO_TAG_MODEL",
  claude: "CLAUDE_AUTO_TAG_MODEL",
  gemini: "GEMINI_AUTO_TAG_MODEL",
  minimax: "MINIMAX_AUTO_TAG_MODEL",
  mistral: "MISTRAL_AUTO_TAG_MODEL",
  grok: "XAI_AUTO_TAG_MODEL",
};

type CandidateRow = {
  entryId: string;
  baselineHash: string;
  imageSha256: string;
  candidate?: TaggerOutput;
  candidateHash?: string;
  error?: string;
  elapsedMs: number;
};

function hashBytes(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function gitSha(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

function parseSampleIds(path: string, entries: RetagEntryLike[]): RetagEntryLike[] {
  const ids = readFileSync(resolve(path), "utf8").split(/\r?\n/).map((id) => id.trim()).filter(Boolean);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) throw new Error(`sample file names unknown entry ids: ${missing.join(", ")}`);
  return ids.map((id) => byId.get(id)!).filter(Boolean);
}

function parseProvider(value: string): Provider {
  const allowed = ["openai", "claude", "gemini", "minimax", "mistral", "grok"];
  if (!allowed.includes(value)) throw new Error(`--provider must be one of ${allowed.join(", ")}`);
  return value as Provider;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      provider: { type: "string" },
      model: { type: "string" },
      limit: { type: "string", default: "50" },
      out: { type: "string", default: "eval/retag-runs" },
      "sample-file": { type: "string" },
      "run-id": { type: "string" },
      gold: { type: "string" },
    },
  });
  if (!values.provider) throw new Error("--provider is required");
  const provider = parseProvider(values.provider);
  const corpusPath = resolve("corpus/entries.json");
  const corpusBytes = readFileSync(corpusPath);
  const allEntries = loadCorpus() as unknown as RetagEntryLike[];
  const eligible = allEntries.filter((entry) => {
    const imagePath = (entry.image as { path?: string | null } | undefined)?.path;
    return typeof imagePath === "string" && existsSync(resolve("corpus", imagePath));
  });
  const limit = Math.max(1, Number(values.limit) || 50);
  const samplePath = values["sample-file"];
  const sample = samplePath
    ? parseSampleIds(samplePath, eligible)
    : pickStratifiedSample(eligible, limit, "clean-ui-retag-v1");
  if (sample.length === 0) throw new Error("no eligible entries with readable images");

  if (values.model) {
    const envVar = MODEL_ENV_BY_PROVIDER[provider];
    if (!envVar) throw new Error(`no model environment variable known for provider ${provider}`);
    process.env[envVar] = values.model;
  }

  const runId = values["run-id"] ?? `shadow-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
  const rootOut = resolve(values.out);
  const outDir = resolve(rootOut, runId);
  if (outDir === resolve("corpus") || outDir.startsWith(resolve("corpus") + sep)) {
    throw new Error(`--out must not point inside corpus/ (got ${outDir})`);
  }
  if (existsSync(outDir)) throw new Error(`run directory already exists: ${outDir}; runs are immutable`);
  mkdirSync(outDir, { recursive: true });
  const sourceSha = hashBytes(readFileSync(resolve("src/tagger.ts")));
  const manifest = {
    schemaVersion: "1.0",
    runId,
    kind: "retag-shadow",
    status: "running",
    startedAt: new Date().toISOString(),
    gitSha: gitSha(),
    corpusSha256: hashBytes(corpusBytes),
    corpusPath: "corpus/entries.json",
    taggerSourceSha256: sourceSha,
    provider,
    model: values.model ?? "provider-default",
    extractionOnly: true,
    fields: ["patternType", "categories", "styleTags", "components", "domainTags", "colorScheme", "layout", "visual.typePairing", "mood"],
    gold: values.gold ? {
      path: values.gold,
      sha256: hashBytes(readFileSync(resolve(String(values.gold)))),
    } : null,
    sample: sample.map((entry) => ({
      entryId: entry.id,
      baselineHash: canonicalHash(entry),
      imageSha256: hashBytes(readFileSync(resolve("corpus", (entry.image as { path: string }).path))),
    })),
  };
  writeFileSync(resolve(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  const rows: CandidateRow[] = [];
  for (const [index, entry] of sample.entries()) {
    const imagePath = resolve("corpus", (entry.image as { path: string }).path);
    const started = Date.now();
    try {
      const candidate = await tagImage({
        id: entry.id,
        imagePath,
        productName: entry.source?.productName ?? (typeof entry.title === "string" ? entry.title : undefined) ?? entry.id ?? "Untitled",
        extractionOnly: true,
        extractionProvider: provider,
        imageDetail: "high",
      });
      rows.push({
        entryId: entry.id!,
        baselineHash: canonicalHash(entry),
        imageSha256: hashBytes(readFileSync(imagePath)),
        candidate,
        candidateHash: canonicalHash(candidate),
        elapsedMs: Date.now() - started,
      });
      console.error(`[${index + 1}/${sample.length}] ${entry.id} ok`);
    } catch (error) {
      rows.push({
        entryId: entry.id!,
        baselineHash: canonicalHash(entry),
        imageSha256: hashBytes(readFileSync(imagePath)),
        error: error instanceof Error ? error.message : String(error),
        elapsedMs: Date.now() - started,
      });
      console.error(`[${index + 1}/${sample.length}] ${entry.id} failed`);
    }
  }

  const byId = new Map(sample.map((entry) => [entry.id, entry]));
  const comparisons: EntryComparison[] = rows
    .filter((row): row is CandidateRow & { candidate: TaggerOutput } => row.candidate !== undefined)
    .map((row) => compareEntry(byId.get(row.entryId)!, row.candidate as unknown as RetagEntryLike));
  const failed = rows.filter((row) => row.error).length;
  let goldEvaluation: ReturnType<typeof evaluateGold> | undefined;
  if (values.gold) {
    const goldPath = resolve(String(values.gold));
    const parsed = JSON.parse(readFileSync(goldPath, "utf8")) as unknown;
    const labels: GoldLabel[] = Array.isArray(parsed)
      ? parsed as GoldLabel[]
      : toGoldLabels(RetagGoldSubmissionSchema.parse(parsed));
    const imageHashes = new Map(allEntries.map((entry) => {
      const imagePath = (entry.image as { path?: string | null } | undefined)?.path;
      if (typeof imagePath !== "string") throw new Error(`gold binding cannot hash entry ${entry.id ?? "<unknown>"}: image path is missing`);
      return [entry.id, hashBytes(readFileSync(resolve("corpus", imagePath)))] as const;
    }));
    assertGoldBindings(labels, allEntries, (entry) => {
      const hash = imageHashes.get(entry.id);
      if (!hash) throw new Error(`gold binding cannot hash entry ${entry.id ?? "<unknown>"}`);
      return hash;
    });
    const predictions = rows
      .filter((row): row is CandidateRow & { candidate: TaggerOutput } => row.candidate !== undefined)
      .map((row) => row.candidate as unknown as RetagEntryLike);
    goldEvaluation = evaluateGold(labels, predictions);
  }
  writeFileSync(resolve(outDir, "candidates.json"), JSON.stringify(rows, null, 2) + "\n");
  writeFileSync(resolve(outDir, "diffs.json"), JSON.stringify(comparisons, null, 2) + "\n");
  writeFileSync(resolve(outDir, "scores.json"), JSON.stringify({
    schemaVersion: "1.0",
    runId,
    sampled: sample.length,
    succeeded: rows.length - failed,
    failed,
    summary: summarize(comparisons),
    ...(goldEvaluation ? { gold: goldEvaluation } : {}),
  }, null, 2) + "\n");
  writeFileSync(resolve(outDir, "manifest.json"), JSON.stringify({
    ...manifest,
    status: failed === rows.length ? "failed" : "succeeded",
    finishedAt: new Date().toISOString(),
    succeeded: rows.length - failed,
    failed,
  }, null, 2) + "\n");
  console.log(`wrote immutable shadow run ${outDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
