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
function route(){
  const h = location.hash.replace(/^#\/?/,'') || 'overview';
  const id = PAGES[h] ? h : 'overview';
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.toggle('active', n.dataset.route===id));
  const p = PAGES[id];
  document.getElementById('pageTitle').textContent = p.title;
  document.getElementById('pageCrumb').textContent = p.crumb;
  document.getElementById('pages').innerHTML = `<div class="page active" id="page-${id}">${p.render()}</div>`;
  document.querySelector('.main').scrollTop = 0;
  if(p.after) p.after();
  closeDetail();
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
function toast(msg){
  const t=document.getElementById('toast');
  t.textContent=msg; t.classList.add('on');
  clearTimeout(t._t); t._t=setTimeout(()=>t.classList.remove('on'),2200);
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
  return `<tr data-id="${x.id}">
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
  const pal=(x.dominant||[]).slice(0,5).map(c=>`<span style="background:${c}"></span>`).join('');
  // data-img-id lets the delegated capture-phase error listener (mounted once
  // in the gallery container) re-lookup the entry and swap in the wireframe
  // fallback. No inline onerror — that path was a JSON-into-attribute bug waiting
  // to happen, and `error` doesn't bubble so a regular listener wouldn't fire.
  const thumb = x.imagePath
    ? `<img src="${API}/api/image?path=${encodeURIComponent(x.imagePath)}" alt="${esc(x.title)}" data-img-id="${esc(x.id)}" style="width:100%;height:100%;object-fit:cover;object-position:top;display:block" loading="lazy">`
    : `<div class="pv-frame">${previewInner(x)}</div>`;
  return `<div class="gcard ${fav?'is-fav':''}" data-id="${x.id}">
    <div class="gthumb">
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
      out.innerHTML = slice.length ? `<table id="entryTable"><thead><tr><th>ID</th><th>Source</th><th>Pattern</th><th>Style</th><th>Tier</th><th>Score</th><th class="r">Steals</th><th></th></tr></thead><tbody>${slice.map(entryRow).join('')}</tbody></table>`+pagination(rows.length) : `<div class="empty">No entries match these filters.</div>`;
    }
    out.querySelectorAll('#entryResults .pg, .pages .pg').forEach(b=>b.addEventListener('click',()=>{const p=+b.dataset.pg;if(p>=1&&p<=totalPages){st.page=p;render();document.querySelector('.main').scrollTop=0;}}));
    out.querySelectorAll('.pages .pg').forEach(b=>b.addEventListener('click',()=>{const p=+b.dataset.pg;if(p>=1&&p<=totalPages){st.page=p;render();document.querySelector('.main').scrollTop=0;}}));
    bindGallery(); bindEntryRows();
  }
  function bindGallery(){
    document.querySelectorAll('#entryResults .gcard').forEach(card=>{
      card.addEventListener('click',e=>{ if(e.target.closest('.fav-btn'))return; const x=E.find(en=>en.id===card.dataset.id); if(x)openDetail(x); });
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
let addDraft = null; // { imagePath, productName, url, entry, busy, error }

function addBlank(){
  return { imagePath:null, productName:'', url:'', entry:null, busy:null, error:null, tab:'capture' };
}

async function addDoCapture(form){
  const url = (form.url.value||'').trim();
  const slug = (form.slug.value||'').trim();
  if(!url){ addDraft.error = 'URL is required'; render(); return; }
  addDraft.busy = 'Capturing screenshot…'; addDraft.error = null; render();
  try {
    const r = await fetch(`${API}/api/capture-url`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ url, slug: slug || undefined })
    });
    const j = await r.json();
    if(!r.ok) throw new Error(j.error || 'Capture failed');
    addDraft.imagePath = j.imagePath;
    addDraft.productName = ''; addDraft.url = url;
    addDraft.busy = null;
  } catch(e){
    addDraft.busy = null; addDraft.error = e.message;
  }
  render();
}

function addHandleUpload(file){
  if(!file) return;
  addDraft.busy = 'Uploading…'; addDraft.error = null; render();
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const r = await fetch(`${API}/api/upload-image`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ filename:file.name, slug:addDraft.productName || file.name, dataUrl:reader.result })
      });
      const j = await r.json();
      if(!r.ok) throw new Error(j.error || 'Upload failed');
      addDraft.imagePath = j.imagePath;
      addDraft.busy = null;
    } catch(e){
      addDraft.busy = null; addDraft.error = e.message;
    }
    render();
  };
  reader.onerror = () => { addDraft.busy = null; addDraft.error = 'Could not read file'; render(); };
  reader.readAsDataURL(file);
}

async function addDoAutoTag(){
  if(!addDraft.imagePath){ addDraft.error = 'Capture or upload an image first'; render(); return; }
  addDraft.busy = 'Auto-filling fields…'; addDraft.error = null; render();
  try {
    const r = await fetch(`${API}/api/auto-tag`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ imagePath:addDraft.imagePath, productName:addDraft.productName, url:addDraft.url })
    });
    const j = await r.json();
    if(!r.ok) throw new Error(j.error || 'Auto-fill failed');
    addDraft.entry = j.entry;
    addDraft.busy = null;
  } catch(e){
    addDraft.busy = null; addDraft.error = e.message;
  }
  render();
}

async function addDoSave(form){
  if(!addDraft.entry){ addDraft.error = 'Run Auto-fill first'; render(); return; }
  // Strip leading [DRAFT …] / [DRAFT] markers the tagger inserts as a hygiene
  // forcing function — the validator blocks commits carrying them, and the
  // SPA review step is the human review that justifies stripping them here.
  const strip = s => (typeof s==='string' ? s.replace(/\[(?:DRAFT[^\]]*|PLACEHOLDER[^\]]*|TODO[^\]]*)\]\s*/gi,'').trim() : s);
  const e = addDraft.entry;
  const payload = {
    ...e,
    id: (form.id.value||'').trim() || undefined,
    title: (form.title.value||'').trim() || e.title,
    qualityScore: Number(form.qualityScore.value)||e.qualityScore||3,
    source: { ...e.source, productName:(form.productName.value||'').trim() || e.source.productName },
    critique: strip(form.critique.value) || strip(e.critique),
    whatToSteal: (e.whatToSteal||[]).map(strip),
    antiPatterns: { ...(e.antiPatterns||{}), antiPatterns:((e.antiPatterns?.antiPatterns)||[]).map(strip) },
    reviewStatus: 'approved',
    provenance: { taggedBy:'auto-reviewed', ...(e.provenance||{}) },
  };
  addDraft.busy = 'Saving…'; addDraft.error = null; render();
  try {
    const r = await fetch(`${API}/api/entries`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
    const j = await r.json();
    if(!r.ok) throw new Error(j.issues?.join('; ') || j.error || 'Save failed');
    // Saved — reload corpus and bounce to the new entry's detail.
    await loadAll();
    recomputeAgg();
    addDraft = addBlank();
    location.hash = `#/entry/${encodeURIComponent(j.entry.id)}`;
  } catch(err){
    addDraft.busy = null; addDraft.error = err.message;
    render();
  }
}

page('add','Add entry','new corpus entry', function(){
  if(!addDraft) addDraft = addBlank();
  const d = addDraft;
  const hasImage = !!d.imagePath;
  const hasEntry = !!d.entry;
  // Capture/upload step
  const captureStep = `
    <div class="card-section">
      <div class="eyebrow">Step 1 — capture or upload a screenshot</div>
      ${d.tab==='capture' ? `
        <form id="addCaptureForm" style="margin-top:10px">
          <label>Source URL<input name="url" placeholder="https://linear.app" value="${esc(d.url)}" style="width:100%"></label>
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

  // Image preview
  const previewStep = hasImage ? `
    <div class="card-section">
      <div class="eyebrow">Step 2 — preview</div>
      <figure class="image-preview" style="margin-top:8px">
        <img src="${API}/api/image?path=${encodeURIComponent(d.imagePath)}" alt="captured" style="max-width:100%;border-radius:6px;border:1px solid var(--hr)">
        <figcaption class="image-ready">Image ready: ${esc(d.imagePath)}</figcaption>
      </figure>
      ${hasEntry ? '' : `<button class="btn primary" id="addAutoTag" style="margin-top:8px">✨ Auto-fill fields</button>`}
    </div>` : '';

  // Auto-fill results form
  const reviewStep = hasEntry ? `
    <div class="card-section">
      <div class="eyebrow">Step 3 — review the draft and save</div>
      <form id="addSaveForm" style="margin-top:8px;display:flex;flex-direction:column;gap:10px">
        <label>ID (optional)<input name="id" placeholder="(auto-generated)" style="width:100%"></label>
        <label>Title<input name="title" value="${esc(d.entry.title||'')}" style="width:100%"></label>
        <label>Product name<input name="productName" value="${esc(d.entry.source?.productName||d.productName||'')}" style="width:100%"></label>
        <label>Quality score (1-5)<input name="qualityScore" type="number" min="1" max="5" value="${d.entry.qualityScore||3}" style="width:60px"></label>
        <label>Critique
          <textarea name="critique" rows="6" style="width:100%;font-family:var(--mono);font-size:12px">${esc(d.entry.critique||'')}</textarea>
        </label>
        <details style="font-size:12px;color:var(--ink-2)">
          <summary>Pattern / categories / style (auto-detected)</summary>
          <pre style="white-space:pre-wrap;background:var(--surface);padding:8px;border-radius:4px">${esc(JSON.stringify({patternType:d.entry.patternType, categories:d.entry.categories, styleTags:d.entry.styleTags, platform:d.entry.platform}, null, 2))}</pre>
        </details>
        <button class="btn primary" type="submit">Save entry →</button>
      </form>
    </div>` : '';

  const busyMsg = d.busy ? `<div class="card-section" style="color:var(--accent);font-size:13px">⏳ ${esc(d.busy)}</div>` : '';
  const errorMsg = d.error ? `<div class="card-section" style="color:#c00;font-size:13px">⚠ ${esc(d.error)}</div>` : '';

  return `<div class="card">
    <div class="card-head"><div><h3>Add a single entry</h3><div class="eyebrow">capture → auto-fill → review → save</div></div></div>
    ${busyMsg}${errorMsg}
    ${captureStep}
    ${previewStep}
    ${reviewStep}
  </div>`;
}, function(){
  // after-mount callback — attach form listeners. Looked up by id rather than
  // closure capture so re-renders (which replace the DOM) re-bind cleanly.
  const cap = document.getElementById('addCaptureForm');
  if(cap) cap.addEventListener('submit', e=>{ e.preventDefault(); addDoCapture(e.target); });
  const upSwitch = document.getElementById('addSwitchUpload');
  if(upSwitch) upSwitch.addEventListener('click', ()=>{ addDraft.tab='upload'; render(); });
  const capSwitch = document.getElementById('addSwitchCapture');
  if(capSwitch) capSwitch.addEventListener('click', ()=>{ addDraft.tab='capture'; render(); });
  const fileInput = document.getElementById('addFileInput');
  if(fileInput) fileInput.addEventListener('change', e=>{ addHandleUpload(e.target.files[0]); });
  const at = document.getElementById('addAutoTag');
  if(at) at.addEventListener('click', addDoAutoTag);
  const save = document.getElementById('addSaveForm');
  if(save) save.addEventListener('submit', e=>{ e.preventDefault(); addDoSave(e.target); });
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
    tr.addEventListener('click',()=>{const x=E.find(e=>e.id===tr.dataset.id);if(x)openDetail(x);});
  });
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
