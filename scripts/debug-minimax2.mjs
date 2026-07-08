// Debug v2: use the ACTUAL buildCritiquePrompt + callOpenAICompatible path
// to reproduce the 136-char failure, then compare thinking ON vs OFF.
import { tagImage, generateCritique } from '../dist/tagger.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('../dist/env.js');

const images = JSON.parse(readFileSync('/tmp/ab-eval-images.json', 'utf-8'));
// Test the 3 that failed: sample (0), cowrywise (2), origin (4)
const failIdx = [0, 2, 4];

for (const idx of failIdx) {
  const img = images[idx];
  console.log(`\n=== ${img.id} ===`);

  // Get extraction
  const ex = await tagImage({
    imagePath: resolve('corpus', img.path),
    productName: img.productName, url: img.url,
    imageDetail: 'low', extractionOnly: true,
  });

  // Run critique via the actual tagger (thinking ON — current default for minimax critique)
  console.log('  [thinking ON] via generateCritique...');
  const t0 = Date.now();
  try {
    const c1 = await generateCritique(img.productName, ex._raw.extraction, 'minimax');
    console.log(`  ✓ ${c1.critique.length} chars (${Date.now()-t0}ms)`);
    if (c1.critique.length < 200) console.log('  SHORT:', c1.critique.slice(0,150));
  } catch (e) {
    console.log('  ❌', e.message.slice(0, 100));
  }

  // Now disable thinking via env and retry
  console.log('  [thinking OFF] via env override...');
  process.env.OPENAI_THINKING_DISABLED = '1';
  const t1 = Date.now();
  try {
    const c2 = await generateCritique(img.productName, ex._raw.extraction, 'minimax');
    console.log(`  ✓ ${c2.critique.length} chars (${Date.now()-t1}ms)`);
    if (c2.critique.length < 200) console.log('  SHORT:', c2.critique.slice(0,150));
    else console.log('  FULL:', c2.critique.slice(0, 150));
  } catch (e) {
    console.log('  ❌', e.message.slice(0, 100));
  }
  delete process.env.OPENAI_THINKING_DISABLED;
}
