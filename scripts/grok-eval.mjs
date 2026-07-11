#!/usr/bin/env node
/**
 * 4-way provider comparison: Grok vs MiniMax vs Claude vs DeepSeek.
 *
 * For each image:
 *   1. EXTRACTION A/B/C: tagImage(extractionOnly:true, extractionProvider)
 *      for grok, minimax, claude (DeepSeek is text-only, skipped for extraction)
 *   2. CRITIQUE A/B/C/D: fixed baseline extraction (Claude's), critique through
 *      grok, minimax, claude, deepseek via generateCritique
 *
 * Metrics per provider:
 *   - Hallucination count (icon-only assertions, pixel measurements, self-ref evidence)
 *   - Pattern agreement (extraction patternType vs consensus)
 *   - Critique specificity (word count, a11y risk count)
 *   - Latency
 *
 * Usage: node scripts/grok-eval.mjs [--images 5]
 * Output: /tmp/grok-eval-results.json + console summary
 */
import { tagImage, generateCritique } from "../dist/tagger.js";
import {
  PIXEL_MEASUREMENT,
  UNLABELED_CONTROL_RISK as UNLABELED_CONTROL,
} from "../dist/references/generated.js";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
require("../dist/env.js");

// ─── eval set ────────────────────────────────────────────────────────────────
const EVAL_SET = [
  { id: "hume-hume-12", path: "images-private/hume-ai-web-apr-2026-15-4.png", productName: "Hume", patternType: "landing-page", hallucinationRisk: "icon-only sidebar + fabricated orange badge" },
  { id: "sample", path: "images-private/sample-5.png", productName: "Origin", patternType: "dashboard", hallucinationRisk: "icon-only sidebar muscle memory" },
  { id: "workable-workable-2", path: "images-private/workable-web-screens-2.png", productName: "Workable", patternType: "dashboard", hallucinationRisk: "icon-only nav (cautionary tier)" },
  { id: "hume-hume-5", path: "images-private/hume-ai-web-apr-2026-5-4.png", productName: "Hume", patternType: "auth", hallucinationRisk: "fabricated close icon button" },
  { id: "origin-origin-2", path: "images-private/origin-web-screens-2-png.png", productName: "Origin", patternType: "data-table", hallucinationRisk: "color-only chips (actually text+color)" },
  { id: "wise-transfer-calculator", path: "images-private/wise-web-screens-14.png", productName: "Wise", patternType: "calculator", hallucinationRisk: "icon-only nav risk" },
  { id: "arcade-arcade-web-screens-68", path: "images-private/new-products-batch/Arcade Web Screens/Arcade Web Screens 68.png", productName: "Arcade", patternType: "command-palette", hallucinationRisk: "under-represented pattern" },
  { id: "alan-alan-ios-screens-32", path: "images-private/new-products-batch/Alan iOS Screens/Alan iOS Screens 32.png", productName: "Alan", patternType: "pricing", hallucinationRisk: "under-represented pattern" },
  { id: "hume-hume-2", path: "images-private/hume-ai-web-apr-2026-0-5.png", productName: "Hume", patternType: "marketing-hero", hallucinationRisk: "filter pill a11y" },
];

// Allow --images N to limit the set for quick runs
const maxImages = parseInt(process.argv.find((_, i, a) => a[i - 1] === "--images") ?? "99", 10);
const images = EVAL_SET.slice(0, maxImages);

// ─── hallucination detectors (mirror the sanitizer's canonical rules) ────────
// These show what each provider WOULD emit before the gates catch it.
const SELF_REFERENTIAL = /\b(component inventory|component list|extraction (?:shows|lists|describes|states)|layout region (?:is )?described|the (?:above|validated) (?:extraction|inventory))\b/i;

function countHallucinations(text) {
  if (!text) return { iconOnly: 0, pixelMeasurement: 0, selfReferential: 0, total: 0 };
  const iconOnly = (text.match(new RegExp(UNLABELED_CONTROL.source, "gi")) || []).length;
  const pixelMeasurement = (text.match(new RegExp(PIXEL_MEASUREMENT.source, "gi")) || []).length;
  const selfReferential = (text.match(new RegExp(SELF_REFERENTIAL.source, "gi")) || []).length;
  return { iconOnly, pixelMeasurement, selfReferential, total: iconOnly + pixelMeasurement + selfReferential };
}

function allProse(obj) {
  // Flatten all prose fields into one string for hallucination scanning
  const parts = [];
  if (obj.critique) parts.push(obj.critique);
  if (obj.whatToSteal) parts.push(...obj.whatToSteal);
  if (obj.antiPatterns?.antiPatterns) parts.push(...obj.antiPatterns.antiPatterns);
  if (obj.businessRationale?.rationale) parts.push(obj.businessRationale.rationale);
  if (obj.antiPatterns?.accessibilityRisks) {
    for (const r of obj.antiPatterns.accessibilityRisks) {
      parts.push(r.risk || "", r.evidence || "");
    }
  }
  return parts.join(" \n ");
}

// ─── extraction A/B/C ────────────────────────────────────────────────────────
const EXTRACTION_PROVIDERS = ["grok", "minimax", "claude"];

async function extractWith(image, provider) {
  const t0 = Date.now();
  try {
    const entry = await tagImage({
      imagePath: resolve("corpus", image.path),
      productName: image.productName,
      url: null,
      imageDetail: "low",
      extractionOnly: true,
      extractionProvider: provider, // ← correct field name (ab-eval.mjs had providerOverride — a bug)
    });
    return { entry, ms: Date.now() - t0 };
  } catch (e) {
    return { error: e.message, ms: Date.now() - t0 };
  }
}

// ─── critique A/B/C/D ────────────────────────────────────────────────────────
const CRITIQUE_PROVIDERS = ["grok", "minimax", "claude", "deepseek"];

async function critiqueWith(extraction, productName, provider) {
  const t0 = Date.now();
  // DeepSeek is reached through the 'openai' provider via OPENAI_BASE_URL_CRITIQUE
  const providerArg = provider === "deepseek" ? "openai" : provider;
  try {
    const c = await generateCritique(productName, extraction, providerArg);
    return {
      critique: c.critique,
      whatToSteal: c.whatToSteal,
      antiPatterns: c.antiPatterns,
      businessRationale: c.businessRationale,
      ms: Date.now() - t0,
    };
  } catch (e) {
    return { error: e.message, ms: Date.now() - t0 };
  }
}

// ─── main loop ───────────────────────────────────────────────────────────────
console.log(`4-way provider comparison: ${images.length} images\n`);
console.log(`Extraction: ${EXTRACTION_PROVIDERS.join(", ")}`);
console.log(`Critique:   ${CRITIQUE_PROVIDERS.join(", ")} (DeepSeek via openai-compat)\n`);

const results = [];

for (let i = 0; i < images.length; i++) {
  const img = images[i];
  console.log(`\n[${i + 1}/${images.length}] ${img.id} (${img.patternType}) — risk: ${img.hallucinationRisk}`);

  // ── EXTRACTION A/B/C ──
  const extractions = {};
  for (const prov of EXTRACTION_PROVIDERS) {
    process.stdout.write(`  extraction: ${prov}...`);
    const r = await extractWith(img, prov);
    if (r.error) {
      console.log(` ❌ ${r.error.slice(0, 80)}`);
      extractions[prov] = { error: r.error, ms: r.ms };
    } else {
      const ex = r.entry?._raw?.extraction;
      console.log(` ✓ ${r.ms}ms (pattern: ${ex?.patternType ?? "?"})`);
      extractions[prov] = {
        ms: r.ms,
        pattern: ex?.patternType,
        categories: ex?.categories,
        components: ex?.components,
        styleTags: ex?.styleTags,
        dominantColors: ex?.dominantColors,
        extraction: ex, // raw for critique baseline
      };
    }
  }

  // ── CRITIQUE A/B/C/D (use Claude extraction as baseline if available, else first success) ──
  const baselineProv = extractions.claude?.extraction ? "claude" : Object.keys(extractions).find((p) => extractions[p]?.extraction);
  const baselineExtraction = baselineProv ? extractions[baselineProv].extraction : null;

  const critiques = {};
  if (baselineExtraction) {
    for (const prov of CRITIQUE_PROVIDERS) {
      process.stdout.write(`  critique: ${prov}...`);
      const r = await critiqueWith(baselineExtraction, img.productName, prov);
      if (r.error) {
        console.log(` ❌ ${r.error.slice(0, 80)}`);
        critiques[prov] = { error: r.error, ms: r.ms };
      } else {
        const prose = allProse(r);
        const halluc = countHallucinations(prose);
        const wc = prose.split(/\s+/).length;
        const a11yCount = r.antiPatterns?.accessibilityRisks?.length ?? 0;
        console.log(` ✓ ${r.ms}ms (${wc}w, ${halluc.total} halluc, ${a11yCount} a11y)`);
        critiques[prov] = {
          ms: r.ms,
          critique: r.critique,
          wordCount: wc,
          hallucinations: halluc,
          a11yRiskCount: a11yCount,
          critiquePreview: (r.critique || "").slice(0, 200),
        };
      }
    }
  } else {
    console.log(`  ⚠ No baseline extraction — skipping critique`);
  }

  results.push({
    image: { id: img.id, patternType: img.patternType, hallucinationRisk: img.hallucinationRisk },
    extractions,
    critiqueBaseline: baselineProv,
    critiques,
  });
}

writeFileSync("/tmp/grok-eval-results.json", JSON.stringify(results, null, 2));

// ─── SUMMARY ────────────────────────────────────────────────────────────────
console.log("\n\n═══════════════════════════════════════════════════════════════════════");
console.log("EXTRACTION COMPARISON");
console.log("═══════════════════════════════════════════════════════════════════════\n");

const exStats = {};
for (const prov of EXTRACTION_PROVIDERS) exStats[prov] = { success: 0, patterns: [], totalMs: 0 };

for (const r of results) {
  for (const prov of EXTRACTION_PROVIDERS) {
    const ex = r.extractions[prov];
    if (!ex?.error) {
      exStats[prov].success++;
      exStats[prov].patterns.push(ex.pattern);
      exStats[prov].totalMs += ex.ms;
    }
  }
}

// Pattern agreement: majority vote
for (const r of results) {
  const pats = EXTRACTION_PROVIDERS.map((p) => r.extractions[p]?.pattern).filter(Boolean);
  const tally = {};
  for (const p of pats) tally[p] = (tally[p] || 0) + 1;
  const consensus = Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "?";
  r.consensus = consensus;
  console.log(`  ${r.image.id} (${r.image.patternType}): consensus=${consensus}`);
  for (const prov of EXTRACTION_PROVIDERS) {
    const ex = r.extractions[prov];
    const agree = ex?.pattern === consensus ? "✓" : "⚠";
    console.log(`    ${prov.padEnd(8)} ${ex?.error ? "❌" : agree + " " + ex?.pattern} (${ex?.ms ?? "?"}ms)`);
  }
  console.log();
}

console.log("\n═══════════════════════════════════════════════════════════════════════");
console.log("CRITIQUE COMPARISON (hallucination count = what the gates would catch)");
console.log("═══════════════════════════════════════════════════════════════════════\n");

const critStats = {};
for (const prov of CRITIQUE_PROVIDERS) {
  critStats[prov] = { success: 0, totalHalluc: 0, iconOnly: 0, pixelMeasure: 0, selfRef: 0, totalWords: 0, totalA11y: 0, totalMs: 0 };
}

for (const r of results) {
  console.log(`  ${r.image.id} (${r.image.patternType}):`);
  for (const prov of CRITIQUE_PROVIDERS) {
    const c = r.critiques?.[prov];
    if (!c) continue;
    if (c.error) {
      console.log(`    ${prov.padEnd(10)} ❌ ${c.error.slice(0, 70)}`);
      continue;
    }
    const h = c.hallucinations;
    const flag = h.total > 0 ? " ⚠ " + h.total + " HALLUC" : "";
    console.log(`    ${prov.padEnd(10)} ${c.wordCount}w  ${c.ms}ms  a11y:${c.a11yRiskCount}  halluc:${h.total}${flag}`);
    if (h.iconOnly) console.log(`               ⚠ icon-only/unlabeled: ${h.iconOnly}`);
    if (h.pixelMeasurement) console.log(`               ⚠ pixel measurement: ${h.pixelMeasurement}`);
    if (h.selfReferential) console.log(`               ⚠ self-referential: ${h.selfReferential}`);

    critStats[prov].success++;
    critStats[prov].totalHalluc += h.total;
    critStats[prov].iconOnly += h.iconOnly;
    critStats[prov].pixelMeasure += h.pixelMeasurement;
    critStats[prov].selfRef += h.selfReferential;
    critStats[prov].totalWords += c.wordCount;
    critStats[prov].totalA11y += c.a11yRiskCount;
    critStats[prov].totalMs += c.ms;
  }
  console.log();
}

// ─── FINAL TALLY ─────────────────────────────────────────────────────────────
console.log("\n═══════════════════════════════════════════════════════════════════════");
console.log("FINAL TALLY (totals across all images)");
console.log("═══════════════════════════════════════════════════════════════════════\n");

console.log("EXTRACTION:");
console.log("  Provider   Success  Avg ms   Patterns found");
for (const prov of EXTRACTION_PROVIDERS) {
  const s = exStats[prov];
  const avgMs = s.success ? Math.round(s.totalMs / s.success) : 0;
  console.log(`  ${prov.padEnd(10)} ${s.success}/${images.length}     ${avgMs}ms    ${s.patterns.join(", ")}`);
}

console.log("\nCRITIQUE:");
console.log("  Provider   Success  Total Halluc  Icon-only  Pixel  SelfRef  Avg Words  Avg A11y  Avg ms");
for (const prov of CRITIQUE_PROVIDERS) {
  const s = critStats[prov];
  const avgWords = s.success ? Math.round(s.totalWords / s.success) : 0;
  const avgA11y = s.success ? (s.totalA11y / s.success).toFixed(1) : "0";
  const avgMs = s.success ? Math.round(s.totalMs / s.success) : 0;
  console.log(`  ${prov.padEnd(10)} ${s.success}/${images.length}     ${String(s.totalHalluc).padStart(5)}      ${String(s.iconOnly).padStart(5)}     ${String(s.pixelMeasure).padStart(5)}  ${String(s.selfRef).padStart(5)}    ${String(avgWords).padStart(5)}      ${avgA11y.padStart(5)}    ${avgMs}ms`);
}

console.log("\nFull results: /tmp/grok-eval-results.json");
