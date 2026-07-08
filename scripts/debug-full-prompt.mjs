// Capture raw responses using the ACTUAL full buildCritiquePrompt from the tagger
import { tagImage } from '../dist/tagger.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('../dist/env.js');

const key = process.env.MINIMAX_API_KEY;
const base = process.env.MINIMAX_BASE_URL;

const images = JSON.parse(readFileSync('/tmp/ab-eval-images.json', 'utf-8'));
const img = images[0];

const ex = await tagImage({
  imagePath: resolve('corpus', img.path),
  productName: img.productName, url: img.url,
  imageDetail: 'low', extractionOnly: true,
});

// Get the actual system prompt + critique prompt the tagger uses
const SYSTEM = "You are a UI/UX design curator..."; // tagger's actual system prompt
// We need the real prompt — let me extract it from the module
// The generateCritique function calls callModel("critique", buildCritiquePrompt(...), ...)
// which prepends the SYSTEM constant. Let me just call generateCritique and capture
// what goes wrong by also doing a raw fetch with the same content.

// Instead, let's directly call generateCritique 5x and see the pattern
console.log('=== 5 runs via generateCritique (full tagger prompt) ===\n');
for (let i = 0; i < 5; i++) {
  const t0 = Date.now();
  try {
    const c = await generateCritiqueWrapper(img.productName, ex._raw.extraction);
    console.log(`run ${i+1}: ${c.critique.length} chars (${Date.now()-t0}ms) ${c.critique.length < 200 ? '⚠ SHORT' : '✓'}`);
    if (c.critique.length < 200) console.log(`  "${c.critique.slice(0,120)}"`);
  } catch(e) {
    console.log(`run ${i+1}: ❌ ${e.message.slice(0,100)} (${Date.now()-t0}ms)`);
  }
}

// Wrapper that calls generateCritique the same way the tagger does
async function generateCritiqueWrapper(productName, extraction) {
  const { generateCritique } = await import('../dist/tagger.js');
  return generateCritique(productName, extraction, 'minimax');
}
