/**
 * Merge the per-arm pilot output into the one file that gets committed.
 *
 * The per-arm `<provider>-<model>.jsonl` files carry `imagePath` values pointing
 * into `corpus/images-private/`, which has never entered git — so they stay
 * gitignored. This replaces that field with the image's sha256 and keeps every
 * other measured value, matching the element-box probe's convention of keying
 * evidence by `entryId` + `imageSha256` and never by a private path.
 *
 * This script exists because the merge was originally done with a throwaway
 * shell heredoc. A committed evidence file whose generator lives only in a
 * terminal scrollback is the same defect the abstain diagnosis already had to
 * correct once: the recovery path is dead the moment the session ends.
 *
 *   node eval/backfill-pilot/merge-results.mjs
 *
 * Run from the repo root. Rewrites eval/backfill-pilot/results.jsonl.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const DIR = "eval/backfill-pilot";
const OUT = join(DIR, "results.jsonl");

const arms = readdirSync(DIR)
  .filter((f) => f.endsWith(".jsonl") && f !== "results.jsonl")
  .sort();
if (arms.length === 0) throw new Error(`no per-arm .jsonl files in ${DIR}/ — run the pilot first`);

const rows = [];
for (const arm of arms) {
  for (const line of readFileSync(join(DIR, arm), "utf8").split("\n").filter(Boolean)) {
    const row = JSON.parse(line);
    const path = row.imagePath;
    delete row.imagePath;
    // A missing image is recorded, not silently dropped: a row with neither a
    // path nor a hash would look identical to one that was never measured.
    if (path && existsSync(path)) {
      row.imageSha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
    } else if (path) {
      row.imageSha256 = null;
      row.imageMissingAtMerge = true;
    }
    rows.push(row);
  }
}

// Fail closed rather than committing a file that leaks a private path.
const leaked = rows.filter((r) => JSON.stringify(r).includes("images-private"));
if (leaked.length > 0) {
  throw new Error(`${leaked.length} row(s) still reference corpus/images-private — refusing to write ${OUT}`);
}

writeFileSync(OUT, rows.map((r) => JSON.stringify(r, Object.keys(r).sort())).join("\n") + "\n");
console.log(
  `${rows.length} rows from ${arms.length} arms ` +
    `(${new Set(rows.map((r) => r.entryId)).size} entries) -> ${OUT}`,
);
