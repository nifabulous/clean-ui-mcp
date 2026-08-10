import { sha256, type ColorSchemeCalibrationPacket } from "./color-scheme-calibration.js";

type ImageUrlMap = ReadonlyMap<string, string>;

function escapeEmbeddedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** Render a private, standalone human color-scheme calibration page. */
export function buildColorSchemeCalibrationHtml(packet: ColorSchemeCalibrationPacket, imageUrls: ImageUrlMap): string {
  const data = {
    packet: {
      schemaVersion: packet.schemaVersion,
      artifactType: packet.artifactType,
      artifactId: packet.artifactId,
      auditArtifactId: packet.auditArtifactId,
      auditSha256: packet.auditSha256,
      selectionSha256: packet.selectionSha256,
      detector: packet.detector,
      instructions: packet.instructions,
    },
    packetSha256: sha256(JSON.stringify(packet)),
    entries: packet.entries.map((entry) => ({
      entryId: entry.entryId,
      imagePath: entry.imagePath,
      imageSha256: entry.imageSha256,
      existingColorScheme: entry.existingColorScheme,
      detectedColorScheme: entry.detectedColorScheme,
      medianLuma: entry.medianLuma,
      stratum: entry.stratum,
      imageUrl: imageUrls.get(entry.entryId) ?? null,
    })),
  };
  const embedded = escapeEmbeddedJson(data);
  return `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Color-scheme calibration reviewer</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap');
:root{color-scheme:light dark;--bg:#f5f6f8;--panel:#fff;--ink:#17191d;--muted:#68707c;--line:#d9dde5;--accent:#356ae6;--danger:#c83e3e;--ok:#17834b}
@media(prefers-color-scheme:dark){:root{--bg:#111318;--panel:#191c22;--ink:#f0f2f5;--muted:#a8afbb;--line:#303641;--accent:#8aabff;--danger:#ff817d;--ok:#66d49b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 "DM Sans",ui-sans-serif,system-ui,sans-serif}header{position:sticky;top:0;z-index:5;border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--bg) 90%,transparent);backdrop-filter:blur(12px)}
.bar,main{max-width:1400px;margin:auto}.bar{padding:12px 22px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}.bar h1{font-size:16px;margin:0}.spacer{flex:1}.progress{color:var(--muted)}
button,select,input,textarea{font:inherit}button{border:1px solid var(--line);border-radius:7px;color:var(--ink);background:var(--panel);padding:7px 11px;cursor:pointer}button:hover{border-color:var(--accent)}button.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:650}button.danger{color:var(--danger)}
main{padding:18px 22px 100px}.notice{border:1px solid var(--line);border-radius:10px;background:var(--panel);padding:13px 16px;margin-bottom:16px}.notice.warn{border-color:#d49a36}.notice.error{border-color:var(--danger);color:var(--danger);white-space:pre-wrap}.hidden{display:none!important}
.settings{display:grid;grid-template-columns:minmax(220px,1fr) auto;gap:10px;align-items:end}.settings label{display:grid;gap:5px;color:var(--muted);font-size:12px;font-weight:650}input[type=text],textarea,select{width:100%;border:1px solid var(--line);border-radius:7px;padding:8px 9px;background:var(--panel);color:var(--ink)}textarea{min-height:58px;resize:vertical}
.entry{border:1px solid var(--line);border-radius:12px;background:var(--panel);margin:18px 0;overflow:hidden}.entry.complete{border-color:var(--ok)}.entry-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid var(--line)}.entry-head .id{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}.pill{border:1px solid var(--line);border-radius:99px;color:var(--muted);padding:2px 8px;font-size:11px;text-transform:uppercase}.pill.challenge{border-color:var(--accent);color:var(--accent)}
.entry-grid{display:grid;grid-template-columns:minmax(340px,1.25fr) minmax(360px,1fr);gap:18px;padding:16px;align-items:start}.shot{position:sticky;top:86px}.shot img{display:block;width:100%;max-height:78vh;object-fit:contain;border:1px solid var(--line);border-radius:8px;background:#7773;cursor:zoom-in}.missing{padding:40px 15px;border:1px dashed var(--line);color:var(--muted);text-align:center}.image-meta{color:var(--muted);font-size:11px;margin-top:7px;word-break:break-all}.decision{border:1px solid var(--line);border-radius:9px;padding:13px}.decision.invalid{border-color:var(--danger)}.decision h2{font-size:14px;margin:0 0 3px}.hint{color:var(--muted);font-size:12px;margin:0 0 12px}.choice-row{display:flex;gap:8px;flex-wrap:wrap}.choice-row label{display:flex;align-items:center;gap:6px;color:var(--ink);border:1px solid var(--line);border-radius:7px;padding:8px 11px;font-weight:500;cursor:pointer}.choice-row input{accent-color:var(--accent)}.small{color:var(--muted);font-size:11px}
#lightbox{position:fixed;inset:0;z-index:20;display:none;align-items:center;justify-content:center;padding:20px;background:#000d;cursor:zoom-out}#lightbox.open{display:flex}#lightbox img{max-width:100%;max-height:100%;object-fit:contain}@media(max-width:900px){.entry-grid{grid-template-columns:1fr}.shot{position:static}.settings{grid-template-columns:1fr}}
</style>
<header><div class="bar"><h1>Color-scheme calibration</h1><span class="progress" id="progress">0 / 0 complete</span><span class="spacer"></span><button id="jump">Next incomplete</button><button id="clear" class="danger">Clear draft</button><button id="import">Import JSON</button><input id="import-file" class="hidden" type="file" accept="application/json,.json"><button id="copy" class="primary">Copy JSON</button><button id="download">Download JSON</button></div></header>
<main><div class="notice warn"><strong>Human gold only:</strong> judge the screenshot and supplied evidence, not the existing corpus value, model output, or the detector’s prediction. Choose abstain only when the theme is genuinely ambiguous; abstain requires a reason.</div><div class="notice" id="instructions"></div><div class="notice settings"><label>Reviewer ID<input id="reviewer" type="text" placeholder="e.g. alice" autocomplete="off"></label><span class="small">This packet calibrates a candidate detector. It never edits the corpus.</span></div><div class="notice error hidden" id="errors"></div><section id="entries"></section></main><div id="lightbox"><img alt="Expanded screenshot"></div>
<script>
const DATA=${embedded}, KEY="color-scheme-calibration:"+DATA.packetSha256, state={reviewerId:"",labels:{}};
const $=id=>document.getElementById(id);
function blank(){return{value:"",note:""}}
function init(){DATA.entries.forEach(e=>state.labels[e.entryId]=blank());try{const old=JSON.parse(localStorage.getItem(KEY)||"null");if(old&&old.labels)Object.assign(state,old)}catch(_){}$("reviewer").value=state.reviewerId||""}
function save(){state.reviewerId=$("reviewer").value.trim();try{localStorage.setItem(KEY,JSON.stringify(state))}catch(_){}updateProgress()}
function node(tag,props={},text=""){const n=document.createElement(tag);for(const [key,value] of Object.entries(props)){if(key==="dataset")Object.assign(n.dataset,value);else n[key]=value}if(text)n.textContent=text;return n}
function renderEntry(entry,index){const card=node("article",{className:"entry",dataset:{entryId:entry.entryId}});const head=node("div",{className:"entry-head"});head.append(node("strong",{},String(index+1).padStart(2,"0")),node("span",{className:"id"},entry.entryId),node("span",{className:"pill"},entry.stratum));card.append(head);const grid=node("div",{className:"entry-grid"}),shot=node("div",{className:"shot"});if(entry.imageUrl){const image=node("img",{src:entry.imageUrl,alt:"Screenshot for "+entry.entryId});image.onclick=ev=>{ev.stopPropagation();$("lightbox").classList.add("open");$("lightbox").firstElementChild.src=entry.imageUrl};shot.append(image)}else shot.append(node("div",{className:"missing"},"Image path unavailable"));shot.append(node("div",{className:"image-meta"},entry.imagePath+" · SHA-256 "+entry.imageSha256));grid.append(shot);const decision=node("div",{className:"decision",dataset:{decisionFor:entry.entryId}});decision.append(node("h2",{},"Observed color scheme"),node("p",{className:"hint"},"Judge the dominant canvas and surface theme; ignore accent colors."));const choices=node("div",{className:"choice-row"});[["light","Light"],["dark","Dark"],["abstain","Abstain — ambiguous"]].forEach(([value,labelText])=>{const input=node("input",{type:"radio",name:"scheme-"+entry.entryId,value});input.checked=state.labels[entry.entryId].value===value;input.onchange=()=>{state.labels[entry.entryId].value=value;state.labels[entry.entryId].note="";renderDecision(entry.entryId);save()};const label=node("label");label.append(input,document.createTextNode(labelText));choices.append(label)});decision.append(choices);grid.append(decision);card.append(grid);$("entries").append(card);renderDecision(entry.entryId)}
function renderDecision(id){const root=document.querySelector('[data-decision-for="'+id+'"]');if(!root)return;const stateRow=state.labels[id];root.classList.toggle("invalid",false);const old=root.querySelector("textarea");if(old)old.remove();if(stateRow.value==="abstain"){const note=node("textarea",{placeholder:"Required reason for abstaining"});note.value=stateRow.note||"";note.oninput=()=>{stateRow.note=note.value;save()};root.append(note)}}
function complete(entry){const row=state.labels[entry.entryId];return row.value!==""&&(row.value!=="abstain"||row.note.trim()!=="")}
function updateProgress(){const done=DATA.entries.filter(complete).length;$("progress").textContent=done+" / "+DATA.entries.length+" complete";DATA.entries.forEach(entry=>{const card=document.querySelector('[data-entry="'+entry.entryId+'"]');if(card)card.classList.toggle("complete",complete(entry))})}
function buildSubmission(){const errors=[],labels=[];if(!state.reviewerId)errors.push("Reviewer ID is required.");DATA.entries.forEach(entry=>{const row=state.labels[entry.entryId];if(!row.value)errors.push(entry.entryId+": choose light, dark, or abstain");if(row.value==="abstain"&&!row.note.trim())errors.push(entry.entryId+": explain the abstention");if(row.value)labels.push({entryId:entry.entryId,imageSha256:entry.imageSha256,value:row.value,...(row.value==="abstain"?{note:row.note.trim()}: {})})});if(errors.length)return{errors,payload:null};return{errors:[],payload:{schemaVersion:"1.0",artifactType:"color-scheme-calibration-submission",artifactId:"color-scheme-calibration-submission-"+state.reviewerId+"-v1",packetArtifactId:DATA.packet.artifactId,packetSha256:DATA.packetSha256,reviewerId:state.reviewerId,sealedAt:new Date().toISOString(),labels}}}
function showErrors(errors){const box=$("errors");box.textContent=errors.slice(0,30).join(String.fromCharCode(10))+(errors.length>30?String.fromCharCode(10)+"…":"");box.classList.toggle("hidden",!errors.length);if(errors.length)scrollTo({top:0,behavior:"smooth"})}
function importSubmission(payload){const errors=[];if(!payload||payload.artifactType!=="color-scheme-calibration-submission")errors.push("This file is not a color-scheme calibration submission.");if(payload&&payload.packetArtifactId!==DATA.packet.artifactId)errors.push("The submission belongs to a different packet.");if(payload&&payload.packetSha256!==DATA.packetSha256)errors.push("The submission packet hash does not match.");if(payload&&!Array.isArray(payload.labels))errors.push("The submission has no labels array.");if(errors.length){showErrors(errors);return false}const rows=new Map(payload.labels.map(x=>[x.entryId,x]));const next={};DATA.entries.forEach(entry=>{const row=rows.get(entry.entryId);if(!row){errors.push(entry.entryId+": missing from imported submission");return}if(row.imageSha256!==entry.imageSha256)errors.push(entry.entryId+": image hash does not match this packet");if(!["light","dark","abstain"].includes(row.value))errors.push(entry.entryId+": invalid decision");if(row.value==="abstain"&&!String(row.note||"").trim())errors.push(entry.entryId+": abstention has no reason");next[entry.entryId]={value:row.value||"",note:row.note||""}});if(rows.size!==DATA.entries.length)errors.push("Imported submission contains labels outside this packet.");if(errors.length){showErrors(errors);return false}state.reviewerId=String(payload.reviewerId||"").trim();state.labels=next;$("reviewer").value=state.reviewerId;DATA.entries.forEach(entry=>renderDecision(entry.entryId));save();showErrors([]);alert("Submission imported. Review it, then Copy JSON or Download JSON.");return true}
async function copyJson(){const result=buildSubmission();showErrors(result.errors);if(!result.payload)return;const text=JSON.stringify(result.payload,null,2);try{await navigator.clipboard.writeText(text);alert("Calibration JSON copied to the clipboard.")}catch(_){const area=node("textarea",{value:text});document.body.append(area);area.select();document.execCommand("copy");area.remove();alert("Calibration JSON copied. If it was not, use Download JSON.")}}
function downloadJson(){const result=buildSubmission();showErrors(result.errors);if(!result.payload)return;const blob=new Blob([JSON.stringify(result.payload,null,2)+String.fromCharCode(10)],{type:"application/json"}),a=node("a",{href:URL.createObjectURL(blob),download:result.payload.artifactId+".json"});a.click();URL.revokeObjectURL(a.href)}
function clearDraft(){if(confirm("Clear this reviewer draft?")){localStorage.removeItem(KEY);location.reload()}}
function jumpNext(){const entry=DATA.entries.find(x=>!complete(x));if(entry){const card=document.querySelector('[data-entry="'+entry.entryId+'"]');if(card)card.scrollIntoView({behavior:"smooth",block:"start"})}}
init();DATA.packet.instructions.forEach(x=>$("instructions").append(node("div",{},x)));DATA.entries.forEach(renderEntry);updateProgress();$("reviewer").oninput=save;$("copy").onclick=copyJson;$("download").onclick=downloadJson;$("import").onclick=()=>$("import-file").click();$("import-file").onchange=async ev=>{const file=ev.target.files&&ev.target.files[0];if(!file)return;try{importSubmission(JSON.parse(await file.text()))}catch(_){showErrors(["Could not parse that file as JSON."])}ev.target.value=""};$("clear").onclick=clearDraft;$("jump").onclick=jumpNext;$("lightbox").onclick=ev=>{if(ev.target===ev.currentTarget)$("lightbox").classList.remove("open")};
</script>`;
}
