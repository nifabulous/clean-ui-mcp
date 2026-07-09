/**
 * Pattern discovery report — reads `patternDiscovery.suggestedPatternType`
 * across the corpus and shows which patterns the tagger thinks are missing from
 * the enum. Falls back to `_raw.extraction.suggestedPatternType` for transient
 * or legacy debug records.
 *
 * After a bulk re-tag, run this to decide which suggested patterns earn enum
 * promotion. High-count suggestions with consistent naming are strong candidates.
 *
 *   npm run ts -- src/scripts/pattern-discovery.ts
 *   node dist/scripts/pattern-discovery.js
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CorpusEntry, PatternType } from "../schema.js";

const corpusPath = resolve("corpus/entries.json");
const raw = JSON.parse(readFileSync(corpusPath, "utf8")) as { entries: unknown[] };

// Validate entries (lenient — we want to report even on partially-tagged corpora)
const entries: Array<Record<string, unknown>> = [];
for (const e of raw.entries) {
  const parsed = CorpusEntry.safeParse(e);
  if (parsed.success) entries.push(parsed.data as unknown as Record<string, unknown>);
  else entries.push(e as Record<string, unknown>);
}

// Collect suggestedPatternType values
const suggestions: Record<string, string[]> = {}; // pattern → [entry ids]
let total = 0;
let withSuggestion = 0;

for (const entry of entries) {
  total++;
  const discovery = entry.patternDiscovery as Record<string, unknown> | undefined;
  const raw = entry._raw as Record<string, unknown> | undefined;
  const extraction = raw?.extraction as Record<string, unknown> | undefined;
  const suggestion = discovery?.suggestedPatternType ?? extraction?.suggestedPatternType;
  if (typeof suggestion === "string" && suggestion.trim()) {
    const normalized = suggestion.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-");
    if (!normalized || (PatternType.options as readonly string[]).includes(normalized)) continue;
    if (!suggestions[normalized]) suggestions[normalized] = [];
    suggestions[normalized].push(entry.id as string);
    withSuggestion++;
  }
}

console.log(`\n=== PATTERN DISCOVERY REPORT ===`);
console.log(`${total} entries scanned, ${withSuggestion} (${Math.round(withSuggestion / total * 100)}%) emitted a suggestedPatternType\n`);

if (withSuggestion === 0) {
  console.log("No suggestions found. This is expected before a bulk re-tag with the");
  console.log("discovery lane enabled. After re-tagging, re-run this report.");
  console.log("\nCurrent enum values:");
  console.log(PatternType.options.map((p: string) => `  - ${p}`).join("\n"));
} else {
  const sorted = Object.entries(suggestions).sort((a, b) => b[1].length - a[1].length);
  for (const [pattern, ids] of sorted) {
    const pct = Math.round(ids.length / total * 100);
    const enumStatus = "  "; // would check against enum here
    console.log(`${pattern.padEnd(24)} ${String(ids.length).padStart(4)}  (${pct}%)`);
    ids.slice(0, 5).forEach(id => console.log(`  └ ${id}`));
    if (ids.length > 5) console.log(`  └ ... +${ids.length - 5} more`);
    console.log("");
  }
  console.log("---");
  console.log("Patterns with 5+ suggestions are strong enum-promotion candidates.");
  console.log("Patterns with 1-2 suggestions may be one-offs — consider components/domainTags instead.");
}
