// src/verify/calibration-cli.ts
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { calibrate } from "./calibration.js";

// Real-set labels use the SPEC'S ONE labelling contract (spec: "Frozen labelled
// ground-truth set"), not a second bespoke format. The spec defines that format
// precisely so detector calibration and the frozen verdict set cannot invent two:
//
//   { "entryId", "imageSha256", "field", "claim", "label", "notes",
//     "labelledAt", "labelledBy", "recorded", "imagePath", "supersedes"? }
//
//   - `label` is `confirmed | contradicted | abstain` — `confirmed`, NOT `pass`,
//     because the label describes the CLAIM's status, not a detector's verdict.
//     It maps to the detector verdict `pass` below.
//   - `imageSha256` pins the bytes, so a re-capture invalidates the label instead
//     of silently re-grounding it against different pixels.
//   - Labels are append-only: a correction adds a record with `supersedes`, and
//     the newest record per (entryId, field) wins. A label that moves mid-
//     comparison makes the comparison meaningless.
//
// The file is `eval/verdicts/labels.jsonl` — the same directory as the frozen
// verdict set (Task 1), gitignored for the image paths it references but with the
// labels themselves committed.
interface LabelRecord {
  entryId: string;
  imagePath: string;
  imageSha256: string;
  field: string;
  recorded: unknown;
  label: "confirmed" | "contradicted" | "abstain";
  labelledAt: string;
  labelledBy: string;
  supersedes?: string;
}

const labelsPath = process.argv[2] ?? "eval/verdicts/labels.jsonl";
const lines = readFileSync(labelsPath, "utf8").trim().split("\n").filter(Boolean);
const all = lines.map((line) => JSON.parse(line) as LabelRecord);

// Append-only resolution: last record per (entryId, field) wins.
const latest = new Map<string, LabelRecord>();
for (const l of all) latest.set(`${l.entryId}|${l.field}`, l);

// Refuse to calibrate against a label whose image has changed underneath it —
// otherwise the "real" numbers are measured on pixels nobody labelled.
const stale: string[] = [];
for (const l of latest.values()) {
  const actual = createHash("sha256").update(readFileSync(l.imagePath)).digest("hex");
  if (actual !== l.imageSha256) stale.push(`${l.entryId}|${l.field}`);
}
if (stale.length > 0) {
  console.error(`REFUSING: ${stale.length} label(s) reference images that have changed since labelling:`);
  for (const s of stale) console.error(`  ${s}`);
  console.error("Re-label those claims (append a record with `supersedes`) before calibrating.");
  process.exit(1);
}

const manifest = {
  version: 1 as const,
  fixtures: [...latest.values()].map((l) => ({
    id: `${l.entryId}|${l.field}`,
    file: l.imagePath,
    field: l.field,
    recorded: l.recorded,
    // `confirmed` (claim status) -> `pass` (detector verdict).
    label: l.label === "confirmed" ? ("pass" as const) : l.label,
    split: "held-out" as const,
  })),
};

// Real labels carry their own absolute/relative paths — resolve them AS-IS,
// never through the committed fixture directory.
const result = await calibrate(manifest, "held-out", { imagePathFor: (f) => f.file });
console.log(`Accuracy: ${(result.accuracy * 100).toFixed(1)}%  Decisive: ${(result.decisiveRate * 100).toFixed(1)}%`);
for (const [field, f] of Object.entries(result.byField)) {
  console.log(`${field}: accuracy ${(f.accuracy * 100).toFixed(1)}%, decisive ${(f.decisiveRate * 100).toFixed(1)}%`);
}
