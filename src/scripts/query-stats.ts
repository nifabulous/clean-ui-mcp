#!/usr/bin/env node
/**
 * query-stats.ts — MCP retrieval analytics
 *
 * Reads corpus/query-log.jsonl and cross-references against corpus/entries.json:
 *   1. What's being searched for (top queries, terms)
 *   2. Zero-result queries (live gaps agents hit)
 *   3. Dead entries (exist but never retrieved)
 *   4. Demand vs supply divergence (high query volume, low corpus count)
 *
 * Usage:
 *   npm run query-stats
 *   npm run query-stats -- --json
 *   npm run query-stats -- --since 2026-06-01
 *   npm run query-stats -- --top 20
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUERY_LOG_PATH = resolve(__dirname, "..", "..", "corpus", "query-log.jsonl");
const CORPUS_PATH = resolve(__dirname, "..", "..", "corpus", "entries.json");

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const topN = Number(getArg("--top") ?? 15);
const sinceArg = getArg("--since");

function getArg(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

interface QueryLogLine {
  ts: string;
  query?: string;
  category?: string;
  styleTag?: string;
  qualityTier?: string;
  resultIds: string[];
}

interface Entry {
  id: string;
  patternType?: string;
  categories?: string[];
}

const STOPWORDS = new Set([
  "a", "an", "the", "for", "with", "and", "or", "of", "in", "on", "to",
  "is", "how", "what", "show", "me", "find", "some", "good", "best",
]);

// Load query log (graceful when it doesn't exist)
let logLines: QueryLogLine[] = [];
if (existsSync(QUERY_LOG_PATH)) {
  const raw = readFileSync(QUERY_LOG_PATH, "utf-8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { logLines.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
}

// Load entries
const entries: Entry[] = JSON.parse(readFileSync(CORPUS_PATH, "utf-8")).entries;

// Filter by date if --since
if (sinceArg) {
  const since = new Date(sinceArg);
  logLines = logLines.filter((l) => new Date(l.ts) >= since);
}

// --- Query frequency ---
const queryFreq: Record<string, number> = {};
for (const l of logLines) {
  const q = (l.query ?? "").trim().toLowerCase();
  if (q) queryFreq[q] = (queryFreq[q] ?? 0) + 1;
}

// --- Term frequency ---
const termFreq: Record<string, number> = {};
for (const l of logLines) {
  for (const term of (l.query ?? "").toLowerCase().split(/[^a-z0-9-]+/)) {
    if (term.length >= 3 && !STOPWORDS.has(term)) termFreq[term] = (termFreq[term] ?? 0) + 1;
  }
}

// --- Zero-result queries ---
const zeroResultQueries = logLines.filter((l) => (l.resultIds?.length ?? 0) === 0);
const zeroResultFreq: Record<string, number> = {};
for (const l of zeroResultQueries) {
  const q = (l.query ?? "(no query — filter-only)").trim().toLowerCase();
  zeroResultFreq[q] = (zeroResultFreq[q] ?? 0) + 1;
}

// --- Entry retrieval counts ---
const retrievalCounts: Record<string, number> = {};
for (const l of logLines) {
  for (const id of l.resultIds ?? []) retrievalCounts[id] = (retrievalCounts[id] ?? 0) + 1;
}

// --- Dead entries ---
const deadEntries = entries.filter((e) => !retrievalCounts[e.id]).map((e) => ({ id: e.id, patternType: e.patternType }));

// --- Top retrieved ---
const entryById = new Map(entries.map((e) => [e.id, e]));
const topRetrieved = Object.entries(retrievalCounts)
  .sort((a, b) => b[1] - a[1])
  .slice(0, topN)
  .map(([id, count]) => ({ id, count, patternType: entryById.get(id)?.patternType ?? "(deleted)" }));

// --- Demand vs supply ---
const catQueryVolume: Record<string, number> = {};
for (const l of logLines) if (l.category) catQueryVolume[l.category] = (catQueryVolume[l.category] ?? 0) + 1;
const catCorpusCounts: Record<string, number> = {};
for (const e of entries) for (const c of e.categories ?? []) catCorpusCounts[c] = (catCorpusCounts[c] ?? 0) + 1;
const divergence = Object.keys({ ...catQueryVolume, ...catCorpusCounts })
  .map((cat) => ({ category: cat, queried: catQueryVolume[cat] ?? 0, inCorpus: catCorpusCounts[cat] ?? 0 }))
  .sort((a, b) => (b.queried - b.inCorpus) - (a.queried - a.inCorpus));

const sortTop = (freq: Record<string, number>, n: number) =>
  Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, n).map(([value, count]) => ({ value, count }));

const report = {
  totalQueries: logLines.length,
  dateRange: logLines.length ? { from: logLines[0].ts, to: logLines[logLines.length - 1].ts } : null,
  topQueries: sortTop(queryFreq, topN),
  topTerms: sortTop(termFreq, topN),
  zeroResult: { count: zeroResultQueries.length, rate: logLines.length ? zeroResultQueries.length / logLines.length : 0, top: sortTop(zeroResultFreq, topN) },
  retrieval: { totalEntries: entries.length, everRetrieved: Object.keys(retrievalCounts).length, deadCount: deadEntries.length, deadEntries, topRetrieved },
  demandVsSupply: divergence.filter((d) => d.queried > 0 || d.inCorpus > 0),
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const hr = () => console.log("─".repeat(70));
  const pl = (items: { value: string; count: number }[]) => {
    if (!items.length) return console.log("  (none)");
    const ml = Math.max(...items.map((i) => i.value.length));
    for (const { value, count } of items) console.log(`  ${value.padEnd(ml + 2)}${count}`);
  };

  hr();
  console.log(`query-stats — ${report.totalQueries} logged queries`);
  if (report.dateRange) console.log(`  range: ${report.dateRange.from} → ${report.dateRange.to}`);
  hr();

  if (report.totalQueries === 0) {
    console.log("\nNo query activity yet. This becomes meaningful after real MCP usage.");
    hr();
  } else {
    console.log("\n🔎 Top queries"); pl(report.topQueries);
    console.log("\n🔎 Top terms"); pl(report.topTerms);
    console.log(`\n🚫 Zero-result queries — ${report.zeroResult.count} (${(report.zeroResult.rate * 100).toFixed(1)}%)`);
    console.log("   Live gaps someone actually hit:"); pl(report.zeroResult.top);
    console.log(`\n💀 Dead entries — ${report.retrieval.deadCount} of ${report.retrieval.totalEntries} never retrieved`);
    deadEntries.slice(0, 15).forEach((e) => console.log(`    ${e.id}  (${e.patternType ?? "?"})`));
    if (deadEntries.length > 15) console.log(`    ... and ${deadEntries.length - 15} more`);
    console.log(`\n⭐ Top retrieved`);
    topRetrieved.forEach((e) => console.log(`    ${e.count}x  ${e.id}  (${e.patternType})`));
    console.log(`\n⚖️  Demand vs supply (high-demand-low-supply first)`);
    console.log(`    category              queried   inCorpus`);
    report.demandVsSupply.slice(0, 15).forEach((d) => console.log(`    ${d.category.padEnd(22)}${String(d.queried).padEnd(10)}${d.inCorpus}`));
    hr();
  }
}
