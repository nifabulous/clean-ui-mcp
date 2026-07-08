// Debug: capture the raw MiniMax critique response for the 3 failing images
// to see whether thinking tokens are consuming the output budget.
import { tagImage } from '../dist/tagger.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('../dist/env.js');
const key = process.env.MINIMAX_API_KEY;
const base = process.env.MINIMAX_BASE_URL;

const images = JSON.parse(readFileSync('/tmp/ab-eval-images.json', 'utf-8'));
// The 3 that failed: sample (0), cowrywise (2), origin (4)
const failIndices = [0, 2, 4];

for (const idx of failIndices) {
  const img = images[idx];
  console.log(`\n=== ${img.id} (${img.patternType}) ===`);

  // Get baseline extraction first
  const ex = await tagImage({
    imagePath: resolve('corpus', img.path),
    productName: img.productName, url: img.url,
    imageDetail: 'low', extractionOnly: true,
  });

  // Build a minimal critique prompt (same structure as buildCritiquePrompt)
  const extraction = ex._raw?.extraction;
  if (!extraction) { console.log('  no extraction'); continue; }

  // Send directly to MiniMax with full debug — capture thinking tokens
  const prompt = `You are a UI design critic. Given these extraction facts about a screenshot, write a critique JSON.

Product: ${img.productName}
Pattern: ${extraction.patternType}
Categories: ${JSON.stringify(extraction.categories)}
Colors: ${JSON.stringify(extraction.dominantColors)}
Density: ${extraction.spacingDensity}

Return ONLY this JSON:
{"draftCritique": "3-5 sentences naming DECISION + EFFECT + REJECTION for notable choices",
 "draftWhatToSteal": ["3-5 copyable techniques"],
 "draftAntiPatterns": ["1-2 mistakes avoided"]}`;

  const body = {
    model: 'MiniMax-M3',
    messages: [
      { role: 'system', content: 'You are a UI design expert. Return ONLY valid JSON.' },
      { role: 'user', content: prompt },
    ],
    max_tokens: 8192,
    thinking: { type: 'adaptive' },
    reasoning_split: true,
  };

  const resp = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    console.log('  API error:', resp.status, (await resp.text()).slice(0, 200));
    continue;
  }

  const data = await resp.json();
  console.log('  usage:', JSON.stringify(data.usage));
  console.log('  finish_reason:', data.choices?.[0]?.finish_reason);
  console.log('  has reasoning_content:', !!data.choices?.[0]?.message?.reasoning_content);
  console.log('  reasoning length:', data.choices?.[0]?.message?.reasoning_content?.length ?? 0);
  console.log('  content length:', data.choices?.[0]?.message?.content?.length ?? 0);
  console.log('  content preview:', (data.choices?.[0]?.message?.content ?? '').slice(0, 300));

  // Now try with thinking DISABLED to compare
  console.log('\n  --- retry with thinking DISABLED ---');
  const resp2 = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, thinking: { type: 'disabled' }, reasoning_split: undefined }),
  });
  if (resp2.ok) {
    const data2 = await resp2.json();
    console.log('  usage:', JSON.stringify(data2.usage));
    console.log('  finish_reason:', data2.choices?.[0]?.finish_reason);
    console.log('  content length:', data2.choices?.[0]?.message?.content?.length ?? 0);
    console.log('  content preview:', (data2.choices?.[0]?.message?.content ?? '').slice(0, 300));
  }
}
