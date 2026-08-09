/**
 * clear-unverified-cli.ts — CLI for clearing a gated field where it is unverified.
 *
 * Defaults to `--dry-run`: writing requires an explicit `--write`, because this
 * mutates values that are currently served. See `src/clear-unverified.ts` for why
 * the operation exists and why it refuses non-gated fields.
 *
 * Usage:
 *   npm run clear-unverified -- --field visual.usesShadows            # dry run
 *   npm run clear-unverified -- --field visual.usesShadows --write    # writes
 *
 * After a write, `corpus/embeddings.json` is stale for every cleared entry whose
 * embedding text mentions the field (`embeddings.ts` interpolates usesShadows), so
 * the run prints the rebuild command rather than leaving that to be discovered.
 */
import { parseArgs } from "node:util";
import { loadCorpus } from "../corpus.js";
import { persistEntries, writableLoadedCorpus } from "../persistence.js";
import { clearUnverified } from "../clear-unverified.js";
import { GATED_FIELDS } from "../corpus-trust.js";

function main(): void {
  const { values } = parseArgs({
    options: {
      field: { type: "string" },
      write: { type: "boolean", default: false },
      "show-ids": { type: "boolean", default: false },
    },
  });

  const field = values.field;
  if (!field) {
    console.error(`--field is required. Gated fields: ${[...GATED_FIELDS].sort().join(", ")}`);
    process.exit(1);
  }

  // `writableLoadedCorpus` is the explicit opt-in to writing the primary, the same
  // one verify-corpus uses. It makes the write intent structural rather than a
  // side effect of having loaded the corpus.
  const entries = loadCorpus();
  const report = clearUnverified(entries, field);

  console.log(`\nField: ${report.field}`);
  console.log(`  entries              : ${entries.length}`);
  console.log(`  would clear          : ${report.cleared}`);
  console.log(`  keep (verified)      : ${report.kept}`);
  console.log(`  already absent       : ${report.alreadyAbsent}`);

  if (report.keptIds.length > 0) {
    const byMethod = report.keptIds.reduce<Record<string, number>>((acc, k) => {
      acc[k.method] = (acc[k.method] ?? 0) + 1;
      return acc;
    }, {});
    console.log(`  kept by method       : ${Object.entries(byMethod).map(([m, n]) => `${m}=${n}`).join(", ")}`);
  }
  if (values["show-ids"]) {
    console.log(`\n  cleared ids:\n${report.clearedIds.map((id) => `    - ${id}`).join("\n")}`);
    console.log(`\n  kept ids:\n${report.keptIds.map((k) => `    - ${k.id} (${k.method})`).join("\n")}`);
  }

  if (!values.write) {
    console.log(`\n  DRY RUN — nothing written. Re-run with --write to apply.\n`);
    return;
  }

  if (report.cleared === 0) {
    console.log(`\n  Nothing to clear. Corpus untouched.\n`);
    return;
  }

  persistEntries(writableLoadedCorpus(report.entries), report.entries);
  console.log(`\n  ✅ Cleared ${report.cleared} value(s) of ${report.field}.`);
  console.log(`     ${report.kept} entries kept their value on real evidence.`);
  console.log(`\n  corpus/embeddings.json is now STALE for the cleared entries.`);
  console.log(`  Rebuild it before relying on semantic search:\n`);
  console.log(`      npm run build-index\n`);
}

main();
