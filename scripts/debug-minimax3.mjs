// Run the same image 3× to confirm the 136-char failure is intermittent.
import { tagImage, generateCritique } from '../dist/tagger.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('../dist/env.js');

const images = JSON.parse(readFileSync('/tmp/ab-eval-images.json', 'utf-8'));
const img = images[0]; // sample dashboard — failed in eval #1, worked in eval #2
console.log(`=== ${img.id} × 3 runs ===\n`);

const ex = await tagImage({
  imagePath: resolve('corpus', img.path),
  productName: img.productName, url: img.url,
  imageDetail: 'low', extractionOnly: true,
});

for (let i = 0; i < 3; i++) {
  const t0 = Date.now();
  try {
    const c = await generateCritique(img.productName, ex._raw.extraction, 'minimax');
    const short = c.critique.length < 200;
    console.log(`  run ${i+1}: ${c.critique.length} chars (${Date.now()-t0}ms) ${short ? '⚠ SHORT (the bug)' : '✓ full'}`);
    if (short) console.log(`    "${c.critique.slice(0,120)}"`);
  } catch (e) {
    console.log(`  run ${i+1}: ❌ ${e.message.slice(0,80)} (${Date.now()-t0}ms)`);
  }
}
