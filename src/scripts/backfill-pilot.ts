/**
 * Backfill model pilot — measure per-field accuracy of the extraction pass
 * across providers BEFORE spending a full run.
 *
 * The four fields this exists for are recorded on ~3% of the corpus:
 * components 23/787, mood 22/787, colorScheme 22/787, domainTags 14/787.
 * They drive 298 of the diagnosis run's 331 gates. Filling them is the largest
 * remaining lever, and it WRITES to the corpus — unlike everything in the
 * verification cycle, a wrong value here gets served.
 *
 * This script never writes the corpus. It calls tagImage() with
 * `extractionOnly` (Pass 1 only — Pass 2 prose is not needed for these four
 * fields and doubles per-image cost) and emits a scoring sheet for a human.
 *
 * Two of the four fields are CLOSED VOCABULARIES — components picks from 35
 * allowed values, domainTags from 15 — so `componentsFromAllowed` /
 * `domainTagsFromAllowed` silently drop anything invented.
 *
 * NOT MEASURED: the count of dropped invented tags. The vocabulary filter runs
 * inside the tagger, before this script sees raw output, so a model that
 * invents plausible-but-wrong component names is indistinguishable here from
 * one that found nothing. Measuring it needs a tagger-side hook. Recorded as
 * the known gap in docs/backfill-model-pilot.md — do not read a low count in
 * this sheet as "the model found little".
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, sep } from "node:path";
import { parseArgs } from "node:util";
import { tagImage } from "../tagger.js";
import type { Provider } from "../tagger.js";
import { loadEnv } from "../env.js";

loadEnv();

/**
 * Per-provider model env var. `EndpointOverride.model` is honored ONLY for
 * "openai" — every other provider rejects the full config triple outright
 * (the tagger throws rather than silently ignoring it), so the model has to be
 * set through the env var the provider's config function reads.
 *
 * The tagger warns that env-driven resolution races across concurrent
 * requests. That warning does not apply here: this script is a single process
 * running one arm, strictly sequentially, and exits before the next arm
 * starts. If it ever gains concurrency, this has to move back to an override.
 */
const MODEL_ENV_BY_PROVIDER: Readonly<Record<string, string>> = {
  openai: "OPENAI_AUTO_TAG_MODEL",
  claude: "CLAUDE_AUTO_TAG_MODEL",
  gemini: "GEMINI_AUTO_TAG_MODEL",
  minimax: "MINIMAX_AUTO_TAG_MODEL",
  mistral: "MISTRAL_AUTO_TAG_MODEL",
  grok: "XAI_AUTO_TAG_MODEL",
};

/**
 * The fields this pilot can actually measure — Pass 1 (vision extraction) only.
 *
 * `mood` is DELIBERATELY ABSENT. It is a Pass 2 (prose) field: the
 * `extractionOnly` return object never emits it (tagger.ts:3024-3070), so
 * scoring it here would report 0/N for every model and read as "no model can
 * do mood" when the truth is that no model was asked. Backfilling `mood` needs
 * a second call per image, and it is the one target field with no controlled
 * vocabulary and no ground truth to score against — it belongs in its own
 * exercise, judged reasonable/not rather than right/wrong.
 */
const TARGET_FIELDS = ["components", "colorScheme", "domainTags"] as const;

type PilotRow = {
  entryId: string;
  imagePath: string;
  provider: string;
  model: string;
  elapsedMs: number;
  error?: string;
  components?: string[];
  mood?: string;
  colorScheme?: string;
  domainTags?: string[];
};

function missingTargets(entry: Record<string, unknown>): boolean {
  return TARGET_FIELDS.some((f) => {
    const v = entry[f];
    if (v === undefined || v === null) return true;
    if (Array.isArray(v) && v.length === 0) return true;
    return false;
  });
}

/**
 * Deterministic sample: entries missing at least one target field, in corpus
 * order, taking every Nth so the sample spans the corpus rather than clustering
 * on whichever products happen to sit at the front. The diagnosis cohort was
 * bitten by exactly that — its first-50-by-order set turned out not to be the
 * set anyone thought it was.
 */
function pickSample(entries: Array<Record<string, unknown>>, size: number): Array<Record<string, unknown>> {
  const eligible = entries.filter((e) => missingTargets(e) && (e.image as { path?: string })?.path);
  if (eligible.length <= size) return eligible;
  const stride = Math.floor(eligible.length / size);
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; out.length < size && i < eligible.length; i += stride) out.push(eligible[i]);
  return out.slice(0, size);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      provider: { type: "string" },
      model: { type: "string" },
      limit: { type: "string", default: "25" },
      out: { type: "string" },
      "sample-file": { type: "string" },
    },
  });

  const provider = values.provider;
  if (!provider) throw new Error("--provider is required (minimax | gemini | claude | openai | grok)");
  const limit = Number(values.limit) || 25;
  const outDir = values.out ?? "eval/backfill-pilot";

  // "This script never writes the corpus" is an absolute claim in the header and
  // in docs/backfill-model-pilot.md. `--out` is the only thing that could
  // falsify it, so it is enforced rather than asserted — the project standard is
  // that a quality constraint refuses at runtime instead of being documented.
  const corpusRoot = resolve("corpus");
  const resolvedOut = resolve(outDir);
  if (resolvedOut === corpusRoot || resolvedOut.startsWith(corpusRoot + sep)) {
    throw new Error(`--out must not point inside corpus/ (got ${resolvedOut}); this script never writes the corpus`);
  }

  // Pin the model before any call. Fail loudly on an unknown provider rather
  // than silently running the arm on a default model and labelling the output
  // with the model the user asked for.
  if (values.model) {
    const envVar = MODEL_ENV_BY_PROVIDER[provider];
    if (!envVar) {
      throw new Error(`--model given but provider "${provider}" has no known model env var`);
    }
    process.env[envVar] = values.model;
  }

  const corpus = JSON.parse(readFileSync(resolve("corpus/entries.json"), "utf8"));
  const entries: Array<Record<string, unknown>> = corpus.entries ?? corpus;

  // The sample is PINNED to a file on first run and reused after, so every arm
  // scores the same images. A per-arm sample would make the comparison
  // meaningless while looking perfectly reasonable in the output.
  const sampleFile = values["sample-file"] ?? `${outDir}/sample-ids.txt`;
  let sample: Array<Record<string, unknown>>;
  try {
    const ids = readFileSync(resolve(sampleFile), "utf8").trim().split("\n").filter(Boolean);
    const byId = new Map(entries.map((e) => [e.id as string, e]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length > 0) throw new Error(`sample file names unknown ids: ${missing.join(", ")}`);
    sample = ids.map((id) => byId.get(id) as Record<string, unknown>);
    console.error(`reusing pinned sample: ${sample.length} entries from ${sampleFile}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    sample = pickSample(entries, limit);
    mkdirSync(dirname(resolve(sampleFile)), { recursive: true });
    writeFileSync(resolve(sampleFile), sample.map((e) => e.id).join("\n") + "\n");
    console.error(`pinned a new sample of ${sample.length} to ${sampleFile}`);
  }

  const rows: PilotRow[] = [];
  for (const [i, entry] of sample.entries()) {
    const imagePath = `corpus/${(entry.image as { path: string }).path}`;
    const started = Date.now();
    try {
      const out = await tagImage({
        imagePath: resolve(imagePath),
        // The real productName, not a placeholder: it reaches the extraction
        // prompt, so substituting one would measure a prompt no production run
        // will ever send.
        productName: ((entry.source as { productName?: string } | undefined)?.productName
          ?? (entry.title as string | undefined)
          ?? (entry.id as string)),
        extractionOnly: true,
        extractionProvider: provider as Provider,
        imageDetail: "low",
      });
      rows.push({
        entryId: entry.id as string,
        imagePath,
        provider,
        model: values.model ?? "(provider default)",
        elapsedMs: Date.now() - started,
        components: out.components,
        mood: out.mood,
        colorScheme: out.colorScheme,
        domainTags: out.domainTags,
      });
      console.error(`  [${i + 1}/${sample.length}] ${entry.id} ok (${Date.now() - started}ms)`);
    } catch (err) {
      // Per-image catch: one provider hiccup must not abort the arm and leave a
      // partial sheet with no verdict — the same rule the element-box probe
      // learned the hard way.
      rows.push({
        entryId: entry.id as string,
        imagePath,
        provider,
        model: values.model ?? "(provider default)",
        elapsedMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      });
      console.error(`  [${i + 1}/${sample.length}] ${entry.id} FAILED: ${err instanceof Error ? err.message : err}`);
    }
  }

  mkdirSync(resolve(outDir), { recursive: true });
  const tag = `${provider}${values.model ? `-${values.model.replace(/[^a-zA-Z0-9.-]/g, "_")}` : ""}`;
  const jsonPath = resolve(outDir, `${tag}.jsonl`);
  writeFileSync(jsonPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

  const ok = rows.filter((r) => !r.error);
  const failed = rows.length - ok.length;
  const filled = (f: keyof PilotRow): number =>
    ok.filter((r) => {
      const v = r[f];
      return v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0) && v !== "";
    }).length;

  console.log(`\n=== ${tag} — ${ok.length}/${rows.length} succeeded${failed ? `, ${failed} FAILED` : ""} ===`);
  console.log(`median latency: ${median(ok.map((r) => r.elapsedMs))}ms`);
  console.log("\nNON-EMPTY counts (presence, NOT correctness — score by hand below):");
  for (const f of TARGET_FIELDS) {
    console.log(`  ${f.padEnd(14)} ${filled(f)}/${ok.length}`);
  }
  console.log(`\nwrote ${jsonPath}`);
  console.log(
    "\nPRESENCE IS NOT ACCURACY. These counts say a value exists, not that it is\n" +
    "right — the exact failure the project standard names. Open the scoring\n" +
    "sheet and check the values against the screenshots before believing any\n" +
    "of this.",
  );
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
