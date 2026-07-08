const targets = [
  { name: 'Origin', path: 'images-private/sample-5.png' },
  { name: 'Hume',   path: 'images-private/hume-ai-web-apr-2026-2-5.png' },
];
const BANNED = ["clean layout","modern design","user-friendly","intuitive","sleek","minimalist","good spacing","nice typography","visually appealing","easy to use","well-organized","polished look"];
const strip = s => (s||'').replace(/^\[DRAFT[^\]]*\]\s*/i,'');
const wc = s => s.trim().split(/\s+/).length;
const banned = c => {
  const all=[c.critique,...c.whatToSteal,...c.antiPatterns.antiPatterns].join(' ').toLowerCase();
  return BANNED.filter(b=>all.includes(b));
};
for (const t of targets) {
  console.log('\n' + '='.repeat(72));
  console.log(`TARGET: ${t.name} — ${t.path}`);
  console.log('='.repeat(72));
  const start = Date.now();
  const r = await fetch('http://localhost:3131/api/auto-tag', {
    method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ imagePath: t.path, productName: t.name, url: null, imageDetail:'high' }),
  });
  const ms = Date.now() - start;
  const d = await r.json();
  if(!r.ok){ console.log('FAILED ('+ms+'ms):', JSON.stringify(d).slice(0,500)); continue; }
  const e = d.entry;
  console.log(`\n[${process.env.AB_LABEL}] critique (${wc(e.critique)}w, ${ms}ms):`);
  console.log(strip(e.critique));
  console.log(`\n[${process.env.AB_LABEL}] whatToSteal:`);
  e.whatToSteal.forEach((s,i)=>console.log(`  ${i+1}. ${strip(s)}`));
  console.log(`\n[${process.env.AB_LABEL}] antiPatterns:`);
  e.antiPatterns.antiPatterns.forEach((s,i)=>console.log(`  ${i+1}. ${strip(s)}`));
  if(e.antiPatterns.accessibilityRisks?.length) {
    console.log(`\n[${process.env.AB_LABEL}] accessibilityRisks:`);
    e.antiPatterns.accessibilityRisks.forEach((s,i)=>console.log(`  ${i+1}. ${strip(s)}`));
  }
  const h = banned({critique:e.critique,whatToSteal:e.whatToSteal,antiPatterns:e.antiPatterns});
  console.log(`\n[${process.env.AB_LABEL}] banned-phrase hits: ${h.length?h.join(', '):'(none ✓)'}`);
  console.log(`[${process.env.AB_LABEL}] patternType: ${e.patternType} | domainTags: ${JSON.stringify(e.domainTags||[])} | components: ${(e.components||[]).slice(0,4).join(', ')}...`);
  console.log(`[${process.env.AB_LABEL}] tier: ${e.qualityTier} | score: ${e.qualityScore} | bodyFont: ${e.visual?.typePairing?.body||'(null)'}`);
}
