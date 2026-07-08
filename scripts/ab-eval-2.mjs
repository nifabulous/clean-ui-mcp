#!/usr/bin/env node
/**
 * A/B eval round 2: MiniMax extraction (sole extractor) + critique
 * (DeepSeek vs MiniMax). 10 new images, read-only (no corpus mutation).
 *
 * Each image:
 *   1. Extract via MiniMax (extractionOnly:true, thinking disabled)
 *   2. Critique the SAME extraction via DeepSeek AND MiniMax
 *   → apples-to-apples comparison of critique quality
 */
import { tagImage, generateCritique } from '../dist/tagger.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('../dist/env.js');

const images = JSON.parse(readFileSync('/tmp/ab-eval-images-2.json', 'utf-8'));
console.log(`A/B eval round 2: ${images.length} images (MiniMax extraction → DeepSeek vs MiniMax critique)\n`);

const results = [];

for (let i = 0; i < images.length; i++) {
  const img = images[i];
  console.log(`\n[${i+1}/${images.length}] ${img.id} (${img.patternType}/${img.platform})`);

  // ── EXTRACTION (MiniMax only) ──
  console.log(`  extraction: MiniMax...`);
  let extraction = null;
  let exMs = 0;
  try {
    const t0 = Date.now();
    const entry = await tagImage({
      imagePath: resolve('corpus', img.path),
      productName: img.productName,
      url: img.url,
      imageDetail: 'low',
      extractionOnly: true,
      providerOverride: 'minimax',
    });
    exMs = Date.now() - t0;
    extraction = entry._raw?.extraction;
    console.log(`  ✓ ${exMs}ms (pattern: ${extraction?.patternType ?? '?'})`);
  } catch (e) {
    console.log(`  ❌ ${e.message.slice(0,80)}`);
  }

  // ── CRITIQUE A/B (same MiniMax extraction) ──
  const critiques = {};
  if (extraction) {
    console.log(`  critique: DeepSeek...`);
    const t1 = Date.now();
    try {
      const c = await generateCritique(img.productName, extraction, 'openai');
      critiques.deepseek = { critique: c.critique, whatToSteal: c.whatToSteal, ms: Date.now() - t1 };
      console.log(`    DeepSeek: ✓ ${critiques.deepseek.ms}ms (${c.critique.length} chars)`);
    } catch (e) {
      critiques.deepseek = { error: e.message.slice(0, 100), ms: Date.now() - t1 };
      console.log(`    DeepSeek: ❌ ${e.message.slice(0,60)}`);
    }

    console.log(`  critique: MiniMax...`);
    const t2 = Date.now();
    try {
      const c = await generateCritique(img.productName, extraction, 'minimax');
      critiques.minimax = { critique: c.critique, whatToSteal: c.whatToSteal, ms: Date.now() - t2 };
      console.log(`    MiniMax: ✓ ${critiques.minimax.ms}ms (${c.critique.length} chars)`);
    } catch (e) {
      critiques.minimax = { error: e.message.slice(0, 100), ms: Date.now() - t2 };
      console.log(`    MiniMax: ❌ ${e.message.slice(0,60)}`);
    }
  }

  results.push({ image: img, extraction: { ms: exMs, pattern: extraction?.patternType, error: !extraction }, critiques });
}

writeFileSync('/tmp/ab-eval-2-results.json', JSON.stringify(results, null, 2));

// ─── SUMMARY ────────────────────────────────────────────────────────────────
console.log('\n\n══════════════════════════════════════════════════════════════════════');
console.log('CRITIQUE: DeepSeek vs MiniMax (same MiniMax extraction baseline)');
console.log('══════════════════════════════════════════════════════════════════════\n');

let dsTotal = 0, mmTotal = 0, dsFull = 0, mmFull = 0, dsChars = 0, mmChars = 0;

for (const r of results) {
  if (!r.critiques.deepseek && !r.critiques.minimax) continue;
  const ds = r.critiques.deepseek;
  const mm = r.critiques.minimax;
  console.log(`${r.image.id} (${r.image.patternType}/${r.image.platform}):`);

  if (ds) {
    const len = ds.critique?.length ?? 0;
    dsChars += len; dsTotal += ds.ms;
    if (len > 200) dsFull++;
    console.log(`  DeepSeek (${ds.ms}ms, ${len} chars)${len < 200 ? ' ⚠ SHORT' : ''}:`);
    console.log(`    "${(ds.critique || ds.error || '').slice(0, 280)}..."`);
  }
  if (mm) {
    const len = mm.critique?.length ?? 0;
    mmChars += len; mmTotal += mm.ms;
    if (len > 200) mmFull++;
    console.log(`  MiniMax  (${mm.ms}ms, ${len} chars)${len < 200 ? ' ⚠ SHORT' : ''}:`);
    console.log(`    "${(mm.critique || mm.error || '').slice(0, 280)}..."`);
  }
  console.log('');
}

console.log('══════════════════════════════════════════════════════════════════════');
console.log('SUMMARY');
console.log('══════════════════════════════════════════════════════════════════════');
console.log(`DeepSeek: ${dsFull}/${results.length} full, avg ${dsFull ? Math.round(dsTotal/dsFull) : 0}ms, avg ${dsFull ? Math.round(dsChars/dsFull) : 0} chars`);
console.log(`MiniMax:  ${mmFull}/${results.length} full, avg ${mmFull ? Math.round(mmTotal/mmFull) : 0}ms, avg ${mmFull ? Math.round(mmChars/mmFull) : 0} chars`);
console.log(`\nFull results: /tmp/ab-eval-2-results.json`);
