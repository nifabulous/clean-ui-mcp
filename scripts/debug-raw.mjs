// Capture the RAW MiniMax response when the bug hits — is the JSON truncated
// (token budget) or is it complete-but-lazy (model behavior)?
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('../dist/env.js');

const key = process.env.MINIMAX_API_KEY;
const base = process.env.MINIMAX_BASE_URL;

const images = JSON.parse(readFileSync('/tmp/ab-eval-images.json', 'utf-8'));
const img = images[0];

// Get extraction
const { tagImage } = await import('../dist/tagger.js');
const ex = await tagImage({
  imagePath: resolve('corpus', img.path),
  productName: img.productName, url: img.url,
  imageDetail: 'low', extractionOnly: true,
});
const extraction = ex._raw.extraction;

// Build the SAME prompt the tagger uses
const prompt = `Here is the VALIDATED structural extraction for ${img.productName} (treat every value as established fact):
${JSON.stringify(extraction, null, 2)}

Step 2 — Return this JSON:
{"draftCritique": "3-5 sentences", "draftWhatToSteal": ["3-5 items"], "draftAntiPatterns": ["1-2 items"]}`;

// Run 5 times, capture raw responses
for (let i = 0; i < 5; i++) {
  const resp = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'MiniMax-M3',
      messages: [
        { role: 'system', content: 'Return ONLY valid JSON.' },
        { role: 'user', content: prompt },
      ],
      max_completion_tokens: 8192,
      thinking: { type: 'adaptive' },
      reasoning_split: true,
    }),
  });
  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content || '';
  const finish = data.choices?.[0]?.finish_reason;
  const usage = data.usage;
  const reasoning = data.choices?.[0]?.message?.reasoning_content || '';
  console.log(`run ${i+1}: finish=${finish} content=${content.length}chars reasoning=${reasoning.length}chars completion_tokens=${usage?.completion_tokens} reasoning_tokens=${usage?.completion_tokens_details?.reasoning_tokens}`);
  if (content.length < 300) {
    console.log(`  RAW CONTENT: ${content.slice(0,250)}`);
  }
}
