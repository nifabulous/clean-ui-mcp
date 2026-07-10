#!/usr/bin/env node
import "../env.js";
/**
 * add-entry.ts
 * ─────────────
 * Interactive wizard for adding a new corpus entry.
 * Optionally runs the vision tagger automatically if you supply an image path.
 *
 * Usage:
 *   npm run add-entry
 *   npm run add-entry -- --image corpus/images-private/foo.png --product "Vercel" --url "https://vercel.com/dashboard"
 *
 * Flow:
 *   1. (If --image given) Call vision tagger to pre-fill visual attributes
 *   2. Prompt you for every remaining field interactively
 *   3. Validate the completed entry against the Zod schema
 *   4. Append it to corpus/entries.json
 *   5. Run the corpus validator
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { execSync } from "node:child_process";
import { imageSize } from "image-size";

import { CorpusEntry, Category, StyleTag, Component, DomainTag, PatternType, Corpus, findDraftMarkers } from "../schema.js";
import type { CorpusEntryT } from "../schema.js";
import { findVagueAntiPatterns } from "../content-lint.js";
import { toCorpusRelativePath } from "../paths.js";
import { hasVisionKey, tagImage } from "../tagger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = resolve(__dirname, "..", "..", "corpus", "entries.json");

/**
 * Draft-hygiene + vague-phrase gate for the add-entry CLI. Returns a formatted
 * error string if the entry is blocked, or null if clean. Exported so tests can
 * prove the wiring exists (a refactor that removes the gate would break the test).
 */
export function validateEntryGates(entry: CorpusEntryT): string | null {
  const dirtyFields = findDraftMarkers(entry);
  if (dirtyFields.length) {
    let msg = "\n  ❌ Entry contains draft/placeholder markers:";
    for (const field of dirtyFields) msg += `\n     ${field}`;
    msg += "\n     Rewrite these fields with real content before saving.";
    return msg;
  }
  const vague = findVagueAntiPatterns(entry);
  if (vague.length) {
    let msg = "\n  ❌ Entry contains generic filler in anti-patterns:";
    for (const v of vague) msg += `\n     ${v.field}: ${v.issues.join("; ")}`;
    msg += '\n     Name the specific mistake this design avoids — not "keep it clean".';
    return msg;
  }
  return null;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

const rl = createInterface({ input, output });

async function ask(prompt: string, fallback = ""): Promise<string> {
  const answer = await rl.question(`  ${prompt}${fallback ? ` [${fallback}]` : ""}: `);
  return answer.trim() || fallback;
}

async function askMultiline(prompt: string): Promise<string> {
  console.log(`  ${prompt}`);
  console.log(`  (Enter text. Type a line containing only "." to finish.)`);
  const lines: string[] = [];
  while (true) {
    const line = await rl.question("  > ");
    if (line.trim() === ".") break;
    lines.push(line);
  }
  return lines.join("\n");
}

async function askList(prompt: string): Promise<string[]> {
  console.log(`  ${prompt}`);
  console.log(`  (Enter one item per line. Empty line to finish.)`);
  const items: string[] = [];
  while (true) {
    const line = await rl.question("  > ");
    if (!line.trim()) break;
    items.push(line.trim());
  }
  return items;
}

async function askEnum<T extends string>(
  prompt: string,
  options: readonly T[],
  fallback?: T
): Promise<T> {
  console.log(`  ${prompt}`);
  options.forEach((o, i) => console.log(`    ${i + 1}. ${o}`));
  while (true) {
    const raw = await rl.question(`  Choice${fallback ? ` [${fallback}]` : ""}: `);
    if (!raw.trim() && fallback) return fallback;
    const num = parseInt(raw);
    if (!isNaN(num) && num >= 1 && num <= options.length) return options[num - 1];
    const direct = options.find((o) => o === raw.trim());
    if (direct) return direct;
    console.log(`  Invalid. Enter a number 1-${options.length} or the exact value.`);
  }
}

async function askEnumMulti<T extends string>(
  prompt: string,
  options: readonly T[],
  min = 1
): Promise<T[]> {
  console.log(`  ${prompt}`);
  options.forEach((o, i) => console.log(`    ${i + 1}. ${o}`));
  console.log(`  Enter comma-separated numbers or values (min ${min}):`);
  while (true) {
    const raw = await rl.question("  > ");
    const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
    const result: T[] = [];
    let valid = true;
    for (const p of parts) {
      const num = parseInt(p);
      if (!isNaN(num) && num >= 1 && num <= options.length) {
        result.push(options[num - 1]);
      } else if (options.includes(p as T)) {
        result.push(p as T);
      } else {
        console.log(`  Unknown value: "${p}"`);
        valid = false;
        break;
      }
    }
    if (valid && result.length >= min) return result;
    if (valid) console.log(`  Need at least ${min} selection(s).`);
  }
}

async function askBool(prompt: string, fallback = false): Promise<boolean> {
  const raw = await ask(`${prompt} (y/n)`, fallback ? "y" : "n");
  return raw.toLowerCase().startsWith("y");
}

async function askHexList(prompt: string): Promise<string[]> {
  console.log(`  ${prompt}`);
  console.log("  (Enter comma-separated hex codes, e.g. #0a0a0a, #ffffff, #635bff)");
  while (true) {
    const raw = await rl.question("  > ");
    const parts = raw.split(",").map((p) => p.trim().replace(/\s/g, "")).filter(Boolean);
    if (parts.every((p) => /^#[0-9a-fA-F]{6}$/.test(p))) return parts;
    console.log("  Invalid. Hex codes must be 6-digit format like #1a2b3c.");
  }
}

// ─── run vision tagger if image is available ─────────────────────────────────

async function runTagger(imagePath: string, product: string, url: string): Promise<Record<string, unknown> | null> {
  if (!hasVisionKey()) {
    console.log("\n  ⚠  No vision provider key set in .env — skipping auto-tagging.");
    return null;
  }
  console.log("\n  🔍 Running vision tagger on image…");
  try {
    // Import the tagger directly rather than spawning the compiled CLI:
    // avoids a required `tsc` build before running, and skips the stdout-JSON
    // round trip. The standalone tag-image.ts CLI still exists for shell use.
    const result = await tagImage({ imagePath: resolve(imagePath), productName: product, url });
    return result as unknown as Record<string, unknown>;
  } catch (err) {
    console.log("  ⚠  Vision tagger failed — continuing manually.", err);
    return null;
  }
}

// ─── main wizard ─────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    image:   { type: "string" },
    product: { type: "string" },
    url:     { type: "string" },
    help:    { type: "boolean", short: "h", default: false },
  },
});

if (args.help) {
  console.log(`
Usage:
  npm run add-entry
  npm run add-entry -- --image <path> --product <name> --url <url>
`);
  process.exit(0);
}

async function main() {
console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  clean-ui-mcp — add entry
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);

// Source info
const productName = args.product ?? await ask("Product name (e.g. Linear, Stripe, Arc)");
const url         = args.url     ?? await ask("Source URL");
const today       = new Date().toISOString().slice(0, 10);

// Optionally run vision tagger
let tagged: Record<string, unknown> | null = null;
const imagePath = args.image ?? await ask("Image path (Enter to skip)", "");
if (imagePath) {
  const fullPath = resolve(imagePath);
  if (existsSync(fullPath)) {
    tagged = await runTagger(imagePath, productName, url);
  } else {
    console.log("  Image path not found — continuing without image.");
  }
}

// If tagger ran, show draft entry and let user review
if (tagged) {
  console.log("\n  ✅ Vision tagger complete. Draft pre-fills:");
  console.log(`     categories:  ${(tagged.categories as string[]).join(", ")}`);
  console.log(`     styleTags:   ${(tagged.styleTags as string[]).join(", ")}`);
  console.log(`     components:  ${((tagged.components as string[] | undefined) ?? []).join(", ")}`);
  console.log(`     domainTags:  ${((tagged.domainTags as string[] | undefined) ?? []).join(", ")}`);
  const visual = tagged.visual as CorpusEntryT["visual"] | undefined;
  console.log(`     colors:      ${visual?.dominantColors.join(", ") ?? ""}`);
  console.log(`     accent:      ${visual?.accentColor ?? "none"}`);
  console.log(`     spacing:     ${visual?.spacingDensity ?? ""}`);
  console.log(`     corners:     ${visual?.cornerStyle ?? ""}`);
  console.log();
}

// ─── field-by-field ──────────────────────────────────────────────────────────

console.log("[ Identity ]");
const rawId = `${productName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${today}`;
const id    = await ask("Entry id (stable slug)", rawId);
const title = await ask("Title", `${productName} — (add descriptive subtitle)`);

console.log("\n[ Categories & Style ]");
const categories = await askEnumMulti(
  "Categories (select 1-3):",
  Category.options,
  1
);
const styleTags = await askEnumMulti(
  "Style tags (select 1-3):",
  StyleTag.options,
  1
);
const taggedComponents = ((tagged?.components as string[] | undefined) ?? [])
  .filter((component) => (Component.options as readonly string[]).includes(component))
  .slice(0, 10);
let components = taggedComponents;
if (taggedComponents.length) {
  const accept = await askBool(`  Accept tagger components (${taggedComponents.join(", ")})?`, true);
  components = accept
    ? taggedComponents
    : await askEnumMulti("Visible components (optional):", Component.options, 0);
} else {
  components = await askEnumMulti("Visible components (optional):", Component.options, 0);
}
const taggedDomainTags = ((tagged?.domainTags as string[] | undefined) ?? [])
  .filter((domain) => (DomainTag.options as readonly string[]).includes(domain))
  .slice(0, 4);
let domainTags = taggedDomainTags;
if (taggedDomainTags.length) {
  const accept = await askBool(`  Accept tagger domain tags (${taggedDomainTags.join(", ")})?`, true);
  domainTags = accept
    ? taggedDomainTags
    : await askEnumMulti("Business domain tags (optional):", DomainTag.options, 0);
} else {
  domainTags = await askEnumMulti("Business domain tags (optional):", DomainTag.options, 0);
}
const patternType = await askEnum(
  "Primary pattern type (the ONE pattern this exemplifies):",
  PatternType.options
);

console.log("\n[ Anti-patterns — what mistakes does this design avoid? ]");
console.log("  This is the differentiator. Be specific.");
const antiPatterns = await askList("Mistakes avoided (the core anti-pattern field):");
console.log("\n[ Where copying this fails / accessibility risks (optional) ]");
const whereThisFails = await askList("Contexts where copying hurts (empty to skip):");
// Accessibility risks require structured objects with canonical WCAG IDs — the
// interactive wizard can't collect those reliably, so the auto-tagger is the
// path that populates them. Legacy notes go through the migration script.
await askList("Accessibility risks (handled by Auto-fill — press enter to skip):");

console.log("\n[ Image ]");
const hasImage = imagePath && existsSync(resolve(imagePath));
let imageRef: CorpusEntryT["image"];
if (hasImage) {
  const visibilityOpts = ["private", "public-thumb", "public-own"] as const;
  const visibility = await askEnum(
    "Image visibility (default: private):",
    visibilityOpts,
    "private"
  );
  const dimensions = visibility === "private"
    ? { width: null, height: null }
    : imageSize(readFileSync(resolve(imagePath)));
  imageRef = {
    visibility,
    path: toCorpusRelativePath(imagePath),
    width: dimensions.width ?? null,
    height: dimensions.height ?? null,
  };
} else {
  console.log("  No image — entry will be link-only.");
  imageRef = { visibility: "private", path: null, width: null, height: null };
}

console.log("\n[ Visual Attributes ]");
console.log("  (Vision tagger pre-fills shown in brackets — press Enter to accept)");
const taggedVisual = tagged?.visual as CorpusEntryT["visual"] | undefined;
const dominantColors = taggedVisual?.dominantColors;
let colors: string[];
if (dominantColors?.length) {
  const accept = await askBool(`  Accept tagger colors (${dominantColors.join(", ")})?`, true);
  colors = accept ? dominantColors : await askHexList("Dominant colors:");
} else {
  colors = await askHexList("Dominant colors:");
}

const accentRaw = taggedVisual?.accentColor;
const accentFallback = accentRaw ?? "null";
const accentInput = await ask("Accent color (hex or 'null')", accentFallback);
const accentColor = accentInput === "null" ? null : accentInput;

const displayFont = await ask("Display/heading font (or Enter to skip)", taggedVisual?.typePairing.display ?? "");
const bodyFont    = await ask("Body font (or Enter to skip)", taggedVisual?.typePairing.body ?? "");
const typographyNotes = await ask("Typography notes (brief)", taggedVisual?.typePairing.notes ?? "");

const spacingOpts = ["compact", "moderate", "spacious"] as const;
const spacingDefault = (taggedVisual?.spacingDensity as typeof spacingOpts[number]) ?? "moderate";
const spacingDensity = await askEnum("Spacing density:", spacingOpts, spacingDefault);

const cornerOpts = ["sharp", "slight-round", "pill", "mixed"] as const;
const cornerDefault = (taggedVisual?.cornerStyle as typeof cornerOpts[number]) ?? "slight-round";
const cornerStyle = await askEnum("Corner style:", cornerOpts, cornerDefault);

const usesShadows = await askBool("Uses shadows?", !!taggedVisual?.usesShadows);
const usesBorders = await askBool("Uses borders?", !!taggedVisual?.usesBorders);

console.log("\n[ Critique — this is the most important part ]");
console.log("  Write 2-5 sentences: what makes this UI exceptional? Be specific.");
if (tagged?.draftCritique) {
  console.log(`  Tagger draft: "${tagged.draftCritique}"`);
}
const critique = await askMultiline("Your critique:");

console.log("\n[ What to Steal ]");
console.log("  Concrete, copyable techniques a developer can directly apply.");
if (tagged?.draftWhatToSteal) {
  console.log(`  Tagger drafts: ${(tagged.draftWhatToSteal as string[]).join(" | ")}`);
}
const whatToSteal = await askList("What to steal:");

console.log("\n[ Quality ]");
console.log("  Exceptional entries: 3-5. Cautionary (bad-example) entries: 1-2.");
console.log("  This wizard creates exceptional entries — use 3-5.");
const qualityRaw = await ask("Quality score (3-5 for exceptional)", "4");
const qualityScore = Math.min(5, Math.max(3, parseInt(qualityRaw) || 4));

// ─── assemble + validate ─────────────────────────────────────────────────────

const newEntry: CorpusEntryT = {
  id,
  title,
  patternType,
  categories: categories as CorpusEntryT["categories"],
  styleTags:  styleTags  as CorpusEntryT["styleTags"],
  components: components as CorpusEntryT["components"],
  domainTags: domainTags.length ? domainTags as CorpusEntryT["domainTags"] : undefined,
  source: { productName, url, capturedAt: today, capturedBy: "self" },
  image: imageRef,
  visual: {
    dominantColors: colors,
    accentColor,
    typePairing: {
      display: displayFont || null,
      body:    bodyFont    || null,
      notes:   typographyNotes || undefined,
    },
    spacingDensity,
    cornerStyle,
    usesShadows,
    usesBorders,
  },
  critique: critique || "[PLACEHOLDER — fill this in]",
  whatToSteal: whatToSteal.length ? whatToSteal : ["[PLACEHOLDER — fill this in]"],
  antiPatterns: {
    antiPatterns: antiPatterns.length ? antiPatterns : ["[PLACEHOLDER — fill this in]"],
    whereThisFails,
    accessibilityRisks: [],
    legacyAccessibilityNotes: [],
  },
  qualityTier: "exceptional",
  qualityScore,
  reviewStatus: "approved", // terminal CLI path — entries land approved; drafts are a UI workflow
  provenance: { taggedBy: "human" }, // terminal CLI = human-authored fields
  addedAt: today,
};

const validation = CorpusEntry.safeParse(newEntry);
if (!validation.success) {
  console.error("\n  ❌ Entry failed schema validation:");
  for (const issue of validation.error.issues) {
    console.error(`     ${issue.path.join(".")}: ${issue.message}`);
  }
  console.log("\n  Draft entry (fix and add manually):");
  console.log(JSON.stringify(newEntry, null, 2));
  rl.close();
  process.exit(1);
}

// Draft-hygiene + vague-phrase gates: reject before writing. Both were missing
// before this milestone — the [PLACEHOLDER — fill this in] defaults above could
// reach entries.json directly, caught only by the post-write validator.
const gateError = validateEntryGates(validation.data);
if (gateError) {
  console.error(gateError);
  rl.close();
  process.exit(1);
}

// ─── append to corpus ─────────────────────────────────────────────────────────

const raw = JSON.parse(readFileSync(CORPUS_PATH, "utf-8"));
const corpus = Corpus.parse(raw);

if (corpus.entries.some((e) => e.id === id)) {
  console.error(`\n  ❌ Entry with id "${id}" already exists. Change the id.`);
  rl.close();
  process.exit(1);
}

corpus.entries.push(newEntry);
writeFileSync(CORPUS_PATH, JSON.stringify(corpus, null, 2) + "\n", "utf-8");

console.log(`\n  ✅ Added "${title}" (${id}) to corpus.`);
console.log(`     Total entries: ${corpus.entries.length}`);
console.log("\n  Running validator…");

try {
  execSync("npm run validate-corpus", {
    cwd: resolve(__dirname, "..", ".."),
    stdio: "inherit",
  });
} catch {
  console.error("  ❌ Validator failed — check entries.json.");
}

rl.close();
} // end main()

main().catch((err) => { console.error(err); process.exit(1); });
