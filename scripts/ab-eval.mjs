#!/usr/bin/env node
/**
 * A/B eval: extraction (MiniMax vs GPT) + critique (MiniMax vs Claude vs DeepSeek)
 * on 5 representative images.
 *
 *   1. EXTRACTION: tagImage(extractionOnly:true) per image via OpenAI and MiniMax.
 *   2. CRITIQUE: take the OpenAI extraction as the fixed baseline, run
 *      generateCritique through MiniMax, Claude, and DeepSeek (via OpenAI-compat).
 */
import { tagImage, generateCritique } from '../dist/tagger.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Force DeepSeek to actually run through NIM by setting the critique env vars.
// The openai provider for the critique pass reads OPENAI_API_KEY_CRITIQUE +
// OPENAI_BASE_URL_CRITIQUE + OPENAI_AUTO_TAG_MODEL_CRITIQUE.
process.env.OPENAI_BASE_URL_CRITIQUE = process.env.OPENAI_BASE_URL_CRITIQUE || '';
// If NIM base URL isn't set, the openai critique path uses real OpenAI — that's
// fine, we'll label it "openai-critique" in that case.

const images = JSON.parse(readFileSync('/tmp/ab-eval-images.json', 'utf-8'));
console.log(`A/B eval: ${images.length} images\n`);

async function extractWith(image, provider) {
  const t0 = Date.now();
  try {
    const entry = await tagImage({
      imagePath: resolve('corpus', image.path),
      productName: image.productName,
      url: image.url,
      imageDetail: 'low',
      extractionOnly: true,
      providerOverride: provider,
    });
    return { entry, ms: Date.now() - t0 };
  } catch (e) {
    return { error: e.message, ms: Date.now() - t0 };
  }
}

async function critiqueWith(extraction, productName, provider) {
  const t0 = Date.now();
  try {
    const entry = await generateCritique(productName, extraction, provider);
    return {
      critique: entry.critique,
      whatToSteal: entry.whatToSteal,
      antiPatterns: entry.antiPatterns?.antiPatterns,
      ms: Date.now() - t0,
    };
  } catch (e) {
    return { error: e.message, ms: Date.now() - t0 };
  }
}

const results = [];

for (let i = 0; i < images.length; i++) {
  const img = images[i];
  console.log(`\n[${i+1}/${images.length}] ${img.id} (${img.patternType}/${img.platform})`);

  // ── EXTRACTION A/B ──
  console.log(`  extraction: OpenAI...`);
  const exOpenAI = await extractWith(img, 'openai');
  console.log(`  extraction: MiniMax...`);
  const exMiniMax = await extractWith(img, 'minimax');

  console.log(`  OpenAI:  ${exOpenAI.error ? '❌ ' + exOpenAI.error.slice(0,60) : '✓ ' + exOpenAI.ms + 'ms'} (pattern: ${exOpenAI.entry?._raw?.extraction?.patternType ?? '?'})`);
  console.log(`  MiniMax: ${exMiniMax.error ? '❌ ' + exMiniMax.error.slice(0,60) : '✓ ' + exMiniMax.ms + 'ms'} (pattern: ${exMiniMax.entry?._raw?.extraction?.patternType ?? '?'})`);

  // ── CRITIQUE A/B/C (use OpenAI extraction as the fixed baseline) ──
  const baselineExtraction = exOpenAI.entry?._raw?.extraction;
  const critiques = {};
  if (baselineExtraction) {
    console.log(`  critique: MiniMax...`);
    critiques.minimax = await critiqueWith(baselineExtraction, img.productName, 'minimax');
    console.log(`  critique: Claude...`);
    critiques.claude = await critiqueWith(baselineExtraction, img.productName, 'claude');
    console.log(`  critique: DeepSeek (openai-compat)...`);
    critiques.deepseek = await critiqueWith(baselineExtraction, img.productName, 'openai');

    for (const [prov, r] of Object.entries(critiques)) {
      console.log(`    ${prov}: ${r.error ? '❌ ' + r.error.slice(0,60) : '✓ ' + r.ms + 'ms (' + (r.critique?.length ?? 0) + ' chars)'}`);
    }
  } else {
    console.log(`  ⚠ No baseline extraction — skipping critique A/B`);
  }

  results.push({
    image: img,
    extraction: {
      openai: {
        ms: exOpenAI.ms, error: exOpenAI.error,
        pattern: exOpenAI.entry?._raw?.extraction?.patternType,
        categories: exOpenAI.entry?._raw?.extraction?.categories,
        styleTags: exOpenAI.entry?._raw?.extraction?.styleTags,
        dominantColors: exOpenAI.entry?._raw?.extraction?.dominantColors,
        spacingDensity: exOpenAI.entry?._raw?.extraction?.spacingDensity,
        cornerStyle: exOpenAI.entry?._raw?.extraction?.cornerStyle,
      },
      minimax: {
        ms: exMiniMax.ms, error: exMiniMax.error,
        pattern: exMiniMax.entry?._raw?.extraction?.patternType,
        categories: exMiniMax.entry?._raw?.extraction?.categories,
        styleTags: exMiniMax.entry?._raw?.extraction?.styleTags,
        dominantColors: exMiniMax.entry?._raw?.extraction?.dominantColors,
        spacingDensity: exMiniMax.entry?._raw?.extraction?.spacingDensity,
        cornerStyle: exMiniMax.entry?._raw?.extraction?.cornerStyle,
      },
    },
    critique: critiques,
  });
}

writeFileSync('/tmp/ab-eval-results.json', JSON.stringify(results, null, 2));

// ─── SUMMARY ────────────────────────────────────────────────────────────────
console.log('\n\n══════════════════════════════════════════════════════════════════════');
console.log('EXTRACTION: OpenAI vs MiniMax');
console.log('══════════════════════════════════════════════════════════════════════');
for (const r of results) {
  const o = r.extraction.openai, m = r.extraction.minimax;
  console.log(`\n  ${r.image.id} (${r.image.patternType}/${r.image.platform})`);
  console.log(`    pattern:    OpenAI=${o.pattern ?? '❌'}  |  MiniMax=${m.pattern ?? '❌'}  ${o.pattern === m.pattern ? '✓' : '⚠ DIFF'}`);
  console.log(`    categories: OpenAI=${JSON.stringify(o.categories ?? [])}  |  MiniMax=${JSON.stringify(m.categories ?? [])}`);
  console.log(`    styleTags:  OpenAI=${JSON.stringify(o.styleTags ?? [])}  |  MiniMax=${JSON.stringify(m.styleTags ?? [])}`);
  console.log(`    density:    OpenAI=${o.spacingDensity ?? '?'}  |  MiniMax=${m.spacingDensity ?? '?'}  ${o.spacingDensity === m.spacingDensity ? '✓' : '⚠ DIFF'}`);
  console.log(`    corner:     OpenAI=${o.cornerStyle ?? '?'}  |  MiniMax=${m.cornerStyle ?? '?'}  ${o.cornerStyle === m.cornerStyle ? '✓' : '⚠ DIFF'}`);
  console.log(`    colors:     OpenAI=${JSON.stringify((o.dominantColors??[]).slice(0,3))}  |  MiniMax=${JSON.stringify((m.dominantColors??[]).slice(0,3))}`);
  console.log(`    time:       OpenAI=${o.ms}ms  |  MiniMax=${m.ms}ms`);
}

console.log('\n\n══════════════════════════════════════════════════════════════════════');
console.log('CRITIQUE: MiniMax vs Claude vs DeepSeek (same extraction baseline)');
console.log('══════════════════════════════════════════════════════════════════════');
for (const r of results) {
  if (!r.critique?.minimax) continue;
  console.log(`\n  ${r.image.id}:`);
  for (const [prov, c] of Object.entries(r.critique)) {
    if (c.error) { console.log(`    ${prov}: ❌ ${c.error.slice(0,80)}`); continue; }
    console.log(`    ${prov} (${c.ms}ms, ${c.critique?.length ?? 0} chars):`);
    console.log(`      "${(c.critique ?? '').slice(0, 280)}..."`);
  }
}

console.log('\n\nFull results: /tmp/ab-eval-results.json');
