#!/usr/bin/env node
import "../env.js";
/**
 * tag-image.ts  — CLI wrapper around src/tagger.ts
 *
 * Usage:
 *   npm run tag-image -- --image <path> --product <name> --url <url> [--id <slug>]
 *
 * Output: prints a partial CorpusEntry JSON block to stdout.
 * Paste into corpus/entries.json, rewrite [DRAFT] fields, then validate.
 */

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { tagImage } from "../tagger.js";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    image:   { type: "string" },
    product: { type: "string" },
    url:     { type: "string" },
    id:      { type: "string" },
    help:    { type: "boolean", short: "h", default: false },
  },
});

if (values.help || !values.image || !values.product || !values.url) {
  console.error(`
Usage:
  npm run tag-image -- --image <path> --product <name> --url <url> [--id <slug>]

Example:
  npm run tag-image -- --image corpus/images-private/linear-board.png \\
    --product "Linear" --url "https://linear.app"

Env required: OPENAI_API_KEY in .env
Optional: OPENAI_AUTO_TAG_MODEL in .env (default: gpt-5.4-nano)
`);
  process.exit(1);
}

const imagePath = resolve(values.image!);
if (!existsSync(imagePath)) {
  console.error(`Image not found: ${imagePath}`);
  process.exit(1);
}

if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY not set. Add it to .env, then rerun this command.");
  process.exit(1);
}

console.error("Calling OpenAI vision API…");

try {
  const result = await tagImage({
    imagePath,
    productName: values.product!,
    url:         values.url!,
    id:          values.id,
  });

  // Strip internal _raw field from CLI output
  const { _raw, ...entry } = result;
  console.log(JSON.stringify(entry, null, 2));

  console.error(`
Done. Paste the above into corpus/entries.json, then:
  1. Rewrite critique and whatToSteal (remove [DRAFT] markers)
  2. Set qualityScore (1–5)
  3. Update title subtitle
  4. Run: npm run validate-corpus
`);
} catch (err) {
  console.error("Tagger failed:", err);
  process.exit(1);
}
