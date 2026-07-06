/* ============================================================
   CLEAN-UI CORPUS CONSOLE — SPA logic, live-API edition
   Adapted from the specimen-ledger reference: keeps the router,
   nav, and component structure; replaces the mock corpus-data.js
   with live fetches to the curator API and maps our real schema.
   ============================================================ */
(function(){
'use strict';

const API = ''; // same-origin
let E = [];     // entries (live, mapped to the shape components expect)
let SCHEMA = { categories: [], styleTags: [], patternTypes: [], spacingDensities: [], cornerStyles: [], imageVisibilities: [] };
let HEALTH = { entryCount: 0, snapshotCount: 0, newestSnapshotEpoch: null, newestSnapshotAgeMs: null };
let CONFIG = {};

// ─── draft state (shared across add/edit/capture-promote flows) ──────────────
// Replaces the old local addDraft variable. The full form (#/edit), the
// capture-triage promote action, and the SPA's capture/upload wizard all flow
// through one draft object so the form renders + validation + save path is
// identical regardless of how the draft was seeded.
const blankDraft = () => ({
  id: '',
  title: '',
  patternType: '',
  platform: '',
  categories: [],
  styleTags: [],
  source: { productName:'', url:'', capturedAt:'', capturedBy:'self', lastVerified:'' },
  image: { visibility:'private', path:null, width:null, height:null },
  visual: { dominantColors:[], accentColor:null, colorRoles:{canvas:'',surface:'',ink:'',muted:'',accent:''}, typePairing:{display:'',body:'',notes:''}, spacingDensity:'moderate', cornerStyle:'slight-round', usesShadows:false, usesBorders:true },
  critique: '',
  whatToSteal: [],
  antiPatterns: { antiPatterns:[], whereThisFails:[], accessibilityRisks:[] },
  voice: { tone:'', examples:[], avoid:[] },
  layout: null,
  qualityTier: 'exceptional',
  qualityScore: 3,
  reviewStatus: 'approved',
  provenance: null,
  // Form-internal state (not saved): the entry being edited (null = new entry),
  // busy/error messages for the capture/auto-fill wizard, and the active
  // source tab ('capture' | 'upload').
  _editing: null,
  _busy: null,
  _error: null,
  _tab: 'capture',
  _pendingCapture: null, // {batchId, captureId} — set by promoteCapture, cleared on save
  // Multi-candidate capture session (Add flow). After /api/capture-candidates,
  // _candidates holds the detected screenshots; the user checks some via
  // _selectedCandidates, and tagSelected() walks them one at a time, advancing
  // _activeCandidateIndex. The server promotes temp→permanent at save time.
  _addBatchId: null,             // temp batch dir (captures/add-*), for cleanup
  _candidates: null,             // Array<CaptureMeta> | null
  _candidateStatus: null,        // Map<index, 'drafted'|'tagging'|'saved'|'duplicate'|'error'|'skipped'>
  _selectedCandidates: null,     // Set<index> — chosen by the user
  _activeCandidateIndex: null,   // index currently being tagged, or null when no session active
});
let draft = blankDraft();
function resetDraft(entry=null){
  draft = entry ? JSON.parse(JSON.stringify(entry)) : blankDraft();
  draft._editing = entry ? (entry.id||null) : null;
  draft._busy = null; draft._error = null; draft._tab = 'capture'; draft._pendingCapture = null;
  // Multi-candidate session state — always cleared on reset (a cloned entry
  // won't carry these; a blankDraft already has them null).
  draft._addBatchId = null; draft._candidates = null; draft._candidateStatus = null;
  draft._selectedCandidates = null; draft._activeCandidateIndex = null;
}

/* ---------- field mapper: our CorpusEntry → the shape components expect ----------
   The reference components read x.source, x.pattern, x.style, x.dominant, x.accent,
   x.score, x.tier, x.steals. Our schema has nested objects. This maps once at load. */
function mapEntry(entry) {
  return {
    id: entry.id,
    title: entry.title,
    source: entry.source.productName,
    sourceUrl: entry.source.url,
    pattern: entry.patternType,
    style: entry.styleTags[0] || 'minimal',
    styles: entry.styleTags,
    categories: entry.categories,
    tier: entry.qualityTier || 'exceptional',
    score: entry.qualityScore,
    steals: (entry.whatToSteal || []).length,
    stealsList: entry.whatToSteal || [],
    anti: (entry.antiPatterns?.antiPatterns || []).length,
    antiList: entry.antiPatterns?.antiPatterns || [],
    whereFails: entry.antiPatterns?.whereThisFails || [],
    a11yRisks: entry.antiPatterns?.accessibilityRisks || [],
    dominant: entry.visual?.dominantColors || ['#ffffff','#f1f3f6','#0f172a'],
    accent: entry.visual?.accentColor || entry.visual?.colorRoles?.accent || '#2f5d62',
    colorRoles: entry.visual?.colorRoles || null,
    density: entry.visual?.spacingDensity || 'moderate',
    corner: entry.visual?.cornerStyle || 'slight-round',
    shadows: entry.visual?.usesShadows || false,
    borders: entry.visual?.usesBorders || true,
    typeNotes: entry.visual?.typePairing?.notes || '',
    critique: entry.critique,
    voice: entry.voice || null,
    layout: entry.layout || null,
    added: entry.addedAt,
    imagePath: entry.image?.path || null,
    imageW: entry.image?.width || null,
    imageH: entry.image?.height || null,
    imageVis: entry.image?.visibility || 'private',
    // Real-capture indicator — single existence check on provenance.capture.
    // Lets a curator scanning the gallery distinguish "this is real evidence"
    // from "this is a wireframe reconstructed from color data" at a glance.
    capture: !!entry.provenance?.capture,
    platform: entry.platform || 'web',
    reviewStatus: entry.reviewStatus || 'approved',
    provenance: entry.provenance || null,
    lastVerified: entry.source?.lastVerified || entry.source?.capturedAt,
    // keep the raw entry for the edit/wizard path
    _raw: entry,
  };
}

/* ---------- live data layer ---------- */
async function loadAll() {
  const [entriesRes, schemaRes, healthRes, configRes] = await Promise.all([
    fetch(`${API}/api/entries`).then(r => r.json()).catch(() => ({ entries: [] })),
    fetch(`${API}/api/schema`).then(r => r.json()).catch(() => SCHEMA),
    fetch(`${API}/api/health`).then(r => r.json()).catch(() => HEALTH),
    fetch(`${API}/api/config`).then(r => r.json()).catch(() => ({})),
  ]);
  E = (entriesRes.entries || []).map(mapEntry);
  SCHEMA = schemaRes;
  HEALTH = healthRes;
  CONFIG = configRes;
  return { E, SCHEMA, HEALTH, CONFIG };
}

/* ---------- precomputed aggregates (from live E) ---------- */
let agg = {};
function recomputeAgg() {
  const N = E.length;
  const byPattern={}, byStyle={}, bySource={}, byTier={}, byCat={}, byScore={}, byPlatform={};
  let stealsSum=0, antiSum=0, dates=[];
  for(const x of E){
    byPattern[x.pattern]=(byPattern[x.pattern]||0)+1;
    byStyle[x.style]=(byStyle[x.style]||0)+1;
    bySource[x.source]=(bySource[x.source]||0)+1;
    byTier[x.tier]=(byTier[x.tier]||0)+1;
    byPlatform[x.platform]=(byPlatform[x.platform]||0)+1;
    for(const c of x.categories) byCat[c]=(byCat[c]||0)+1;
    if(x.score!=null) byScore[x.score]=(byScore[x.score]||0)+1;
    stealsSum+=x.steals||0; antiSum+=x.anti||0;
    if(x.added&&x.added!=='—') dates.push(x.added);
  }
  dates.sort();
  const scoreSum=Object.entries(byScore).reduce((s,[k,v])=>s+(+k)*v,0);
  const scoreN=Object.values(byScore).reduce((a,b)=>a+b,0);
  const top=(o,n)=>Object.entries(o).sort((a,b)=>b[1]-a[1]).slice(0,n);
  agg = {
    N, byPattern,byStyle,bySource,byTier,byCat,byScore,byPlatform,
    avgScore: scoreN? scoreSum/scoreN : 0,
    avgSteals: N? stealsSum/N : 0, avgAnti: N? antiSum/N : 0,
    dates,
    topPatterns: top(byPattern,8), topStyles: top(byStyle,8), topSources: top(bySource,10), topCats: top(byCat,8),
    excCount: byTier.exceptional||0, cauCount: byTier.cautionary||0,
    mobileCount: byPlatform.mobile||0, webCount: byPlatform.web||0, tabletCount: byPlatform.tablet||0,
    withImages: E.filter(x=>x.imagePath).length,
  };
}

/* ---------- multi-select + bulk tier management ----------
   Selection is a session-scoped Set<id> (NOT localStorage — favorites are
   persistent; selection is a transient working set). It survives pagination
   and filter changes so you can gather entries across pages and act on them
   together. Only the explicit Clear button (or a successful bulk action)
   empties it. Promote = → exceptional; Reject = → cautionary (reversible). */
const selection = new Set();
const isSelected = (id) => selection.has(id);
function toggleSelect(id){ selection.has(id) ? selection.delete(id) : selection.add(id); }
function clearSelection(){ selection.clear(); }

// Capture-triage state. Batches live on disk and change between visits, so the
// #/capture page reloads on each entry (mirrors the classic workbench). Loaded
// lazily on first render of the page; Refresh button re-loads on demand.
let captureBatches = [];
let captureBatchesLoaded = false;
async function loadCaptureBatches(){
  try {
    const j = await request('/api/capture-batches');
    captureBatches = j.batches || [];
  } catch(e){ captureBatches = []; }
  captureBatchesLoaded = true;
}

// Change one entry's tier via full-entry PUT (server validates the whole
// object, so we send the raw entry with qualityTier mutated). Returns true on
// success. Reads from the in-memory _raw so no extra fetch is needed.
async function setTier(id, tier){
  const x = E.find(e => e.id === id);
  if(!x || !x._raw) return false;
  const body = JSON.parse(JSON.stringify(x._raw)); // full entry, no shared refs
  body.qualityTier = tier;
  if(tier === 'cautionary' && (body.qualityScore ?? 5) > 2) body.qualityScore = 2;
  if(tier === 'exceptional' && (body.qualityScore ?? 0) < 3) body.qualityScore = 3;
  const r = await fetch(`${API}/api/entries/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return r.ok;
}

// Apply a tier to many ids with a small concurrency pool. Reports per-outcome
// counts, refreshes E from the server, and re-renders so tier pills + the
// tier-filter chips' counts stay accurate. Selection is cleared on success.
async function setTierMany(ids, tier){
  const label = tier === 'exceptional' ? 'promoted' : 'rejected';
  let ok = 0, fail = 0;
  const queue = ids.slice();
  async function worker(){
    while(queue.length){
      const id = queue.shift();
      if(await setTier(id, tier)) ok++; else fail++;
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  await loadAll(); recomputeAgg();
  toast(`${ok} ${label}${fail ? `; ${fail} failed` : ''}`, ok ? '' : 'error');
  if(ok) clearSelection();
  refreshActivePage();
}

/* ---------- source color hash (stable across pages) ---------- */
function srcColor(s){
  let h=0; for(let i=0;i<s.length;i++) h=(h*31+s.charCodeAt(i))>>>0;
  return `hsl(${h%360} 55% 45%)`;
}
function tierPill(t){
  return t==='exceptional'
    ? `<span class="tier-pill exc">Exceptional</span>`
    : `<span class="tier-pill cau">Cautionary</span>`;
}
function scoreBar(s){
  let b=''; for(let i=1;i<=5;i++){
    const cls=i<=s?(s<=2?'on low':s===3?'on mid':'on'):'';
    b+=`<i class="${cls}"></i>`;
  }
  return `<span class="score-bar">${b}</span>`;
}
function gscore(s){
  let b=''; for(let i=1;i<=5;i++){
    const cls=i<=s?(s<=2?'on low':s===3?'on mid':'on'):'';
    b+=`<i class="${cls}"></i>`;
  }
  return `<span class="gscore">${b}</span>`;
}

/* ============================================================
   NAV — expandable groups, hash route active state
   ============================================================ */
const NAV = [
  { group:'Corpus', items:[
    {id:'overview',  label:'Overview',     icon:'overview'},
    {id:'entries',   label:'Entries',      icon:'entries'},
    {id:'add',       label:'Add entry',    icon:'plus'},
    {id:'bulk',      label:'Bulk import',  icon:'bulk'},
    {id:'sources',   label:'Sources',      icon:'circle'},
    {id:'capture',   label:'Capture triage', icon:'circle'},
  ]},
  { group:'Query layer', items:[
    {id:'search',    label:'Search index',  icon:'search'},
    {id:'embeddings',label:'Embeddings',    icon:'nodes'},
    {id:'compare',   label:'Compare',       icon:'gitcompare'},
  ]},
  { group:'Curation', items:[
    {id:'quality',   label:'Quality',       icon:'star'},
    {id:'settings',  label:'Settings',      icon:'gear'},
  ]},
];
const IC = {
  overview:'<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  entries:'<path d="M3 6h18M3 12h18M3 18h18"/>',
  search:'<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  nodes:'<circle cx="6" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/><circle cx="12" cy="12" r="2"/><path d="M8 6h8M8 18h8M6 8v8M18 8v8"/>',
  gitcompare:'<circle cx="6" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><path d="M6 8v6a4 4 0 004 4h4M18 16V10a4 4 0 00-4-4H10"/>',
  star:'<path d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z"/>',
  gear:'<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 00-.1-1l2-1.5-2-3.4-2.3 1a7 7 0 00-1.7-1l-.4-2.6h-4l-.4 2.6a7 7 0 00-1.7 1l-2.3-1-2 3.4 2 1.5a7 7 0 000 2l-2 1.5 2 3.4 2.3-1a7 7 0 001.7 1l.4 2.6h4l.4-2.6a7 7 0 001.7-1l2.3 1 2-3.4-2-1.5c.06-.33.1-.66.1-1z"/>',
  circle:'<circle cx="12" cy="12" r="9"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  bulk:'<path d="M3 7h18M3 12h18M3 17h12"/>',
};
function renderNav(){
  const groups = NAV.map((g,gi)=>{
    const items = g.items.map(it=>{
      const cnt = it.id==='entries' ? `<span class="count">${agg.N||0}</span>`
                : it.id==='sources' ? `<span class="count">${Object.keys(agg.bySource||{}).length||0}</span>`
                : '';
      return `<a class="nav-item" data-route="${it.id}" href="#/${it.id}">
        <span class="ic"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${IC[it.icon]||''}</svg></span>
        <span class="lbl">${it.label}</span>${cnt}
      </a>`;
    }).join('');
    return `<div class="nav-group ${gi===0?'open':''}" data-group="${gi}">
      <div class="group-head">
        <svg class="group-chev" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
        <span class="group-label">${g.group}</span>
      </div>
      <div class="nav-children">${items}</div>
    </div>`;
  }).join('');
  document.getElementById('navScroll').innerHTML = groups;
  document.querySelectorAll('.group-head').forEach(gh=>{
    gh.addEventListener('click',()=>gh.parentElement.classList.toggle('open'));
  });
  // sidebar footer: index + recovery
  document.getElementById('footIndex').textContent = `${agg.N||0} / ${agg.N||0}`;
  const ageMs = HEALTH.newestSnapshotAgeMs;
  const ageLabel = ageMs!=null ? (ageMs<3600000?Math.round(ageMs/60000)+'m':Math.round(ageMs/3600000)+'h') : '?';
  document.getElementById('footRecovery').innerHTML = HEALTH.snapshotCount
    ? `snapshots: <code>${HEALTH.snapshotCount}</code> · newest ${ageLabel}`
    : `no snapshots yet`;
}

/* ============================================================
   ROUTER
   ============================================================ */
const PAGES = {};
function page(id, title, crumb, render, after){ PAGES[id] = {title, crumb, render, after}; }
let currentRoute = 'overview';
function route(){
  const h = location.hash.replace(/^#\/?/,'') || 'overview';
  const id = PAGES[h] ? h : 'overview';
  currentRoute = id;
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.toggle('active', n.dataset.route===id));
  const p = PAGES[id];
  document.getElementById('pageTitle').textContent = p.title;
  document.getElementById('pageCrumb').textContent = p.crumb;
  document.getElementById('pages').innerHTML = `<div class="page active" id="page-${id}">${p.render()}</div>`;
  document.querySelector('.main').scrollTop = 0;
  if(p.after) p.after();
  closeDetail();
  renderSelectionBar();
}
// Re-render the active page after a data change (e.g. bulk tier update).
function refreshActivePage(){ route(); }

/* ---------- selection action bar ---------- */
function renderSelectionBar(){
  const bar = document.getElementById('bulkBar');
  const count = document.getElementById('bulkCount');
  if(!bar || !count) return;
  const n = selection.size;
  if(n > 0 && currentRoute === 'entries'){
    bar.style.display = 'flex';
    count.textContent = `${n} selected`;
  } else {
    bar.style.display = 'none';
  }
}
// Toggle a row's selection, update its DOM, and refresh the bar — without a
// full re-render so the user doesn't lose scroll/pagination position.
function toggleRowSelection(id){
  toggleSelect(id);
  document.querySelectorAll(`.row-sel[data-id="${cssEsc(id)}"]`).forEach(cb => {
    cb.checked = isSelected(id);
    const tr = cb.closest('tr'); if(tr) tr.classList.toggle('sel', cb.checked);
    const lbl = cb.closest('.sel-btn'); if(lbl) lbl.classList.toggle('on', cb.checked);
    const card = cb.closest('.gcard'); if(card) card.classList.toggle('is-sel', cb.checked);
  });
  // refresh the select-all header checkbox state too
  const sa = document.getElementById('selAll');
  if(sa){
    const vis = Array.from(document.querySelectorAll('#entryTable tbody .row-sel')).map(cb=>cb.dataset.id);
    sa.checked = vis.length>0 && vis.every(x=>isSelected(x));
  }
  renderSelectionBar();
}
// Minimal CSS.escape polyfill for selector safety (ids may contain chars that
// break attribute selectors). Standard in modern browsers; guarded for old ones.
function cssEsc(s){ return (window.CSS&&CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g,'\\$&'); }

function bindBulkBar(){
  const bar = document.getElementById('bulkBar');
  if(!bar || bar._bound) return;
  bar._bound = true;
  document.getElementById('bulkPromote').addEventListener('click', () => {
    if(!selection.size) return;
    setTierMany([...selection], 'exceptional').then(refreshActivePage);
  });
  document.getElementById('bulkReject').addEventListener('click', () => {
    if(!selection.size) return;
    setTierMany([...selection], 'cautionary').then(refreshActivePage);
  });
  document.getElementById('bulkClear').addEventListener('click', () => {
    clearSelection(); refreshActivePage();
  });
}

/* ============================================================
   SHARED WIDGETS
   ============================================================ */
function kpi(val,unit,label,dotCls,subHtml){
  return `<div class="kpi">
    <div class="val num">${val}${unit?`<span class="u">${unit}</span>`:''}</div>
    <div class="lab"><span class="dot ${dotCls||''}"></span><span class="lbl">${label}</span></div>
    <div class="sub">${subHtml||''}</div>
  </div>`;
}
function distRows(arr,max,colorFn){
  return arr.map(([name,v])=>`<div class="dist-row">
    <span class="nm" title="${name}">${name}</span>
    <span class="track"><div style="width:${max?((v/max*100).toFixed(0)):0}%;background:${colorFn?colorFn(name):'var(--accent)'}"></div></span>
    <span class="v">${v}</span>
  </div>`).join('');
}
function toast(msg, type=''){
  const t=document.getElementById('toast');
  t.textContent=msg; t.className='on'+(type?(' '+type):'');
  clearTimeout(t._t); t._t=setTimeout(()=>t.classList.remove('on'), type==='error'?4000:2200);
  if(type==='error') console.error('[toast]', msg);
}

// ─── shared helpers (ported from classic-app.js during unification) ──────────
// These were duplicated between app.js and classic-app.js; now live here once.

const slugify = (v) => String(v||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').replace(/-{2,}/g,'-') || 'sample';
const lines = (v) => String(v||'').split('\n').map(l=>l.trim()).filter(Boolean);

// Error-aware JSON fetch. All API calls in the form/bulk/triage flows use this
// so server-side validation errors surface as thrown Errors with the server's
// message (issues array or error string) rather than silent failures.
async function request(path, options={}){
  const response = await fetch(`${API}${path}`, {
    headers: { 'content-type':'application/json', ...(options.headers||{}) },
    ...options,
  });
  const data = await response.json().catch(()=>({}));
  if(!response.ok){
    const message = (data.issues && data.issues.join('\n')) || data.error || 'Request failed';
    throw new Error(message);
  }
  return data;
}

// Draft-marker stripping — the tagger prefixes critique/steals/antiPatterns
// with [DRAFT]/[DRAFT — REWRITE] as a hygiene forcing function. The form's
// save path strips them before submit (the human review IS the rewrite gate).
// Loops until stable to catch repeated markers the model sometimes emits.
function stripDraftMarker(s){
  if(typeof s !== 'string') return s;
  let prev;
  do {
    prev = s;
    s = s.replace(/\[(?:DRAFT[^\]]*|PLACEHOLDER[^\]]*|TODO[^\]]*)\]\s*/gi, '').trim();
  } while(s !== prev);
  return s;
}
function healthRow(kind,title,desc){
  const ic = kind==='ok'?'<path d="M5 12l5 5 9-9"/>'
           : kind==='warn'?'<path d="M12 8v5M12 16v.5"/><circle cx="12" cy="12" r="9"/>'
           : '<path d="M15 9l-6 6M9 9l6 6"/><circle cx="12" cy="12" r="9"/>';
  return `<div class="check">
    <span class="ic ${kind}"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${ic}</svg></span>
    <div class="txt"><b>${title}</b><span>${desc}</span></div>
  </div>`;
}

/* entry-row renderer (shared by tables) */
function entryRow(x){
  const idParts = x.id.split('-');
  const idHead = idParts[0];
  const idTail = x.id.substring(idHead.length+1);
  const checked = isSelected(x.id) ? 'checked' : '';
  return `<tr data-id="${x.id}" ${checked?'class="sel"':''}>
    <td class="sel-cell"><input type="checkbox" class="row-sel" data-id="${x.id}" ${checked} aria-label="Select ${esc(x.id)}"></td>
    <td><span class="id" title="${x.id}"><b>${idHead}</b>${idTail?'-'+idTail:''}</span></td>
    <td><div class="src"><span class="pd" style="background:${srcColor(x.source)}"></span><span class="nm">${x.source}</span></div></td>
    <td style="color:var(--ink-2)">${x.pattern}</td>
    <td style="color:var(--ink-2)">${x.style}</td>
    <td>${tierPill(x.tier)}</td>
    <td>${scoreBar(x.score)}<span style="margin-left:6px;font-size:11px;color:var(--muted)" class="num">${x.score}/5</span></td>
    <td class="r num">${x.steals}</td>
    <td><div class="row-actions">
      <button class="row-inspect" title="Inspect"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg></button>
    </div></td>
  </tr>`;
}

/* ============================================================
   PREVIEW SYSTEM — real screenshot when available, synthesized
   wireframe as fallback for link-only entries.
   ============================================================ */
function stageShape(x){
  const w=x.imageW, h=x.imageH;
  if(!w||!h) return 'is-landscape';
  if(h>w*1.2) return 'is-portrait';
  if(w>h*1.2) return 'is-landscape';
  return 'is-square';
}
function pickInk(dom){
  if(!dom||!dom.length) return '#0f172a';
  const lum=h=>{const c=h.replace('#','');const r=parseInt(c.slice(0,2),16),g=parseInt(c.slice(2,4),16),b=parseInt(c.slice(4,6),16);return 0.299*r+0.587*g+0.114*b;};
  return dom.slice().sort((a,b)=>lum(a)-lum(b))[0];
}
function cornerR(x){ return x.corner==='pill'?'8px':x.corner==='mixed'?'4px':'3px'; }
function densityPad(x){ return x.density==='compact'?'5px':x.density==='spacious'?'10px':'7px'; }

function previewInner(x){
  const dom=x.dominant||['#ffffff','#f1f3f6','#0f172a'];
  const canvas=dom[0]||'#ffffff';
  const surface=dom[1]||canvas;
  const ink=pickInk(dom);
  const accent=x.accent||'#2f5d62';
  const r=cornerR(x);
  const pad=densityPad(x);
  const shadow = x.shadows ? `box-shadow:0 1px 3px rgba(0,0,0,.1);`:'';
  const base=`background:${canvas};color:${ink};padding:${pad};gap:${x.density==='compact'?'3px':'5px'};border-radius:${r};`;
  const sidebar=(bg)=>`<div class="pv-sidebar" style="background:${bg};color:${ink}"><i></i><i></i><i></i><i></i></div>`;
  const kpi=(bg)=>`<div class="pv-kpi" style="background:${bg}"><i></i><i></i></div>`;
  const bars=(n,c)=>Array.from({length:n},(_,i)=>`<div class="pv-bar" style="background:${c};opacity:.5;width:${40+((i*37)%55)}%"></div>`).join('');
  const P=x.pattern;
  if(P==='dashboard'){
    return `<div class="pv" style="${base}"><div class="pv-row" style="gap:5px">${sidebar(surface)}
      <div class="pv-col" style="gap:4px"><div class="pv-row" style="gap:4px">${kpi(surface)}${kpi(surface)}${kpi(surface)}</div>
      <div class="pv-block" style="background:${surface};${shadow}flex:1;padding:4px;display:flex;flex-direction:column;justify-content:flex-end;gap:2px">${bars(5,accent)}</div></div></div></div>`;
  }
  if(P==='onboarding'||P==='auth'){
    return `<div class="pv" style="${base};justify-content:center;align-items:center">
      <div class="pv-circle" style="width:18px;height:18px;background:${accent}"></div>
      <div class="pv-block" style="background:${surface};${shadow}width:75%;padding:5px;display:flex;flex-direction:column;gap:3px;align-items:center">
        <div class="pv-bar" style="background:${ink};opacity:.8;width:50%"></div><div class="pv-input"></div><div class="pv-input"></div>
        <div class="pv-btn" style="background:${accent};width:60%"></div></div>
      <div class="pv-row" style="gap:3px">${Array.from({length:4},(_,i)=>`<div class="pv-circle" style="width:4px;height:4px;background:${i===0?accent:ink};opacity:${i===0?1:.3}"></div>`).join('')}</div></div>`;
  }
  // fallback generic
  return `<div class="pv" style="${base}"><div class="pv-block" style="background:${surface};${shadow}padding:5px;display:flex;flex-direction:column;gap:3px;flex:1">
    <div class="pv-bar" style="background:${accent};width:30%"></div>${bars(4,ink)}</div></div>`;
}

/* gallery card — real screenshot if available, else wireframe */
function galleryCard(x){
  const fav=isFav(x.id);
  const sel=isSelected(x.id);
  const pal=(x.dominant||[]).slice(0,5).map(c=>`<span style="background:${c}"></span>`).join('');
  // data-img-id lets the delegated capture-phase error listener (mounted once
  // in the gallery container) re-lookup the entry and swap in the wireframe
  // fallback. No inline onerror — that path was a JSON-into-attribute bug waiting
  // to happen, and `error` doesn't bubble so a regular listener wouldn't fire.
  const thumb = x.imagePath
    ? `<img src="${API}/api/image?path=${encodeURIComponent(x.imagePath)}" alt="${esc(x.title)}" data-img-id="${esc(x.id)}" style="width:100%;height:100%;object-fit:cover;object-position:top;display:block" loading="lazy">`
    : `<div class="pv-frame">${previewInner(x)}</div>`;
  return `<div class="gcard ${fav?'is-fav':''} ${sel?'is-sel':''}" data-id="${x.id}">
    <div class="gthumb">
      <label class="sel-btn ${sel?'on':''}" title="Select">
        <input type="checkbox" class="row-sel" data-id="${x.id}" ${sel?'checked':''} aria-label="Select ${esc(x.id)}">
      </label>
      ${thumb}
      <div class="pv-actions"><button class="fav-btn ${fav?'fav-on':''}" data-id="${x.id}" title="Favorite" aria-label="Toggle favorite">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="${fav?'currentColor':'none'}" stroke="currentColor" stroke-width="2"><path d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z"/></svg>
      </button></div>
      <div class="pv-pattern">${PATTERN_ICON[x.pattern]||'▪'} ${x.pattern}</div>
      ${x.capture ? `<div class="pv-capture" title="Real screenshot from the capture pipeline"></div>` : ''}
    </div>
    <div class="gbody">
      <div class="gtitle" title="${esc(x.title)}">${esc(x.title)}</div>
      <div class="gmeta">
        <span class="src-dot" style="background:${srcColor(x.source)}"></span>
        <span class="src-name">${esc(x.source)}</span>
        <span class="added">${(x.added||'').slice(5)}</span>
      </div>
      <div class="gfoot">
        <div class="left">
          <span class="tier-dot ${x.tier==='exceptional'?'exc':'cau'}" title="${x.tier}"></span>
          ${gscore(x.score)}
          ${x.platform==='mobile'?`<span class="platform-chip mobile">mobile</span>`:x.platform==='tablet'?`<span class="platform-chip tablet">tablet</span>`:''}
        </div>
        <span style="font-size:10px;color:var(--muted);font-family:var(--mono)">${x.steals} steals</span>
      </div>
      <div class="gpal">${pal}</div>
    </div>
  </div>`;
}
const PATTERN_ICON = {
  dashboard:'▦',onboarding:'↗',auth:'🔒',forms:'≡',modal:'▢',profile:'◉',
  'data-table':'≣',search:'⌕',settings:'⚙','empty-state':'○','mobile-nav':'▤',
  navigation:'↦','editor-canvas':'✎','marketing-hero':'★','landing-page':'⌂',
  checkout:'$',notifications:'🔔'
};

/* ============================================================
   FAVORITES — localStorage
   ============================================================ */
const FAV_KEY='clean-ui-favs';
function getFavs(){ try{return JSON.parse(localStorage.getItem(FAV_KEY)||'[]')}catch{return[]} }
function isFav(id){ return getFavs().includes(id) }
function toggleFav(id){
  const f=getFavs(); const i=f.indexOf(id);
  if(i>=0){f.splice(i,1);toast('Removed from favorites')}
  else{f.push(id);toast('★ Added to favorites')}
  localStorage.setItem(FAV_KEY,JSON.stringify(f));
  return f.includes(id);
}

/* ============================================================
   DETAIL RAIL — enriched with real screenshot, palette, critique
   ============================================================ */
function openDetail(x){
  const rail=document.getElementById('detailRail');
  const fav=isFav(x.id);
  document.getElementById('detailTitle').textContent = x.id;
  const thumb = x.imagePath
    ? `<img src="${API}/api/image?path=${encodeURIComponent(x.imagePath)}" alt="${esc(x.title)}" style="display:block">`
    : previewInner(x);
  const palSwatches=(x.dominant||[]).slice(0,6).map(c=>
    `<div class="swatch" data-hex="${c}" title="Click to copy"><div class="well" style="background:${c}"></div><div class="hex">${c.toUpperCase()}</div></div>`).join('');
  const colorRolesHtml = x.colorRoles ? `
    <div class="eyebrow" style="margin:14px 0 8px">Color roles · token set</div>
    <div class="code" style="margin-bottom:14px"><span class="c">/* paste-ready */</span>
:root {
  <span class="k">--canvas</span>:  <span class="s">${x.colorRoles.canvas}</span>;
  <span class="k">--surface</span>: <span class="s">${x.colorRoles.surface}</span>;
  <span class="k">--ink</span>:     <span class="s">${x.colorRoles.ink}</span>;
  <span class="k">--muted</span>:   <span class="s">${x.colorRoles.muted||'inherit'}</span>;
  <span class="k">--accent</span>:  <span class="s">${x.colorRoles.accent}</span>;
}</div>` : '';
  const voiceHtml = x.voice ? `
    <div class="eyebrow" style="margin:14px 0 8px">Voice</div>
    <div style="font-size:12px;color:var(--ink-2);margin-bottom:6px">${esc(x.voice.tone||'')}</div>
    ${x.voice.examples?.length?`<ul style="margin:0 0 6px;padding-left:18px;font-size:11.5px;color:var(--ink-2)">${x.voice.examples.map(e=>`<li>${esc(e)}</li>`).join('')}</ul>`:''}
    ${x.voice.avoid?.length?`<div style="font-size:11px;color:var(--muted)">Avoids: ${x.voice.avoid.map(esc).join('; ')}</div>`:''}` : '';
  const stealsHtml = x.stealsList?.length ? `
    <div class="eyebrow" style="margin:14px 0 8px">What to steal</div>
    <ul style="margin:0 0 14px;padding-left:18px;font-size:12px;color:var(--ink-2);line-height:1.6">${x.stealsList.map(s=>`<li style="margin-bottom:4px">${esc(s)}</li>`).join('')}</ul>` : '';
  const antiHtml = x.antiList?.length ? `
    <div class="eyebrow" style="margin:14px 0 8px">Anti-patterns (mistakes avoided)</div>
    <ul style="margin:0 0 14px;padding-left:18px;font-size:12px;color:var(--ink-2);line-height:1.6">${x.antiList.map(s=>`<li style="margin-bottom:4px">${esc(s)}</li>`).join('')}</ul>` : '';
  const layoutHtml = x.layout?.form ? `
    <div class="eyebrow" style="margin:14px 0 8px">Layout · ${x.layout.form}</div>
    <div style="font-size:11.5px;color:var(--muted);font-family:var(--mono);margin-bottom:14px">${(x.layout.regions||[]).map(r=>`${r.role} (${r.width})`).join(' → ')}</div>` : '';
  const provHtml = x.provenance ? `<span class="provenance-tag ${x.provenance.taggedBy}">${x.provenance.taggedBy}${x.provenance.reviewedBy?' · '+x.provenance.reviewedBy:''}</span>` : '';
  const draftHtml = x.reviewStatus==='draft' ? `<span class="draft-chip">draft</span>` : '';
  const platChip = x.platform==='mobile'?'<span class="platform-chip mobile">mobile</span>':x.platform==='tablet'?'<span class="platform-chip tablet">tablet</span>':'';

  document.getElementById('detailBody').innerHTML = `
    <div class="image-stage ${stageShape(x)}" style="margin-bottom:14px">${thumb}</div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap">
      <span class="tier-dot ${x.tier==='exceptional'?'exc':'cau'}"></span>
      <span class="eyebrow" style="margin:0">${x.tier}</span>
      ${scoreBar(x.score)}
      <span class="num" style="font-size:11px;color:var(--muted);margin-left:auto">${x.score}/5</span>
      ${platChip}${draftHtml}${provHtml}
      <button class="icon-btn" id="detailFavBtn" style="width:28px;height:28px;color:${fav?'var(--accent)':'var(--ink-2)'}" title="Favorite">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="${fav?'currentColor':'none'}" stroke="currentColor" stroke-width="2"><path d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z"/></svg>
      </button>
    </div>
    <div style="font-size:13px;font-weight:600;margin-bottom:4px">${esc(x.title)}</div>
    <div style="font-size:11.5px;color:var(--ink-2);margin-bottom:14px;display:flex;align-items:center;gap:6px">
      <span style="width:7px;height:7px;border-radius:50%;background:${srcColor(x.source)};display:inline-block"></span>
      ${esc(x.source)} · <span class="mono">${x.id}</span>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:14px">
      <span class="vis-chip">pattern <span class="vl">${x.pattern}</span></span>
      <span class="vis-chip">style <span class="vl">${x.style}</span></span>
      <span class="vis-chip">density <span class="vl">${x.density}</span></span>
      <span class="vis-chip">corner <span class="vl">${x.corner}</span></span>
      <span class="vis-chip">shadows <span class="vl">${x.shadows?'yes':'no'}</span></span>
      <span class="vis-chip">steals <span class="vl">${x.steals}</span></span>
    </div>
    <div class="eyebrow" style="margin-bottom:8px">Color palette</div>
    <div class="swatch-row" style="margin-bottom:8px">${palSwatches}
      <div class="swatch" data-hex="${x.accent}" title="accent — click to copy"><div class="well" style="background:${x.accent};box-shadow:inset 0 0 0 2px var(--accent),inset 0 2px 4px rgba(0,0,0,.12)"></div><div class="hex" style="color:var(--accent)">${(x.accent||'').toUpperCase()}</div></div>
    </div>
    ${colorRolesHtml}
    <div class="eyebrow" style="margin:14px 0 8px">Critique</div>
    <div class="critique" style="margin-bottom:14px">${esc(x.critique||'No critique recorded.')}</div>
    ${stealsHtml}${antiHtml}${layoutHtml}${voiceHtml}
    <div style="display:flex;gap:8px;margin:14px 0">
      <a class="btn" style="flex:1;justify-content:center" href="#/add">Edit</a>
      <button class="btn primary" style="flex:1;justify-content:center" onclick="window._mcp.toast('Added to compare')">Compare</button>
    </div>
    <div style="font-size:10px;color:var(--muted);font-family:var(--mono);text-align:center">added ${x.added} · click a swatch to copy its hex</div>`;
  rail.style.display='block';
  document.getElementById('app').classList.add('detail-open');
  document.getElementById('detailFavBtn')?.addEventListener('click',()=>{
    const on=toggleFav(x.id); openDetail(x);
    document.querySelectorAll(`.gcard[data-id="${x.id}"]`).forEach(c=>c.classList.toggle('is-fav',on));
  });
  document.querySelectorAll('#detailBody .swatch').forEach(s=>{
    s.addEventListener('click',()=>{
      const hex=s.dataset.hex;
      navigator.clipboard?.writeText(hex).then(()=>toast('Copied '+hex)).catch(()=>toast(hex));
    });
  });
}
function closeDetail(){
  document.getElementById('detailRail').style.display='none';
  document.getElementById('app').classList.remove('detail-open');
}

function esc(s){ return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

/* ============================================================
   PAGES
   ============================================================ */

/* -------- Overview -------- */
page('overview','Overview','clean-ui-mcp · v0.1.0 · stdio transport', function(){
  const N=agg.N||0;
  const maxPat=Math.max(...(agg.topPatterns||[]).map(d=>d[1]),1);
  const maxSty=Math.max(...(agg.topStyles||[]).map(d=>d[1]),1);
  return `
  <div class="strip">
    ${kpi(N,'','Entries indexed','',
      `vector search active · <b>${HEALTH.entryCount||0}/${N}</b> embedded`)}
    ${kpi((agg.avgScore||0).toFixed(2),'/5','Avg quality score','warn',
      `${agg.excCount||0} exceptional · ${agg.cauCount||0} cautionary`)}
    ${kpi(N?(agg.excCount/N*100).toFixed(1):0,'%','Exceptional tier','pos',
      `<b>${agg.mobileCount||0}</b> mobile · <b>${agg.webCount||0}</b> web`)}
    ${kpi(N?((agg.withImages||0)/N*100).toFixed(0):0,'%','Image coverage','pos',
      `<b>${agg.withImages||0}</b> with screenshots`)}
  </div>
  <div class="grid-2">
    <div class="card">
      <div class="card-head"><div><h3>By pattern type</h3><div class="eyebrow">top 8</div></div>
        <a class="chip" href="#/entries">Browse all →</a></div>
      ${distRows(agg.topPatterns||[],maxPat)}
    </div>
    <div class="card">
      <div class="card-head"><div><h3>By style</h3><div class="eyebrow">top 8</div></div>
        <a class="chip" href="#/entries">Browse all →</a></div>
      ${distRows(agg.topStyles||[],maxSty)}
    </div>
  </div>
  <div class="card">
    <div class="card-head"><div><h3>Recent entries</h3><div class="eyebrow">most recent · click to inspect</div></div>
      <a class="chip" href="#/entries">All ${N} →</a></div>
    <table><thead><tr><th>ID</th><th>Source</th><th>Pattern</th><th>Style</th><th>Tier</th><th>Score</th><th class="r">Steals</th><th></th></tr></thead>
      <tbody>${E.slice(-8).reverse().map(entryRow).join('')}</tbody></table>
  </div>`;
}, function after(){ bindEntryRows(); });

/* -------- Entries -------- */
page('entries','Entries',`all ${agg.N||0} entries · visual gallery`, function(){
  return `
  <div class="card" style="margin-bottom:14px">
    <div class="card-head" style="margin-bottom:0">
      <div class="chips" id="entryFilters">
        <button class="chip on" data-f="all">ALL · ${agg.N||0}</button>
        <button class="chip" data-f="fav">★ STARRED · <span id="favCount">${getFavs().length}</span></button>
        <button class="chip" data-f="exceptional">Exceptional · ${agg.excCount||0}</button>
        <button class="chip" data-f="cautionary">Cautionary · ${agg.cauCount||0}</button>
        <button class="chip" data-f="mobile">Mobile · ${agg.mobileCount||0}</button>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <select class="sort-select" id="entrySort" title="Sort by">
          <option value="recent">Most recent</option>
          <option value="score">Highest score</option>
          <option value="fav">Favorites first</option>
          <option value="source">By source</option>
          <option value="pattern">By pattern</option>
        </select>
        <div class="view-toggle" id="viewToggle">
          <button class="on" data-v="grid"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg><span class="lbl">Grid</span></button>
          <button data-v="table"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 6h18M3 12h18M3 18h18"/></svg><span class="lbl">List</span></button>
        </div>
      </div>
    </div>
  </div>
  <div id="entryResults"></div>`;
}, function after(){
  const st = {filter:'all', sort:'recent', view:'grid', page:1, perPage:24, q:''};
  const globalQ = document.getElementById('globalSearch');
  if(globalQ && !globalQ._bound){ globalQ._bound=true; globalQ.addEventListener('input',e=>{ st.q=e.target.value.toLowerCase(); st.page=1; render(); }); }
  function filtered(){
    let rows = E.slice();
    const favs=getFavs();
    if(st.filter==='exceptional') rows=rows.filter(x=>x.tier==='exceptional');
    else if(st.filter==='cautionary') rows=rows.filter(x=>x.tier==='cautionary');
    else if(st.filter==='mobile') rows=rows.filter(x=>x.platform==='mobile');
    else if(st.filter==='fav') rows=rows.filter(x=>favs.includes(x.id));
    if(st.q){ rows=rows.filter(x=>(x.id+' '+x.source+' '+x.pattern+' '+x.style+' '+x.title).toLowerCase().includes(st.q)); }
    const favSet=new Set(favs);
    if(st.sort==='recent') rows.sort((a,b)=>(b.added||'').localeCompare(a.added||''));
    else if(st.sort==='score') rows.sort((a,b)=>(b.score||0)-(a.score||0));
    else if(st.sort==='fav') rows.sort((a,b)=>(favSet.has(b.id)?1:0)-(favSet.has(a.id)?1:0));
    else if(st.sort==='source') rows.sort((a,b)=>a.source.localeCompare(b.source));
    else if(st.sort==='pattern') rows.sort((a,b)=>a.pattern.localeCompare(b.pattern));
    return rows;
  }
  function pagination(rowsLen){
    const totalPages=Math.max(1,Math.ceil(rowsLen/st.perPage));
    const start=(st.page-1)*st.perPage;
    const btns=[`<button class="pg" ${st.page===1?'disabled':''} data-pg="${st.page-1}">‹</button>`];
    const maxBtns=7; let from=Math.max(1,st.page-3), to=Math.min(totalPages,from+maxBtns-1);
    if(to-from<maxBtns-1) from=Math.max(1,to-maxBtns+1);
    for(let i=from;i<=to;i++) btns.push(`<button class="pg ${i===st.page?'on':''}" data-pg="${i}">${i}</button>`);
    btns.push(`<button class="pg" ${st.page===totalPages?'disabled':''} data-pg="${st.page+1}">›</button>`);
    return `<div class="pagination"><span class="mono" style="font-size:11px">${start+1}–${Math.min(start+st.perPage,rowsLen)} of ${rowsLen}</span><div class="pages">${btns.join('')}</div></div>`;
  }
  function render(){
    const rows=filtered();
    const totalPages=Math.max(1,Math.ceil(rows.length/st.perPage));
    if(st.page>totalPages) st.page=totalPages;
    const start=(st.page-1)*st.perPage;
    const slice=rows.slice(start,start+st.perPage);
    const out=document.getElementById('entryResults');
    if(st.view==='grid'){
      out.innerHTML = slice.length ? `<div class="gallery">${slice.map(galleryCard).join('')}</div>`+pagination(rows.length) : `<div class="empty" style="padding:60px 20px"><div style="font-size:32px;margin-bottom:8px;opacity:.5">🔍</div><div style="font-weight:600;color:var(--ink-2)">No matches</div></div>`;
    } else {
      const visIds = slice.map(x=>x.id);
      const allVisSel = visIds.length>0 && visIds.every(id=>isSelected(id));
      out.innerHTML = slice.length ? `<table id="entryTable"><thead><tr><th class="sel-cell"><input type="checkbox" id="selAll" ${allVisSel?'checked':''} aria-label="Select all visible" title="Select all on this page"></th><th>ID</th><th>Source</th><th>Pattern</th><th>Style</th><th>Tier</th><th>Score</th><th class="r">Steals</th><th></th></tr></thead><tbody>${slice.map(entryRow).join('')}</tbody></table>`+pagination(rows.length) : `<div class="empty">No entries match these filters.</div>`;
    }
    out.querySelectorAll('#entryResults .pg, .pages .pg').forEach(b=>b.addEventListener('click',()=>{const p=+b.dataset.pg;if(p>=1&&p<=totalPages){st.page=p;render();document.querySelector('.main').scrollTop=0;}}));
    out.querySelectorAll('.pages .pg').forEach(b=>b.addEventListener('click',()=>{const p=+b.dataset.pg;if(p>=1&&p<=totalPages){st.page=p;render();document.querySelector('.main').scrollTop=0;}}));
    bindGallery(); bindEntryRows();
    bindBulkBar(); renderSelectionBar();
  }
  function bindGallery(){
    document.querySelectorAll('#entryResults .gcard').forEach(card=>{
      card.addEventListener('click',e=>{ if(e.target.closest('.fav-btn,.sel-btn,.row-sel'))return; const x=E.find(en=>en.id===card.dataset.id); if(x)openDetail(x); });
    });
    document.querySelectorAll('#entryResults .sel-btn .row-sel').forEach(cb=>{
      if(cb._bound) return; cb._bound=true;
      cb.addEventListener('click', e => e.stopPropagation());
      cb.addEventListener('change', () => toggleRowSelection(cb.dataset.id));
    });
    document.querySelectorAll('#entryResults .fav-btn').forEach(b=>{
      b.addEventListener('click',e=>{ e.stopPropagation(); const id=b.dataset.id; const on=toggleFav(id);
        const card=b.closest('.gcard'); card.classList.toggle('is-fav',on); b.classList.toggle('fav-on',on);
        b.querySelector('svg').setAttribute('fill',on?'currentColor':'none');
        const fc=document.getElementById('favCount'); if(fc)fc.textContent=getFavs().length;
        if(st.filter==='fav'&&!on) render();
      });
    });
  }
  document.querySelectorAll('#entryFilters .chip').forEach(c=>{
    c.addEventListener('click',()=>{ document.querySelectorAll('#entryFilters .chip').forEach(x=>x.classList.remove('on')); c.classList.add('on'); st.filter=c.dataset.f; st.page=1; render(); });
  });
  document.getElementById('entrySort').addEventListener('change',e=>{st.sort=e.target.value;st.page=1;render();});
  document.querySelectorAll('#viewToggle button').forEach(b=>{
    b.addEventListener('click',()=>{ document.querySelectorAll('#viewToggle button').forEach(x=>x.classList.remove('on')); b.classList.add('on'); st.view=b.dataset.v; st.page=1; render(); });
  });
  render();
});

/* -------- Add entry -------- */
// Single-entry capture/upload → auto-fill → review → save flow. Mirrors the
// classic workbench's form, but lives in the SPA so the navigation context
// (favorites, search query) is preserved. Draft state is held locally in
// `addDraft` below — no global state pollution.
// ─── capture/upload wizard (seeds the shared draft) ──────────────────────────
// Used by the #/edit route when no entry is being edited (new-entry mode).
// On successful capture/upload the draft.image.path is set; on successful
// auto-tag the draft is replaced wholesale with the tagger's structured output
// (preserving _editing/_busy/_tab/_pendingCapture). The full form then renders
// from the draft.

async function wizardCapture(form){
  const url = (form.url.value||'').trim();
  const slug = (form.slug.value||'').trim();
  if(!url){ draft._error = 'URL is required'; refreshActivePage(); return; }
  // Multi-candidate capture: /api/capture-candidates runs the same detection
  // pipeline as the batch CLI (sections, groups, recursive oversized) and
  // returns N candidates. The user picks which to tag in the candidateStep.
  // Single-shot /api/capture-url (one full-viewport PNG) is still used by the
  // classic workbench; this SPA flow always goes through multi-candidate.
  draft._busy = 'Detecting sections… (this launches a browser, ~15-40s)'; draft._error = null; refreshActivePage();
  try {
    const j = await request('/api/capture-candidates', { method:'POST', body: JSON.stringify({ url, slug: slug || undefined }) });
    draft._addBatchId = j.batchId;
    draft._candidates = j.candidates || [];
    draft._candidateStatus = new Map();
    draft._selectedCandidates = new Set();
    draft._activeCandidateIndex = null;
    if(!draft.source.url) draft.source.url = url;
    draft._busy = null;
    if(draft._candidates.length === 0){
      draft._error = 'No sections detected on that page. Try a different URL or use Upload instead.';
    }
  } catch(e){ draft._busy = null; draft._error = e.message; }
  refreshActivePage();
}

// Build a draft from a capture candidate — the field mapping mirrors
// promoteCapture (from #/capture triage) so the two flows produce identical
// drafts. image.path stays at the TEMP path; the server promotes temp→permanent
// at save time (see /api/entries promote-on-save). provenance.capture stamps
// the recapture metadata. Does NOT reset _addBatchId/_candidates — the session
// survives the tag cycle.
function buildDraftFromCandidate(c, sourceUrl){
  const d = blankDraft();
  d.source.productName = c.sourceName || '';
  if(sourceUrl || c.sourceUrl) d.source.url = sourceUrl || c.sourceUrl;
  d.image = { visibility:'private', path: c.imagePath, width:null, height:null };
  d.title = `${c.sourceName || ''} — (add descriptive subtitle)`;
  d.provenance = {
    taggedBy: 'auto',
    capture: {
      mode: c.captureMode || '',
      viewport: c.viewport || '',
      capturedAt: c.capturedAt || '',
      sourceUrl: sourceUrl || c.sourceUrl || '',
      ...(c.selectorPath ? { selectorPath: c.selectorPath } : {}),
    },
  };
  return d;
}

// Walk the multi-candidate session: find the next drafted candidate, build its
// draft, set _addPreseeded so the #/add guard doesn't wipe it, and re-render.
// Called after a save (success or skip) to advance, and by tagSelected to start.
function advanceToNextDraftedCandidate(){
  if(!draft._candidates || !draft._candidateStatus) return false;
  const statuses = draft._candidateStatus;
  // Find lowest-index drafted candidate.
  let next = -1;
  for(const [i, st] of statuses){
    if(st === 'drafted'){ next = Math.min(next === -1 ? Infinity : next, i); }
  }
  if(next === -1) return false;
  draft._candidateStatus.set(next, 'tagging');
  const c = draft._candidates[next];
  const sourceUrl = draft.source.url;
  // Preserve session fields across the rebuild.
  const session = {
    _addBatchId: draft._addBatchId, _candidates: draft._candidates,
    _candidateStatus: draft._candidateStatus, _selectedCandidates: draft._selectedCandidates,
  };
  draft = buildDraftFromCandidate(c, sourceUrl);
  draft._addBatchId = session._addBatchId;
  draft._candidates = session._candidates;
  draft._candidateStatus = session._candidateStatus;
  draft._selectedCandidates = session._selectedCandidates;
  draft._activeCandidateIndex = next;
  _addPreseeded = true;
  refreshActivePage();
  return true;
}

// Begin tagging the selected candidates: initialize all to 'drafted', then
// advance to the first.
function tagSelected(){
  if(!draft._candidates || draft._selectedCandidates.size === 0) return;
  draft._candidateStatus = new Map();
  for(const i of draft._selectedCandidates) draft._candidateStatus.set(i, 'drafted');
  draft._activeCandidateIndex = null;
  advanceToNextDraftedCandidate();
}

function wizardUpload(file){
  if(!file) return;
  draft._busy = 'Uploading…'; draft._error = null; refreshActivePage();
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const j = await request('/api/upload-image', {
        method:'POST', body: JSON.stringify({ filename:file.name, slug: draft.source.productName || file.name, dataUrl: reader.result })
      });
      draft.image.path = j.path;
      draft._busy = null;
    } catch(e){ draft._busy = null; draft._error = e.message; }
    refreshActivePage();
  };
  reader.onerror = () => { draft._busy = null; draft._error = 'Could not read file'; refreshActivePage(); };
  reader.readAsDataURL(file);
}

async function wizardAutoTag(){
  if(!draft.image.path){ draft._error = 'Capture or upload an image first'; refreshActivePage(); return; }
  draft._busy = 'Auto-filling fields…'; draft._error = null; refreshActivePage();
  try {
    const j = await request('/api/auto-tag', {
      method:'POST', body: JSON.stringify({ imagePath: draft.image.path, productName: draft.source.productName, url: draft.source.url })
    });
    // Merge the tagger's structured output into the draft, preserving the
    // form-internal fields (_editing, _busy, _tab, _pendingCapture) and the
    // image path the wizard already set. The multi-candidate session fields
    // (_addBatchId/_candidates/_candidateStatus/_selectedCandidates/
    // _activeCandidateIndex) MUST be preserved too, or the first auto-tag in
    // a multi-candidate flow wipes the session and the user can't advance.
    const preserved = {
      _editing: draft._editing, _busy: null, _tab: draft._tab, _pendingCapture: draft._pendingCapture,
      _addBatchId: draft._addBatchId, _candidates: draft._candidates,
      _candidateStatus: draft._candidateStatus, _selectedCandidates: draft._selectedCandidates,
      _activeCandidateIndex: draft._activeCandidateIndex,
    };
    draft = { ...j.entry, image: { ...j.entry.image, path: draft.image.path }, ...preserved };
  } catch(e){ draft._error = e.message; }
  refreshActivePage();
}

// Save the draft to the corpus. PUT if editing an existing entry, POST if new.
// Strips [DRAFT] markers from all text fields (the form review IS the rewrite
// gate), flips provenance.taggedBy to 'auto-reviewed' on the tagger's output,
// and clears any pending capture-triage state on success.
async function saveDraft(){
  // Strip markers from all text fields before submit.
  draft.critique = stripDraftMarker(draft.critique);
  draft.whatToSteal = (draft.whatToSteal||[]).map(stripDraftMarker);
  if(draft.antiPatterns){
    draft.antiPatterns.antiPatterns = (draft.antiPatterns.antiPatterns||[]).map(stripDraftMarker);
    draft.antiPatterns.whereThisFails = (draft.antiPatterns.whereThisFails||[]).map(stripDraftMarker);
    draft.antiPatterns.accessibilityRisks = (draft.antiPatterns.accessibilityRisks||[]).map(stripDraftMarker);
  }
  if(draft.voice){
    draft.voice.tone = stripDraftMarker(draft.voice.tone);
    draft.voice.examples = (draft.voice.examples||[]).map(stripDraftMarker);
    draft.voice.avoid = (draft.voice.avoid||[]).map(stripDraftMarker);
  }
  draft.reviewStatus = 'approved';
  if(draft.provenance && draft.provenance.taggedBy === 'auto') draft.provenance.taggedBy = 'auto-reviewed';

  const isEdit = !!draft._editing;
  const body = JSON.parse(JSON.stringify(draft));
  delete body._editing; delete body._busy; delete body._error; delete body._tab; delete body._pendingCapture;
  delete body._addBatchId; delete body._candidates; delete body._candidateStatus; delete body._selectedCandidates; delete body._activeCandidateIndex;

  try {
    const j = isEdit
      ? await request(`/api/entries/${encodeURIComponent(draft._editing)}`, { method:'PUT', body: JSON.stringify(body) })
      : await request('/api/entries', { method:'POST', body: JSON.stringify(body) });
    // If this came from capture triage, flip the triage status to 'promoted'.
    if(draft._pendingCapture){
      try {
        await request('/api/capture-triage', {
          method:'POST', body: JSON.stringify({ ...draft._pendingCapture, status:'promoted' })
        });
      } catch { /* triage flip is best-effort; the entry saved successfully */ }
    }
    await loadAll(); recomputeAgg();
    // Multi-candidate session branch: if we're in an Add-flow capture session,
    // do NOT redirect to #/entry/... — that would abort the loop. Instead mark
    // this candidate saved and advance to the next drafted one. Only the
    // out-of-session path (single capture/upload/triage-promote) redirects.
    if(draft._activeCandidateIndex !== null && draft._candidateStatus){
      const savedIdx = draft._activeCandidateIndex;
      const savedEntryId = j.entry?.id || draft._editing;
      draft._candidateStatus.set(savedIdx, { status:'saved', entryId: savedEntryId });
      const advanced = advanceToNextDraftedCandidate();
      if(!advanced){
        // No more drafted candidates — finish the session. Clean up the temp dir
        // only if every selected row is saved or skipped.
        const allDone = [...draft._candidateStatus.values()].every(
          s => (typeof s === 'string' ? s : s.status) === 'saved' || (typeof s === 'string' ? s : s.status) === 'skipped'
        );
        const savedCount = [...draft._candidateStatus.values()].filter(s => (typeof s === 'string' ? s : s.status) === 'saved').length;
        toast(`All done — ${savedCount} entr${savedCount===1?'y':'ies'} added`, 'success');
        if(allDone && draft._addBatchId){
          try { await request('/api/capture-cleanup-temp', { method:'POST', body: JSON.stringify({ batchId: draft._addBatchId }) }); }
          catch { /* cleanup is best-effort; the temp dir can be removed later */ }
        }
        resetDraft();
        location.hash = '/entries';
      } else {
        toast(`Saved (${savedEntryId}) — next candidate loaded`, 'success');
      }
    } else {
      toast(isEdit ? 'Entry updated' : 'Entry saved', 'success');
      location.hash = `#/entry/${encodeURIComponent(j.entry?.id || draft._editing)}`;
      resetDraft();
    }
  } catch(e){
    // In-session error: a duplicate or validation failure marks the ACTIVE
    // candidate (not the whole session) and stays on #/add. Other candidates
    // are unaffected. The user sees Retry/Edit/Skip on this row.
    if(draft._activeCandidateIndex !== null && draft._candidateStatus){
      const isDup = /duplicate/i.test(e.message);
      draft._candidateStatus.set(draft._activeCandidateIndex, isDup ? 'duplicate' : 'error');
      draft._error = e.message;
      // Reset _activeCandidateIndex so the candidate-step table re-renders with
      // the per-row status; the user picks Retry (re-tag) or Skip (advance).
      draft._activeCandidateIndex = null;
      refreshActivePage();
    } else {
      draft._error = e.message;
      refreshActivePage();
    }
  }
}

// Render the candidate picker grid (Step 2). Each candidate is a card with a
// thumbnail, meta, and a checkbox. Selected cards get is-sel outline. A sticky
// action row appears when ≥1 is selected. "Discard all" wipes the temp batch.
function renderCandidateStep(){
  const cs = draft._candidates;
  const sel = draft._selectedCandidates || new Set();
  const host = draft.source.url ? (() => { try { return new URL(draft.source.url).hostname; } catch { return ''; } })() : '';
  const cards = cs.map((c, i) => {
    const on = sel.has(i);
    return `<label class="gcard ${on?'is-sel':''}" data-candidate-card="${i}" style="cursor:pointer;display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--hr);border-radius:6px;${on?'outline:2px solid var(--accent);border-color:var(--accent)':''}">
      <div style="display:flex;gap:6px;align-items:flex-start">
        <input type="checkbox" class="row-sel" data-candidate-pick="${i}" ${on?'checked':''} aria-label="Select candidate ${i+1}" style="margin-top:2px">
        <img src="${API}/api/image?path=${encodeURIComponent(c.imagePath)}" alt="${esc(c.id)}" style="width:100%;max-height:140px;object-fit:cover;object-position:top;border-radius:4px;background:var(--surface)" loading="lazy">
      </div>
      <div style="font-family:var(--mono);font-size:10px;color:var(--ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(c.id)}</div>
      <div style="font-size:10px;color:var(--ink-2)">${esc(c.captureMode||'')} · ${esc(c.viewport||'')}</div>
    </label>`;
  }).join('');
  const allDone = draft._candidateStatus && draft._candidateStatus.size > 0 &&
    [...draft._candidateStatus.values()].every(s => (typeof s === 'string' ? s : s.status) === 'saved' || (typeof s === 'string' ? s : s.status) === 'skipped');
  const cleanable = allDone && draft._addBatchId;
  return `<div class="card-section">
    <div class="eyebrow">Step 2 — pick screenshots to tag · ${cs.length} candidate(s)${host ? ' from ' + esc(host) : ''}</div>
    <div class="gallery" style="grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin-top:10px">${cards}</div>
    <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <span id="candSelCount" style="font-size:12px;color:var(--ink-2)">${sel.size} selected</span>
      <button class="btn primary" id="addTagSelected" ${sel.size?'':'disabled'}>Tag selected${sel.size?` (${sel.size})`:''} →</button>
      ${cleanable ? `<button class="btn" id="addCleanupCandidates">Clean up unselected</button>` : ''}
      <button class="btn" id="addDiscardCandidates" style="margin-left:auto">Discard all</button>
    </div>
  </div>`;
}

// Render the status table — appears once tagging has begun, alongside the
// preview/review of the active candidate. One row per selected candidate with
// a status pill and per-row actions (Retry/Edit/Skip for problem rows).
const CAND_STATUS_PILL = {
  drafted:   { label:'Drafted',    bg:'#f1f5f9', fg:'#475569' },
  tagging:   { label:'Tagging…',   bg:'#dbeafe', fg:'#1e40af' },
  saved:     { label:'Saved ✓',    bg:'#dcfce7', fg:'#166534' },
  duplicate: { label:'Duplicate',  bg:'#fef3c7', fg:'#92400e' },
  error:     { label:'Error',      bg:'#fee2e2', fg:'#991b1b' },
  skipped:   { label:'Skipped',    bg:'#f1f5f9', fg:'#94a3b8' },
};
function renderCandidateStatusTable(){
  const rows = [];
  for(const [i, raw] of draft._candidateStatus.entries()){
    const st = typeof raw === 'string' ? raw : raw.status;
    const entryId = typeof raw === 'object' && raw ? raw.entryId : null;
    const c = draft._candidates[i];
    const pill = CAND_STATUS_PILL[st] || CAND_STATUS_PILL.drafted;
    let actions = '';
    if(st === 'duplicate' || st === 'error'){
      actions = `<button class="btn" data-candidate-retry="${i}" style="padding:2px 8px;font-size:11px">Retry</button>`
              + `<button class="btn" data-candidate-skip="${i}" style="padding:2px 8px;font-size:11px">Skip</button>`;
    } else if(st === 'saved' && entryId){
      actions = `<a class="btn" href="#/entry/${encodeURIComponent(entryId)}" style="padding:2px 8px;font-size:11px">View →</a>`;
    }
    rows.push(`<tr>
      <td><img src="${API}/api/image?path=${encodeURIComponent(c.imagePath)}" alt="" style="width:48px;height:32px;object-fit:cover;border-radius:3px"></td>
      <td style="font-family:var(--mono);font-size:11px">${esc(c.id)}</td>
      <td><span style="font-size:11px;padding:2px 8px;border-radius:10px;background:${pill.bg};color:${pill.fg};font-weight:500">${pill.label}</span></td>
      <td>${actions}</td>
    </tr>`);
  }
  return `<div class="card-section">
    <div class="eyebrow">Capture session — ${draft._candidateStatus.size} candidate(s)</div>
    <table style="width:100%;margin-top:8px;border-collapse:collapse">
      <thead><tr style="text-align:left;font-size:11px;color:var(--ink-2)"><th></th><th>ID</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>
  </div>`;
}

// Tracks the hash the #/add page last seeded a fresh draft for. We reset ONLY
// on hash arrival — not on every refreshActivePage() re-render. Resetting on
// every render wiped draft._busy / draft.image.path (and the URL the user had
// typed) the moment any wizard action triggered a re-render, making every
// button appear dead. location.hash changes on every genuine navigation to
// #/add (including back-to-add-after-save), while refreshActivePage() leaves
// it unchanged.
//
// _addPreseeded is the escape hatch for promoteCapture: it pre-fills the draft
// from a capture candidate and routes here, so we must NOT reset on arrival.
// The flag is consumed once on the first render, then cleared.
let _addSeededForHash = null;
let _addPreseeded = false;
page('add','Add entry','new corpus entry', function(){
  if(_addPreseeded){
    // Draft was pre-seeded by promoteCapture — keep it, just sync the guard.
    _addPreseeded = false;
    _addSeededForHash = location.hash;
  } else if(_addSeededForHash !== location.hash){
    // The #/add route is the new-entry entry point. Seed a blank draft when the
    // hash actually changed (genuine navigation), then leave the draft alone
    // across re-renders so in-flight wizard state survives.
    resetDraft();
    _addSeededForHash = location.hash;
  }
  // Force _editing null regardless — #/add is always a new entry, never an edit.
  draft._editing = null;
  const hasImage = !!draft.image.path;
  const hasFields = !!(draft.critique || draft.patternType);
  const hasCandidates = !!(draft._candidates && draft._candidates.length);
  // A capture session is "active" when a candidate is loaded into the draft for
  // tagging. While active, the preview/review steps show for THAT candidate,
  // and a status table appears showing the other candidates' progress.
  const sessionActive = draft._activeCandidateIndex !== null;
  const selCount = draft._selectedCandidates ? draft._selectedCandidates.size : 0;

  const captureStep = `
    <div class="card-section">
      <div class="eyebrow">Step 1 — capture or upload a screenshot</div>
      ${draft._tab==='capture' ? `
        <form id="addCaptureForm" style="margin-top:10px">
          <label>Source URL<input name="url" placeholder="https://linear.app" value="${esc(draft.source.url||'')}" style="width:100%"></label>
          <label>Slug (optional)<input name="slug" placeholder="linear-landing-2026" style="width:100%"></label>
          <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn primary" type="submit">Capture from URL</button>
            <button class="btn" type="button" id="addSwitchUpload">⇄ Upload instead</button>
          </div>
        </form>
      ` : `
        <div style="margin-top:10px">
          <label class="btn">
            <input type="file" id="addFileInput" accept="image/png,image/jpeg,image/webp" hidden>
            Choose an image file
          </label>
          <button class="btn" type="button" id="addSwitchCapture" style="margin-left:8px">⇄ Capture from URL instead</button>
        </div>
      `}
    </div>`;

  // Candidate picker — the multi-select grid. Shows when detection produced
  // candidates AND no candidate is currently being tagged (sessionActive).
  // Once a candidate is loaded for tagging, the picker is replaced by the
  // preview/review steps + the status table below.
  const candidateStep = (hasCandidates && !sessionActive) ? renderCandidateStep() : '';

  // Status table — shows once tagging has begun (any candidate has a status).
  // Visible alongside the preview/review of the active candidate.
  const statusTable = (hasCandidates && draft._candidateStatus && draft._candidateStatus.size > 0) ? renderCandidateStatusTable() : '';

  const previewStep = hasImage ? `
    <div class="card-section">
      <div class="eyebrow">${sessionActive ? 'Tagging candidate ' + (Number(draft._activeCandidateIndex)+1) + ' — preview' : 'Step 2 — preview'}</div>
      <figure class="image-preview" style="margin-top:8px">
        <img src="${API}/api/image?path=${encodeURIComponent(draft.image.path)}" alt="captured" style="max-width:100%;border-radius:6px;border:1px solid var(--hr)">
        <figcaption class="image-ready">Image ready: ${esc(draft.image.path)}</figcaption>
      </figure>
      ${hasFields ? '' : `<button class="btn primary" id="addAutoTag" style="margin-top:8px">✨ Auto-fill fields</button>`}
    </div>` : '';

  const reviewStep = hasFields ? `
    <div class="card-section">
      <div class="eyebrow">Step 3 — review the draft and save</div>
      <form id="addSaveForm" style="margin-top:8px;display:flex;flex-direction:column;gap:10px">
        <label>ID (optional)<input name="id" placeholder="(auto-generated)" value="${esc(draft.id||'')}" style="width:100%"></label>
        <label>Title<input name="title" value="${esc(draft.title||'')}" style="width:100%"></label>
        <label>Product name<input name="productName" value="${esc(draft.source?.productName||'')}" style="width:100%"></label>
        <label>Quality score (1-5)<input name="qualityScore" type="number" min="1" max="5" value="${draft.qualityScore||3}" style="width:60px"></label>
        <label>Critique
          <textarea name="critique" rows="6" style="width:100%;font-family:var(--mono);font-size:12px">${esc(draft.critique||'')}</textarea>
        </label>
        <details style="font-size:12px;color:var(--ink-2)">
          <summary>Pattern / categories / style (auto-detected)</summary>
          <pre style="white-space:pre-wrap;background:var(--surface);padding:8px;border-radius:4px">${esc(JSON.stringify({patternType:draft.patternType, categories:draft.categories, styleTags:draft.styleTags, platform:draft.platform}, null, 2))}</pre>
        </details>
        <button class="btn primary" type="submit">Save entry →</button>
      </form>
    </div>` : '';

  const busyMsg = draft._busy ? `<div class="card-section" style="color:var(--accent);font-size:13px">⏳ ${esc(draft._busy)}</div>` : '';
  const errorMsg = draft._error ? `<div class="card-section" style="color:#c00;font-size:13px">⚠ ${esc(draft._error)}</div>` : '';

  return `<div class="card">
    <div class="card-head"><div><h3>Add a single entry</h3><div class="eyebrow">capture → auto-fill → review → save</div></div></div>
    ${busyMsg}${errorMsg}
    ${captureStep}
    ${candidateStep}
    ${previewStep}
    ${reviewStep}
    ${statusTable}
  </div>`;
}, function(){
  const cap = document.getElementById('addCaptureForm');
  if(cap) cap.addEventListener('submit', e=>{ e.preventDefault(); wizardCapture(e.target); });
  const upSwitch = document.getElementById('addSwitchUpload');
  if(upSwitch) upSwitch.addEventListener('click', ()=>{ draft._tab='upload'; refreshActivePage(); });
  const capSwitch = document.getElementById('addSwitchCapture');
  if(capSwitch) capSwitch.addEventListener('click', ()=>{ draft._tab='capture'; refreshActivePage(); });
  const fileInput = document.getElementById('addFileInput');
  if(fileInput) fileInput.addEventListener('change', e=>{ wizardUpload(e.target.files[0]); });
  const at = document.getElementById('addAutoTag');
  if(at) at.addEventListener('click', wizardAutoTag);
  const save = document.getElementById('addSaveForm');
  if(save) save.addEventListener('submit', e=>{
    e.preventDefault();
    // Pull form values into the draft before saving.
    draft.id = (save.id.value||'').trim();
    draft.title = (save.title.value||'').trim();
    draft.source.productName = (save.productName.value||'').trim();
    draft.qualityScore = Number(save.qualityScore.value)||3;
    draft.critique = save.critique.value;
    saveDraft();
  });
  // ── Multi-candidate picker handlers ──
  document.querySelectorAll('[data-candidate-pick]').forEach(cb=>{
    cb.addEventListener('change', e=>{
      e.stopPropagation();
      const i = Number(cb.dataset.candidatePick);
      if(!draft._selectedCandidates) draft._selectedCandidates = new Set();
      if(cb.checked) draft._selectedCandidates.add(i); else draft._selectedCandidates.delete(i);
      // Re-render to update the count + Tag button + is-sel outline.
      refreshActivePage();
    });
  });
  const tagBtn = document.getElementById('addTagSelected');
  if(tagBtn) tagBtn.addEventListener('click', tagSelected);
  const discardBtn = document.getElementById('addDiscardCandidates');
  if(discardBtn) discardBtn.addEventListener('click', async ()=>{
    if(!confirm('Discard all candidates? This deletes the temp capture folder and can\'t be undone.')) return;
    if(draft._addBatchId){
      try { await request('/api/capture-cleanup-temp', { method:'POST', body: JSON.stringify({ batchId: draft._addBatchId }) }); }
      catch(e){ toast(e.message, 'error'); }
    }
    resetDraft();
    refreshActivePage();
  });
  const cleanupBtn = document.getElementById('addCleanupCandidates');
  if(cleanupBtn) cleanupBtn.addEventListener('click', async ()=>{
    if(draft._addBatchId){
      try {
        await request('/api/capture-cleanup-temp', { method:'POST', body: JSON.stringify({ batchId: draft._addBatchId }) });
        toast('Temp captures cleaned up', 'success');
        // Clear candidate state but keep the now-saved entries visible.
        draft._addBatchId = null; draft._candidates = null;
        draft._candidateStatus = null; draft._selectedCandidates = null;
        refreshActivePage();
      } catch(e){ toast(e.message, 'error'); }
    }
  });
  // Per-row Retry/Skip in the status table.
  document.querySelectorAll('[data-candidate-retry]').forEach(b=>{
    b.addEventListener('click', ()=>{
      const i = Number(b.dataset.candidateRetry);
      if(draft._candidateStatus) draft._candidateStatus.set(i, 'drafted');
      // If nothing else is active, advance to this one.
      if(draft._activeCandidateIndex === null) advanceToNextDraftedCandidate();
      else refreshActivePage();
    });
  });
  document.querySelectorAll('[data-candidate-skip]').forEach(b=>{
    b.addEventListener('click', ()=>{
      const i = Number(b.dataset.candidateSkip);
      if(draft._candidateStatus) draft._candidateStatus.set(i, 'skipped');
      // If this was the active one, clear it; then try to advance.
      if(draft._activeCandidateIndex === i) draft._activeCandidateIndex = null;
      if(!advanceToNextDraftedCandidate()){
        // No more drafted — check if session is fully done.
        const allDone = draft._candidateStatus && [...draft._candidateStatus.values()].every(
          s => (typeof s === 'string' ? s : s.status) === 'saved' || (typeof s === 'string' ? s : s.status) === 'skipped'
        );
        if(allDone){
          toast('Session complete', 'success');
          resetDraft();
          location.hash = '/entries';
        } else {
          refreshActivePage();
        }
      }
    });
  });
});

/* -------- Bulk import -------- */
page('bulk','Bulk import','batch ingest · upload → auto-fill → commit', function(){
  return `<div class="card">
    <div class="card-head"><div><h3>Bulk import</h3><div class="eyebrow">upload → stage → auto-fill → critique → commit</div></div></div>
    <p style="font-size:13px;color:var(--ink-2);line-height:1.6;margin-bottom:16px">
      The bulk-import flow (with dedup, auto-fill, and commit) lives in the classic view.
      It uses the live tagger + commit-time dedup gate.
    </p>
    <a class="btn primary" href="/index-classic.html#bulk" target="_blank">Open bulk import →</a>
  </div>`;
});

/* -------- Capture triage -------- */
// Ported from the classic workbench (ui/classic-app.js renderCapture). Lists
// batch-capture candidates written to disk by `npm run capture-batch`, and lets
// the user promote / reject / clean up. Batch capture itself stays CLI-only —
// this page only triages what's already on disk. Loaded lazily on first render.

// Status chip colors (Pending=amber, Promoted=green, Rejected=grey) — matches
// the classic workbench so muscle memory carries over.
const CAPTURE_STATUS_CHIP = {
  pending:   { label:'Pending',   bg:'#fef3c7', fg:'#92400e' },
  promoted:  { label:'Promoted',  bg:'#dcfce7', fg:'#166534' },
  rejected:  { label:'Rejected',  bg:'#f1f5f9', fg:'#475569' },
};

function renderCaptureBatch(batch){
  const t = { total: batch.items.length, pending:0, promoted:0, rejected:0 };
  for(const it of batch.items) t[it.status]++;
  // Client half of the cleanup safety gate: only enable when nothing is pending.
  // The server re-checks (409) regardless, so this is UX polish, not security.
  const cleanable = t.pending === 0 && t.total > 0;
  return `<div class="card" style="margin-bottom:14px">
    <div class="card-head">
      <div>
        <h3 style="font-family:var(--mono);font-size:14px">${esc(batch.batchId)}</h3>
        <div class="eyebrow">${esc(batch.capturedAt||'')} · ${t.total} capture(s) · ${t.promoted} promoted · ${t.rejected} rejected · ${t.pending} pending</div>
      </div>
      <button class="btn" id="captureCleanup-${esc(batch.batchId)}" data-capture-cleanup="${esc(batch.batchId)}" ${cleanable?'':'disabled'} title="${cleanable?'Delete this batch folder':'Promote or reject all items first'}">Clean up batch</button>
    </div>
    <div class="capture-queue">
      ${batch.items.map(it => renderCaptureRow(batch, it)).join('')}
    </div>
  </div>`;
}

function renderCaptureRow(batch, item){
  const chip = CAPTURE_STATUS_CHIP[item.status] || CAPTURE_STATUS_CHIP.pending;
  const thumb = `<img src="${API}/api/image?path=${encodeURIComponent(item.imagePath)}" alt="${esc(item.id)}" data-img-id="capture-${esc(item.id)}" style="width:96px;height:64px;object-fit:cover;object-position:top;border-radius:4px;border:1px solid var(--hr);background:var(--surface)" loading="lazy">`;
  const key = `${esc(batch.batchId)}|${esc(item.id)}`;
  return `<div class="capture-row" data-capture-id="${esc(item.id)}" style="display:flex;gap:12px;align-items:center;padding:10px 0;border-bottom:1px solid var(--hr)">
    ${thumb}
    <div style="flex:1;min-width:0">
      <div style="font-family:var(--mono);font-size:12px;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(item.id)}</div>
      <div style="font-size:11px;color:var(--ink-2);margin-top:2px">${esc(item.sourceName||'')} · ${esc(item.captureMode||'')} · ${esc(item.viewport||'')}</div>
    </div>
    <span style="font-size:11px;padding:2px 8px;border-radius:10px;background:${chip.bg};color:${chip.fg};font-weight:500">${chip.label}</span>
    ${item.status !== 'promoted' ? `<button class="btn primary" data-capture-promote="${key}" style="padding:4px 10px;font-size:12px">Promote</button>` : ''}
    ${item.status !== 'rejected' ? `<button class="btn" data-capture-reject="${key}" style="padding:4px 10px;font-size:12px">Reject</button>` : ''}
  </div>`;
}

page('capture','Capture triage','batch crawl output · promote / reject / clean up', function(){
  // Lazy-load on first render. Subsequent refreshActivePage() calls reuse the
  // cached list; the Refresh button forces a reload.
  if(!captureBatchesLoaded){
    loadCaptureBatches().then(refreshActivePage);
    return `<div class="card"><div class="eyebrow" style="padding:24px">Loading capture batches…</div></div>`;
  }
  const total = captureBatches.reduce((s,b)=>s+b.items.length, 0);
  const explainer = `<div class="card" style="margin-bottom:14px">
    <div class="card-head"><div><h3>Capture triage</h3><div class="eyebrow">${total} candidate(s) across ${captureBatches.length} batch(es)</div></div>
      <button class="btn" id="captureRefresh">Refresh</button>
    </div>
    <p style="font-size:13px;color:var(--ink-2);line-height:1.6">
      Batches are produced by the CLI crawler: <code style="font-family:var(--mono);background:var(--surface);padding:1px 4px;border-radius:3px">npm run capture-batch -- sources.json</code>.
      Each candidate is a detected section/group of a page. Promote one to pre-fill the entry form (the triage flips to "promoted" once the entry saves);
      reject to drop noise. Clean up removes the batch folder from disk once nothing is pending.
    </p>
  </div>`;
  if(captureBatches.length === 0){
    return `${explainer}<div class="card"><div class="empty" style="padding:60px;color:var(--ink-2);text-align:center">
      No capture batches found. Run <code style="font-family:var(--mono)">npm run capture-batch</code> to crawl a site — batches land under <code style="font-family:var(--mono)">images-private/captures/</code> and appear here.
    </div></div>`;
  }
  return explainer + captureBatches.map(renderCaptureBatch).join('');
}, function after(){
  // Delegated click handlers. We bind one listener per button class via
  // data-* attributes (matches classic-app.js's pattern).
  const refresh = document.getElementById('captureRefresh');
  if(refresh) refresh.addEventListener('click', async ()=>{
    captureBatchesLoaded = false; await loadCaptureBatches(); refreshActivePage();
  });
  document.querySelectorAll('[data-capture-promote]').forEach(b=>{
    b.addEventListener('click', ()=>{ const [batchId, captureId] = b.dataset.capturePromote.split('|'); promoteCapture(batchId, captureId); });
  });
  document.querySelectorAll('[data-capture-reject]').forEach(b=>{
    b.addEventListener('click', ()=>{ const [batchId, captureId] = b.dataset.captureReject.split('|'); rejectCapture(batchId, captureId); });
  });
  document.querySelectorAll('[data-capture-cleanup]').forEach(b=>{
    b.addEventListener('click', ()=>cleanupCaptureBatch(b.dataset.captureCleanup));
  });
});

// Reject a capture candidate — one-shot POST to triage, then reload the list.
async function rejectCapture(batchId, captureId){
  try {
    await request('/api/capture-triage', { method:'POST', body: JSON.stringify({ batchId, captureId, status:'rejected' }) });
    await loadCaptureBatches(); refreshActivePage();
    toast('Marked rejected', 'success');
  } catch(e){ toast(e.message, 'error'); }
}

// Delete a batch folder. Three-layer safety gate: client disabled-button (only
// enabled when nothing is pending), browser confirm(), and the server's 409
// check (re-counts pending). All three must agree.
async function cleanupCaptureBatch(batchId){
  if(!confirm(`Delete the batch folder for ${batchId}? This removes all capture screenshots in that batch from disk.`)) return;
  try {
    await request('/api/capture-cleanup', { method:'POST', body: JSON.stringify({ batchId }) });
    await loadCaptureBatches(); refreshActivePage();
    toast('Batch folder deleted', 'success');
  } catch(e){ toast(e.message, 'error'); }
}

// Promote a capture candidate — pre-fill the entry form with the candidate's
// image + provenance, then route to #/add. The triage status does NOT flip
// here; it flips inside saveDraft() after the entry actually commits (the
// promote is best-effort, gated on save success). _pendingCapture carries the
// {batchId, captureId} through the wizard so saveDraft knows what to flip.
function promoteCapture(batchId, captureId){
  const batch = captureBatches.find(b => b.batchId === batchId);
  if(!batch) return;
  const item = batch.items.find(i => i.id === captureId);
  if(!item) return;
  resetDraft();
  draft.source.productName = item.sourceName || '';
  if(item.sourceUrl) draft.source.url = item.sourceUrl;
  draft.image = { visibility:'private', path: item.imagePath, width:null, height:null };
  draft.title = `${item.sourceName || ''} — (add descriptive subtitle)`;
  draft._pendingCapture = { batchId, captureId };
  draft.provenance = {
    taggedBy: 'auto',
    capture: {
      mode: item.captureMode || '',
      viewport: item.viewport || '',
      capturedAt: item.capturedAt || batch.capturedAt || '',
      sourceUrl: item.sourceUrl || '',
      ...(item.selectorPath ? { selectorPath: item.selectorPath } : {}),
    },
  };
  // Signal to #/add that the draft is pre-seeded and must NOT be reset on arrival.
  _addPreseeded = true;
  location.hash = '/add';
  toast('Prefilled from capture — review, then save to promote', 'success');
}

/* -------- Sources -------- */
page('sources','Sources',`source provenance · ${Object.keys(agg.bySource||{}).length} sources`, function(){
  const N=agg.N||0;
  const max=Math.max(...(agg.topSources||[]).map(d=>d[1]),1);
  const top5share=(agg.topSources||[]).slice(0,5).reduce((s,[,v])=>s+v,0);
  return `
  <div class="strip">
    ${kpi(Object.keys(agg.bySource||{}).length,'','Distinct sources','',`<b>${(agg.topSources||[])[0]?.[1]||0}</b> from top source`)}
    ${kpi(N&&agg.topSources?.length?((agg.topSources[0][1]/N)*100).toFixed(1):0,'%','Top source share','warn',`<b>${(agg.topSources||[])[0]?.[0]||'—'}</b> = ${(agg.topSources||[])[0]?.[1]||0} entries`)}
    ${kpi(N?((top5share/N)*100).toFixed(1):0,'%','Top-5 concentration','warn',`<b>${top5share}</b> of ${N} entries from 5 sources`)}
  </div>
  <div class="card">
    <div class="card-head"><div><h3>Entries by source</h3><div class="eyebrow">all ${Object.keys(agg.bySource||{}).length} sources</div></div></div>
    ${distRows(agg.topSources||[], max, srcColor)}
    ${agg.topSources?.length&&(agg.topSources[0][1]/N>0.25)?`<div style="font-size:11px;color:var(--warn);margin-top:12px;font-family:var(--mono);padding:8px 10px;background:var(--warn-soft);border-radius:6px">⚠ <b>${agg.topSources[0][0]}</b> = ${((agg.topSources[0][1]/N)*100).toFixed(1)}% of corpus — diversify sources to reduce bias</div>`:''}
  </div>`;
});

/* -------- Search index -------- */
page('search','Search index','query layer · vector + lexical index health', function(){
  const N=agg.N||0;
  return `
  <div class="strip">
    ${kpi(N,'','Indexed entries','pos','all entries have a vector')}
    ${kpi(`${HEALTH.entryCount||0}/${N}`,'','Vector coverage','pos','cosine similarity')}
    ${kpi(agg.mobileCount||0,'','Mobile entries','',`${agg.webCount||0} web · ${agg.tabletCount||0} tablet`)}
    ${kpi(HEALTH.snapshotCount||0,'','Snapshots','',`newest ${HEALTH.newestSnapshotAgeMs!=null?Math.round(HEALTH.newestSnapshotAgeMs/3600000)+'h':'?'}`)}
  </div>
  <div class="card">
    <div class="card-head"><div><h3>Live query tester</h3><div class="eyebrow">try a real search against the index</div></div></div>
    <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
      <input id="qtInput" placeholder="e.g. dense dashboard with dark mode" style="flex:1;min-width:240px;height:34px;border:1px solid var(--hairline-2);border-radius:7px;padding:0 12px;font-family:var(--mono);font-size:12px">
      <button class="btn primary" id="qtRun">Search</button>
    </div>
    <div style="font-size:11px;color:var(--muted);margin-bottom:8px;font-family:var(--mono)" id="qtMeta">press Search to run a lexical match against ${N} entries</div>
    <div id="qtResults" style="font-size:12.5px"></div>
  </div>`;
}, function after(){
  const inp=document.getElementById('qtInput'), run=document.getElementById('qtRun');
  const meta=document.getElementById('qtMeta'), res=document.getElementById('qtResults');
  function doSearch(){
    const q=inp.value.trim().toLowerCase(); if(!q){res.innerHTML='';meta.textContent='type a query first';return;}
    const t0=performance.now();
    const scored=E.map(x=>{const hay=(x.id+' '+x.source+' '+x.pattern+' '+x.style+' '+x.title+' '+x.tier+' '+(x.critique||'')).toLowerCase();let s=0;q.split(/\s+/).forEach(t=>{if(hay.includes(t))s++;});return{x,s};}).filter(r=>r.s>0).sort((a,b)=>b.s-a.s).slice(0,5);
    const dt=(performance.now()-t0).toFixed(1);
    meta.textContent=`${scored.length} matches · ${dt}ms · lexical preview (MCP uses vector search)`;
    res.innerHTML = scored.length? scored.map(({x,s})=>`<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--hairline);cursor:pointer" data-id="${x.id}">
      <span class="badge ok" style="min-width:30px;justify-content:center">${s}</span>
      <span class="id" style="flex:1"><b>${x.id.split('-')[0]}</b>${x.id.substring(x.id.indexOf('-'))}</span>
      <span style="color:var(--muted);font-size:11.5px">${x.source} · ${x.pattern}</span>${tierPill(x.tier)}
    </div>`).join('') : `<div class="empty">no lexical matches — try broader terms</div>`;
    res.querySelectorAll('[data-id]').forEach(r=>r.addEventListener('click',()=>{const x=E.find(e=>e.id===r.dataset.id);if(x)openDetail(x);}));
  }
  run.addEventListener('click',doSearch);
  inp.addEventListener('keydown',e=>{if(e.key==='Enter')doSearch();});
});

/* -------- Embeddings -------- */
page('embeddings','Embeddings','vector index · drift detection', function(){
  const N=agg.N||0;
  return `
  <div class="strip">
    ${kpi(N,'','Vectors','pos','one per entry')}
    ${kpi(1024,'','Dimensions','',`voyage-4`)}
    ${kpi(`${HEALTH.entryCount||0}/${N}`,'','Coverage','pos','cosine similarity')}
    ${kpi(0,'','Drift','pos','0 missing · 0 stale')}
  </div>
  <div class="card">
    <div class="card-head"><div><h3>Index maintenance</h3><div class="eyebrow">operations</div></div></div>
    <div style="display:flex;gap:8px">
      <button class="btn" id="embRebuild" style="justify-content:center">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 0115-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 01-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg>
        Rebuild vectors
      </button>
    </div>
    <div style="font-size:11px;color:var(--muted);margin-top:10px;font-family:var(--mono)">run <code>npm run build-index</code> from the terminal</div>
  </div>`;
}, function after(){
  document.getElementById('embRebuild')?.addEventListener('click',()=>toast('Run `npm run build-index` from the terminal'));
});

/* -------- Compare -------- */
page('compare','Compare playground','interactive · compare_ui_examples', function(){
  const opts=E.slice(0,200).map(x=>`<option value="${x.id}">${x.id}</option>`).join('');
  return `
  <div class="card">
    <div class="card-head"><div><h3>Compare entries</h3><div class="eyebrow">select 2–3 entries to see how they differ</div></div></div>
    <div class="grid-3" id="compareSlots">
      ${[0,1,2].map(i=>`<div class="card" style="margin:0;background:var(--canvas)">
        <select class="cmp-sel" data-slot="${i}" style="width:100%;height:32px;border:1px solid var(--hairline-2);border-radius:7px;background:var(--surface);font-family:var(--mono);font-size:11.5px;padding:0 8px">
          <option value="">— pick entry ${i+1} —</option>${opts}
        </select>
        <div class="cmp-body" style="margin-top:12px;font-size:12px"></div>
      </div>`).join('')}
    </div>
  </div>
  <div class="card"><div class="card-head"><div><h3>Comparison matrix</h3></div></div><div id="cmpMatrix"></div></div>`;
}, function after(){
  document.querySelectorAll('.cmp-sel').forEach(sel=>sel.addEventListener('change',renderCmp));
  function renderCmp(){
    const chosen=Array.from(document.querySelectorAll('.cmp-sel')).map(s=>s.value).filter(Boolean);
    document.querySelectorAll('#compareSlots .cmp-body').forEach((body,i)=>{
      const id=chosen[i]; if(!id){body.innerHTML='<div style="color:var(--muted);font-size:11.5px">empty slot</div>';return;}
      const x=E.find(e=>e.id===id); if(!x)return;
      body.innerHTML=`<div style="font-family:var(--mono);font-size:11px;color:var(--ink-2);margin-bottom:8px">${x.id}</div>
        <div class="kv" style="font-size:11.5px">
          <span class="k">Source</span><span class="v" style="display:flex;align-items:center;gap:6px"><span style="width:7px;height:7px;border-radius:50%;background:${srcColor(x.source)};display:inline-block"></span>${x.source}</span>
          <span class="k">Pattern</span><span class="v">${x.pattern}</span><span class="k">Style</span><span class="v">${x.style}</span>
          <span class="k">Tier</span><span class="v">${tierPill(x.tier)}</span><span class="k">Score</span><span class="v">${scoreBar(x.score)} ${x.score}/5</span>
        </div>`;
    });
    const rows=chosen.map(id=>E.find(e=>e.id===id)).filter(Boolean);
    const dims=['source','pattern','style','tier','score','steals'];
    document.getElementById('cmpMatrix').innerHTML = rows.length ? `<table><thead><tr><th>Dimension</th>${rows.map(r=>`<th>${r.id.split('-')[0]}</th>`).join('')}</tr></thead>
      <tbody>${dims.map(d=>`<tr><td style="text-transform:capitalize;color:var(--ink-2)">${d}</td>${rows.map(r=>{let v=r[d];if(d==='tier')v=tierPill(v);if(d==='score')v=scoreBar(v)+' '+v+'/5';return`<td>${v}</td>`;}).join('')}</tr>`).join('')}</tbody></table>` : `<div class="empty">pick at least one entry to compare</div>`;
  }
  renderCmp();
});

/* -------- Quality -------- */
page('quality','Quality triage','scoring rubric · score distribution · outliers', function(){
  const N=agg.N||0;
  const byScore=agg.byScore||{};
  const scoreRows=Object.entries(byScore).sort((a,b)=>+a[0]-+b[0]);
  const maxSc=Math.max(...scoreRows.map(d=>d[1]),1);
  const lowScore=E.filter(x=>x.score===2).slice(0,8);
  const highScore=E.filter(x=>x.score===4).slice(0,8);
  return `
  <div class="strip">
    ${kpi((agg.avgScore||0).toFixed(2),'/5','Average score','warn',`across ${N} entries`)}
    ${kpi(byScore[4]||0,'','4★ entries','',`<span class="delta warn">target: ≥ 50</span>`)}
    ${kpi(byScore[2]||0,'','2★ entries','neg',`${N?((byScore[2]||0)/N*100).toFixed(1):0}% need curation`)}
    ${kpi(agg.cauCount||0,'','Cautionary tier','neg','teach what NOT to do')}
  </div>
  <div class="grid-2">
    <div class="card">
      <div class="card-head"><div><h3>Score distribution</h3><div class="eyebrow">count by quality score</div></div></div>
      ${scoreRows.length?scoreRows.map(([s,c])=>`<div class="dist-row"><span class="nm">${s}★</span>
        <span class="track"><div style="width:${(c/maxSc*100).toFixed(0)}%;background:${+s>=4?'var(--pos)':+s===3?'var(--accent)':'var(--neg)'}"></div></span>
        <span class="v">${c}</span></div>`).join(''):'<div class="empty">no data</div>'}
    </div>
    <div class="card">
      <div class="card-head"><div><h3>Rubric</h3><div class="eyebrow">what each score means</div></div></div>
      <div class="kv" style="grid-template-columns:50px 1fr">
        <span class="v" style="color:var(--neg)">2★</span><span>Weak — generic, few steals</span>
        <span class="v" style="color:var(--accent)">3★</span><span>Solid — usable techniques</span>
        <span class="v" style="color:var(--pos)">4★</span><span>Strong — sharp, reproducible decisions</span>
      </div>
    </div>
  </div>`;
}, function after(){ bindEntryRows(); });

/* -------- Settings -------- */
page('settings','Settings','transport · tools · maintenance', function(){
  const TOOLS=[
    ['search_ui_examples','ranked entries by semantic query'],
    ['get_ui_example','full entry by id'],
    ['get_similar_ui_examples','ranked by vector similarity'],
    ['compare_ui_examples','comparison table across dimensions'],
    ['list_categories','category index + counts'],
    ['list_style_tags','style tag index + counts'],
    ['generate_design_prompt','synthesize a design brief across entries'],
    ['recommend_ui_direction','design advisor from a description'],
    ['get_anti_patterns','consensus mistakes to avoid'],
    ['get_color_palette','paste-ready color token sets'],
    ['get_stealable_techniques','techniques across a category'],
    ['browse_ui_examples','corpus discovery by pattern'],
  ];
  return `
  <div class="grid-2">
    <div class="card">
      <div class="card-head"><div><h3>Transport</h3><div class="eyebrow">MCP server connection</div></div></div>
      <div class="kv">
        <span class="k">Protocol</span><span class="v">stdio</span>
        <span class="k">Command</span><span class="v">node dist/server.js</span>
        <span class="k">Status</span><span class="v"><span class="badge ok">connected</span></span>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><div><h3>Exposed tools</h3><div class="eyebrow">${TOOLS.length} tools</div></div></div>
      <table><thead><tr><th>Tool</th><th>Returns</th></tr></thead><tbody>
        ${TOOLS.map(([t,d])=>`<tr><td><span class="mono" style="font-size:11.5px;color:var(--accent)">${t}</span></td><td style="color:var(--ink-2);font-size:11.5px">${d}</td></tr>`).join('')}
      </tbody></table>
    </div>
  </div>`;
});

/* ============================================================
   EVENT BINDINGS
   ============================================================ */
function bindEntryRows(){
  document.querySelectorAll('tr[data-id]').forEach(tr=>{
    tr.addEventListener('click',(e)=>{ if(e.target.closest('.row-sel,#selAll'))return; const x=E.find(en=>en.id===tr.dataset.id);if(x)openDetail(x); });
  });
  // Row checkboxes — toggle without re-rendering (preserves scroll/page).
  document.querySelectorAll('#entryTable .row-sel').forEach(cb=>{
    if(cb._bound) return; cb._bound=true;
    cb.addEventListener('click', e => e.stopPropagation());
    cb.addEventListener('change', () => toggleRowSelection(cb.dataset.id));
  });
  // Select-all-visible (header checkbox) — toggles every row on this page.
  const sa = document.getElementById('selAll');
  if(sa && !sa._bound){ sa._bound=true;
    sa.addEventListener('click', e => e.stopPropagation());
    sa.addEventListener('change', () => {
      const vis = Array.from(document.querySelectorAll('#entryTable tbody .row-sel')).map(c=>c.dataset.id);
      vis.forEach(id => { (sa.checked ? selection.add(id) : selection.delete(id)); });
      // Reflect in DOM without a full render.
      document.querySelectorAll('#entryTable .row-sel').forEach(cb=>{
        cb.checked = sa.checked;
        const tr = cb.closest('tr'); if(tr) tr.classList.toggle('sel', sa.checked);
      });
      renderSelectionBar();
    });
  }
}

function initSidebar(){
  const app=document.getElementById('app');
  document.getElementById('collapseBtn').addEventListener('click',()=>app.classList.toggle('collapsed'));
  const backdrop=document.getElementById('backdrop');
  const close=()=>app.classList.remove('mobile-open');
  document.getElementById('mobileMenuBtn').onclick=()=>app.classList.toggle('mobile-open');
  document.getElementById('bbMenu').onclick=()=>app.classList.toggle('mobile-open');
  backdrop.addEventListener('click',close);
  document.getElementById('detailClose').addEventListener('click',closeDetail);
  document.getElementById('bbSearch').onclick=()=>{document.querySelector('.topbar .search').classList.toggle('mobile-show');if(document.querySelector('.topbar .search').classList.contains('mobile-show'))document.getElementById('globalSearch').focus();};
  document.getElementById('bbFavs').onclick=()=>{location.hash='/entries';setTimeout(()=>{const fc=document.querySelector('#entryFilters .chip[data-f="fav"]');if(fc)fc.click();},80);};
  document.getElementById('rebuildBtn').addEventListener('click',()=>toast('Run `npm run build-index` from the terminal'));
  document.getElementById('addEntryBtn').addEventListener('click',()=>location.hash='/add');
  document.getElementById('bbAdd').onclick=()=>location.hash='/add';
  const gs=document.getElementById('globalSearch');
  gs.addEventListener('keydown',e=>{if(e.key==='Enter'&&gs.value.trim())location.hash='/entries';});
  document.addEventListener('keydown',e=>{
    const typing=/input|textarea|select/i.test(e.target.tagName);
    if(typing){if(e.key==='Escape')e.target.blur();return;}
    if(e.key==='/'){e.preventDefault();gs.focus();}
    else if(e.key==='Escape'){if(app.classList.contains('mobile-open'))close();else if(document.getElementById('detailRail').style.display==='block')closeDetail();}
    else if((e.metaKey||e.ctrlKey)&&e.key==='b'){e.preventDefault();app.classList.toggle('collapsed');}
  });
  window.addEventListener('hashchange',close);
  window.addEventListener('resize',()=>{if(window.innerWidth>900)close();});
  // resizer
  const resizer=document.getElementById('resizer');
  const DETAIL_KEY='clean-ui-detail-w',DEFAULT_W=320,MIN_W=240,MAX_W=640;
  const savedW=+localStorage.getItem(DETAIL_KEY)||DEFAULT_W;
  document.documentElement.style.setProperty('--detail-w',savedW+'px');
  let dragging=false;
  resizer.addEventListener('mousedown',e=>{dragging=true;app.classList.add('resizing');resizer.classList.add('active');e.preventDefault();});
  document.addEventListener('mousemove',e=>{if(!dragging)return;const w=Math.min(MAX_W,Math.max(MIN_W,window.innerWidth-e.clientX));document.documentElement.style.setProperty('--detail-w',w+'px');});
  document.addEventListener('mouseup',()=>{if(!dragging)return;dragging=false;app.classList.remove('resizing');resizer.classList.remove('active');const cur=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--detail-w'))||DEFAULT_W;localStorage.setItem(DETAIL_KEY,Math.round(cur));});
  resizer.addEventListener('dblclick',()=>{document.documentElement.style.setProperty('--detail-w',DEFAULT_W+'px');localStorage.setItem(DETAIL_KEY,DEFAULT_W);toast('Detail width reset');});
}

window._mcp = { toast };

/* ============================================================
   BOOT
   ============================================================ */
(async function boot(){
  document.getElementById('pages').innerHTML = '<div class="page active"><div class="empty" style="padding:80px">Loading corpus…</div></div>';
  try {
    await loadAll();
    recomputeAgg();
  } catch(e) {
    document.getElementById('pages').innerHTML = `<div class="page active"><div class="empty" style="padding:80px">Failed to load: ${esc(e.message)}</div></div>`;
  }
  renderNav();
  initSidebar();
  window.addEventListener('hashchange',route);
  // Delegated image-error fallback — single registration, survives re-renders.
  // MUST use capture phase: `error` on <img> does not bubble. When an image
  // 404s (file moved, batch cleaned up after promotion, fresh checkout without
  // private images), re-look-up the entry in E and swap in the wireframe so the
  // gallery never shows a broken-image icon.
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.dataset.imgId) return;
    const x = E.find(en => en.id === img.dataset.imgId);
    if (x) img.outerHTML = `<div class="pv-frame">${previewInner(x)}</div>`;
  }, true);
  route();
})();
})();
