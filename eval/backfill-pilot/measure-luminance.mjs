/**
 * Measure per-image luminance across the whole corpus, to decide whether
 * `colorScheme` needs a model at all.
 *
 * Method, stated because the number changes with it: each image is decoded,
 * downsampled to 64x64, converted to greyscale with the Rec. 601 luma weights,
 * and the MEDIAN of those 4096 samples is that image's luminance. Median rather
 * than mean so a dark hero image or a large photo does not drag a plainly light
 * screenshot below the threshold.
 *
 * `light` is luminance >= 110. That cut is the one the backfill pilot reports
 * against; it is not tuned, and it is deliberately generous to `dark` — the
 * claim being tested is that the corpus is overwhelmingly light, so the
 * threshold should make that claim harder to reach, not easier.
 *
 * This exists as a committed script rather than a one-off because the first
 * version of these numbers was produced by a throwaway command and could not be
 * reproduced: it reported median 242 / 28 below-threshold where the pinned
 * method reports 253 / 36. The conclusion held, the figures did not.
 *
 *   node eval/backfill-pilot/measure-luminance.mjs
 *
 * Run from the repo root. Prints a summary; writes nothing.
 */
import { readFileSync, existsSync } from "node:fs";
import sharp from "sharp";

const THRESHOLD = 110;
const corpus = JSON.parse(readFileSync("corpus/entries.json", "utf8"));
const entries = corpus.entries ?? corpus;

const lums = [];
let unreadable = 0;
for (const entry of entries) {
  const path = entry.image?.path && `corpus/${entry.image.path}`;
  if (!path || !existsSync(path)) continue;
  try {
    const { data } = await sharp(path).resize(64, 64, { fit: "fill" }).greyscale().raw().toBuffer({ resolveWithObject: true });
    const sorted = Array.from(data).sort((a, b) => a - b);
    lums.push(sorted[sorted.length >> 1]);
  } catch {
    unreadable++;
  }
}

const sorted = [...lums].sort((a, b) => a - b);
const dark = lums.filter((l) => l < THRESHOLD).length;
console.log(`images measured : ${lums.length}${unreadable ? ` (${unreadable} unreadable)` : ""}`);
console.log(`median luminance: ${sorted[sorted.length >> 1]}`);
console.log(`below ${THRESHOLD}       : ${dark}`);
console.log(`light share     : ${((100 * (lums.length - dark)) / lums.length).toFixed(1)}%`);
