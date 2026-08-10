import { canonicalArtifactJson, sha256, type ColorSchemeCalibrationPacket } from "./color-scheme-calibration.js";

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
    packetSha256: sha256(canonicalArtifactJson(packet)),
    // Deliberately withheld from the page: existingColorScheme,
    // detectedColorScheme, and medianLuma. The reviewer is instructed to ignore
    // the corpus value and the detector's prediction, so neither is shipped
    // where View Source can reach it. The evaluator reads them from the packet
    // JSON instead, and packetSha256 above hashes the full packet, so trimming
    // these fields changes no binding.
    entries: packet.entries.map((entry) => ({
      entryId: entry.entryId,
      imagePath: entry.imagePath,
      imageSha256: entry.imageSha256,
      stratum: entry.stratum,
      imageUrl: imageUrls.get(entry.entryId) ?? null,
    })),
  };
  const embedded = escapeEmbeddedJson(data);
  return `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Color-scheme calibration reviewer</title>
<style>
/* Fonts and styles are local only: this page is opened from disk on a private
   machine and must not issue a network request, so there is no remote
   stylesheet and no font fetch. DM Sans is used when the reviewer has it
   installed; otherwise the system UI stack renders. */
:root{color-scheme:light dark;--bg:#f5f6f8;--panel:#fff;--ink:#17191d;--muted:#68707c;--line:#d9dde5;--accent:#356ae6;--danger:#c83e3e;--ok:#17834b}
@media(prefers-color-scheme:dark){:root{--bg:#111318;--panel:#191c22;--ink:#f0f2f5;--muted:#a8afbb;--line:#303641;--accent:#8aabff;--danger:#ff817d;--ok:#66d49b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 "DM Sans","DM Sans Variable",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}header{position:sticky;top:0;z-index:5;border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--bg) 90%,transparent);backdrop-filter:blur(12px)}
.bar,main{max-width:1400px;margin:auto}.bar{padding:12px 22px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}.bar h1{font-size:16px;margin:0}.spacer{flex:1}.progress{color:var(--muted)}
button,select,input,textarea{font:inherit}button{border:1px solid var(--line);border-radius:7px;color:var(--ink);background:var(--panel);padding:7px 11px;cursor:pointer}button:hover{border-color:var(--accent)}button.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:650}button.danger{color:var(--danger)}
main{padding:18px 22px 100px}.notice{border:1px solid var(--line);border-radius:10px;background:var(--panel);padding:13px 16px;margin-bottom:16px}.notice.warn{border-color:#d49a36}.notice.error{border-color:var(--danger);color:var(--danger);white-space:pre-wrap}.hidden{display:none!important}
.settings{display:grid;grid-template-columns:minmax(220px,1fr) auto;gap:10px;align-items:end}.settings label{display:grid;gap:5px;color:var(--muted);font-size:12px;font-weight:650}input[type=text],textarea,select{width:100%;border:1px solid var(--line);border-radius:7px;padding:8px 9px;background:var(--panel);color:var(--ink)}textarea{min-height:58px;resize:vertical}
.entry{border:1px solid var(--line);border-radius:12px;background:var(--panel);margin:18px 0;overflow:hidden}.entry.complete{border-color:var(--ok)}.entry-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid var(--line)}.entry-head .id{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}.pill{border:1px solid var(--line);border-radius:99px;color:var(--muted);padding:2px 8px;font-size:11px;text-transform:uppercase}
.entry-grid{display:grid;grid-template-columns:minmax(340px,1.25fr) minmax(360px,1fr);gap:18px;padding:16px;align-items:start}.shot{position:sticky;top:86px}.shot img{display:block;width:100%;max-height:78vh;object-fit:contain;border:1px solid var(--line);border-radius:8px;background:#7773;cursor:zoom-in}.missing{padding:40px 15px;border:1px dashed var(--line);color:var(--muted);text-align:center}.image-meta{color:var(--muted);font-size:11px;margin-top:7px;word-break:break-all}.decision{border:1px solid var(--line);border-radius:9px;padding:13px}.decision h2{font-size:14px;margin:0 0 3px}.hint{color:var(--muted);font-size:12px;margin:0 0 12px}.choice-row{display:flex;gap:8px;flex-wrap:wrap}.choice-row label{display:flex;align-items:center;gap:6px;color:var(--ink);border:1px solid var(--line);border-radius:7px;padding:8px 11px;font-weight:500;cursor:pointer}.choice-row input{accent-color:var(--accent)}.small{color:var(--muted);font-size:11px}
#lightbox{position:fixed;inset:0;z-index:20;display:none;align-items:center;justify-content:center;padding:20px;background:#000d;cursor:zoom-out}#lightbox.open{display:flex}#lightbox img{max-width:100%;max-height:100%;object-fit:contain}@media(max-width:900px){.entry-grid{grid-template-columns:1fr}.shot{position:static}.settings{grid-template-columns:1fr}}
</style>
<header><div class="bar"><h1>Color-scheme calibration</h1><span class="progress" id="progress">0 / 0 complete</span><span class="spacer"></span><button id="jump">Next incomplete</button><button id="clear" class="danger">Clear draft</button><button id="import">Import JSON</button><input id="import-file" class="hidden" type="file" accept="application/json,.json"><button id="copy" class="primary">Copy JSON</button><button id="download">Download JSON</button></div></header>
<main><div class="notice warn"><strong>Human gold only:</strong> judge the screenshot and supplied evidence, not the existing corpus value, model output, or the detector&rsquo;s prediction. Choose abstain only when the theme is genuinely ambiguous; abstain requires a reason.</div><div class="notice" id="instructions"></div><div class="notice settings"><label>Reviewer ID<input id="reviewer" type="text" placeholder="e.g. alice" autocomplete="off"></label><span class="small">Enter your ID first: drafts are saved per reviewer, so another reviewer&rsquo;s labels are never shown to you. Screenshots load from the local corpus path. This packet calibrates a candidate detector and never edits the corpus.</span></div><div class="notice error hidden" id="errors"></div><section id="entries"></section></main><div id="lightbox"><img alt="Expanded screenshot"></div>
<script>
const DATA=${embedded}, STORE_KEY="color-scheme-calibration:"+DATA.packetSha256;
const CHOICES=["light","dark","abstain"];
const state={reviewerId:"",labels:blankLabels()};
// Element references are kept in Maps rather than looked up by interpolating an
// entry ID into a CSS selector: IDs are arbitrary corpus strings, and a quote or
// a selector metacharacter would otherwise throw inside querySelector.
const cards=new Map(), decisionRoots=new Map(), radioGroups=new Map();
const $=id=>document.getElementById(id);
function blank(){return{value:"",note:""}}
function blankLabels(){const rows=Object.create(null);DATA.entries.forEach(e=>{rows[e.entryId]=blank()});return rows}
function row(id){return state.labels[id]||blank()}
function readDrafts(){try{const raw=JSON.parse(localStorage.getItem(STORE_KEY)||"null");return raw&&typeof raw==="object"&&raw.drafts&&typeof raw.drafts==="object"?raw.drafts:{}}catch(_){return{}}}
function writeDrafts(drafts){try{localStorage.setItem(STORE_KEY,JSON.stringify({drafts}))}catch(_){}}
// Always rebuild from blanks and copy only rows this packet declares, with the
// types this page expects. A partial or hand-edited draft therefore degrades to
// blanks instead of leaving the page inert.
function sanitizeLabels(stored){const rows=blankLabels();if(!stored||typeof stored!=="object")return rows;DATA.entries.forEach(e=>{const raw=stored[e.entryId];if(!raw||typeof raw!=="object")return;rows[e.entryId]={value:CHOICES.indexOf(raw.value)>=0?raw.value:"",note:typeof raw.note==="string"?raw.note:""}});return rows}
function loadDraft(){state.labels=sanitizeLabels(state.reviewerId?readDrafts()[state.reviewerId]:null);DATA.entries.forEach(e=>renderDecision(e.entryId));updateProgress()}
function save(){if(state.reviewerId){const drafts=readDrafts();drafts[state.reviewerId]=state.labels;writeDrafts(drafts)}updateProgress()}
// Adopt a stored draft only when the newly entered reviewer actually has one.
// Otherwise keep whatever is on screen and persist it under the new ID: a
// reviewer who labels first and types their name afterwards, or who fixes a typo
// in their own ID, must not have their hand-entered labels replaced by blanks.
function onReviewerInput(){const next=$("reviewer").value.trim();if(next===state.reviewerId){return}const stored=next?readDrafts()[next]:null;state.reviewerId=next;if(stored){state.labels=sanitizeLabels(stored);DATA.entries.forEach(e=>renderDecision(e.entryId))}save()}
function node(tag,props={},text=""){const n=document.createElement(tag);for(const [key,value] of Object.entries(props)){if(key==="dataset")Object.assign(n.dataset,value);else n[key]=value}if(text)n.textContent=text;return n}
function renderEntry(entry,index){const card=node("article",{className:"entry",dataset:{entryId:entry.entryId}});const head=node("div",{className:"entry-head"});head.append(node("strong",{},String(index+1).padStart(2,"0")),node("span",{className:"id"},entry.entryId),node("span",{className:"pill"},entry.stratum));card.append(head);const grid=node("div",{className:"entry-grid"}),shot=node("div",{className:"shot"});if(entry.imageUrl){const image=node("img",{src:entry.imageUrl,alt:"Screenshot for "+entry.entryId});image.onclick=ev=>{ev.stopPropagation();$("lightbox").classList.add("open");$("lightbox").firstElementChild.src=entry.imageUrl};shot.append(image)}else shot.append(node("div",{className:"missing"},"Image path unavailable"));shot.append(node("div",{className:"image-meta"},entry.imagePath+" · SHA-256 "+entry.imageSha256));grid.append(shot);const decision=node("div",{className:"decision"});decision.append(node("h2",{},"Observed color scheme"),node("p",{className:"hint"},"Judge the dominant canvas and surface theme; ignore accent colors."));const choices=node("div",{className:"choice-row"}),inputs=[];[["light","Light"],["dark","Dark"],["abstain","Abstain — ambiguous"]].forEach(([value,labelText])=>{const input=node("input",{type:"radio",name:"scheme-"+entry.entryId,value});input.onchange=()=>{state.labels[entry.entryId]={value,note:""};renderDecision(entry.entryId);save()};const label=node("label");label.append(input,document.createTextNode(labelText));choices.append(label);inputs.push(input)});decision.append(choices);grid.append(decision);card.append(grid);$("entries").append(card);cards.set(entry.entryId,card);decisionRoots.set(entry.entryId,decision);radioGroups.set(entry.entryId,inputs);renderDecision(entry.entryId)}
// Syncs the radios as well as the abstain note, so importing or switching
// reviewer cannot leave the controls disagreeing with the state that gets exported.
function renderDecision(id){const current=row(id);(radioGroups.get(id)||[]).forEach(input=>{input.checked=current.value===input.value});const root=decisionRoots.get(id);if(!root)return;const old=root.querySelector("textarea");if(old)old.remove();if(current.value==="abstain"){const note=node("textarea",{placeholder:"Required reason for abstaining"});note.value=current.note||"";note.oninput=()=>{state.labels[id]={value:"abstain",note:note.value};save()};root.append(note)}}
function complete(entry){const current=row(entry.entryId);return current.value!==""&&(current.value!=="abstain"||current.note.trim()!=="")}
function updateProgress(){const done=DATA.entries.filter(complete).length;$("progress").textContent=done+" / "+DATA.entries.length+" complete";DATA.entries.forEach(entry=>{const card=cards.get(entry.entryId);if(card)card.classList.toggle("complete",complete(entry))})}
function buildSubmission(){const errors=[],labels=[];if(!state.reviewerId)errors.push("Reviewer ID is required.");DATA.entries.forEach(entry=>{const current=row(entry.entryId);if(!current.value)errors.push(entry.entryId+": choose light, dark, or abstain");if(current.value==="abstain"&&!current.note.trim())errors.push(entry.entryId+": explain the abstention");if(current.value)labels.push({entryId:entry.entryId,imageSha256:entry.imageSha256,value:current.value,...(current.value==="abstain"?{note:current.note.trim()}: {})})});if(errors.length)return{errors,payload:null};return{errors:[],payload:{schemaVersion:"1.0",artifactType:"color-scheme-calibration-submission",artifactId:"color-scheme-calibration-submission-"+state.reviewerId+"-v1",packetArtifactId:DATA.packet.artifactId,packetSha256:DATA.packetSha256,reviewerId:state.reviewerId,sealedAt:new Date().toISOString(),labels}}}
function showErrors(errors){const box=$("errors");box.textContent=errors.slice(0,30).join(String.fromCharCode(10))+(errors.length>30?String.fromCharCode(10)+"…":"");box.classList.toggle("hidden",!errors.length);if(errors.length)scrollTo({top:0,behavior:"smooth"})}
function importSubmission(payload){const errors=[];if(!payload||payload.artifactType!=="color-scheme-calibration-submission")errors.push("This file is not a color-scheme calibration submission.");if(payload&&payload.packetArtifactId!==DATA.packet.artifactId)errors.push("The submission belongs to a different packet.");if(payload&&payload.packetSha256!==DATA.packetSha256)errors.push("The submission packet hash does not match.");if(payload&&!Array.isArray(payload.labels))errors.push("The submission has no labels array.");if(errors.length){showErrors(errors);return false}const rows=new Map(payload.labels.map(x=>[x&&x.entryId,x]));const next=blankLabels();DATA.entries.forEach(entry=>{const raw=rows.get(entry.entryId);if(!raw){errors.push(entry.entryId+": missing from imported submission");return}if(raw.imageSha256!==entry.imageSha256)errors.push(entry.entryId+": image hash does not match this packet");if(CHOICES.indexOf(raw.value)<0)errors.push(entry.entryId+": invalid decision");const note=typeof raw.note==="string"?raw.note:"";if(raw.value==="abstain"&&!note.trim())errors.push(entry.entryId+": abstention has no reason");next[entry.entryId]={value:CHOICES.indexOf(raw.value)>=0?raw.value:"",note}});if(rows.size!==DATA.entries.length)errors.push("Imported submission contains labels outside this packet.");if(errors.length){showErrors(errors);return false}state.reviewerId=String(payload.reviewerId||"").trim();state.labels=next;$("reviewer").value=state.reviewerId;DATA.entries.forEach(entry=>renderDecision(entry.entryId));save();showErrors([]);alert("Submission imported. Review it, then Copy JSON or Download JSON.");return true}
// Last-resort escape hatch. Opened from disk, a page can have the clipboard API
// unavailable and execCommand disabled; without a visible, pre-selected copy of
// the JSON the reviewer would have no way to get their labels out at all.
function showManualJson(text,message){let box=$("manual-json");if(!box){const wrap=node("div",{className:"notice",id:"manual-json-wrap"});wrap.append(node("strong",{},"Copy this JSON manually"),node("p",{className:"small",id:"manual-json-note"},""),box=node("textarea",{id:"manual-json",readOnly:true,rows:14}));$("entries").before(wrap)}$("manual-json-note").textContent=message;box.value=text;box.focus();box.select();scrollTo({top:0,behavior:"smooth"})}
async function copyJson(){const result=buildSubmission();showErrors(result.errors);if(!result.payload)return;const text=JSON.stringify(result.payload,null,2);try{if(!navigator.clipboard||!navigator.clipboard.writeText)throw new Error("no clipboard");await navigator.clipboard.writeText(text);alert("Calibration JSON copied to the clipboard.");return}catch(_){}let copied=false;try{const area=node("textarea",{value:text});document.body.append(area);area.select();copied=document.execCommand("copy")===true;area.remove()}catch(_){}if(copied){alert("Calibration JSON copied to the clipboard.");return}showManualJson(text,"The browser blocked clipboard access for a page opened from disk. The JSON is selected below: press Cmd-C or Ctrl-C, or use Download JSON.")}
function downloadJson(){const result=buildSubmission();showErrors(result.errors);if(!result.payload)return;const text=JSON.stringify(result.payload,null,2)+String.fromCharCode(10);const name=result.payload.artifactId+".json";try{const url=URL.createObjectURL(new Blob([text],{type:"application/json"})),a=node("a",{href:url,download:name});a.style.display="none";
// The anchor must be in the document when clicked, and the blob URL must outlive
// the click: revoking it on the same tick cancels the download in some browsers.
document.body.append(a);a.click();setTimeout(()=>{a.remove();URL.revokeObjectURL(url)},60000)}catch(_){showManualJson(text,"This browser refused a blob download from a file:// page. The JSON is selected below: copy it and save it as "+name+".")}}
function clearDraft(){if(!state.reviewerId){showErrors(["Enter a reviewer ID to clear that reviewer's draft."]);return}if(confirm("Clear the draft for "+state.reviewerId+"?")){const drafts=readDrafts();delete drafts[state.reviewerId];writeDrafts(drafts);loadDraft();showErrors([])}}
function jumpNext(){const entry=DATA.entries.find(x=>!complete(x));if(!entry)return;const card=cards.get(entry.entryId);if(card)card.scrollIntoView({behavior:"smooth",block:"start"})}
DATA.packet.instructions.forEach(x=>$("instructions").append(node("div",{},x)));DATA.entries.forEach(renderEntry);updateProgress();$("reviewer").oninput=onReviewerInput;$("copy").onclick=copyJson;$("download").onclick=downloadJson;$("import").onclick=()=>$("import-file").click();$("import-file").onchange=async ev=>{const file=ev.target.files&&ev.target.files[0];if(!file)return;try{importSubmission(JSON.parse(await file.text()))}catch(_){showErrors(["Could not parse that file as JSON."])}ev.target.value=""};$("clear").onclick=clearDraft;$("jump").onclick=jumpNext;$("lightbox").onclick=ev=>{if(ev.target===ev.currentTarget)$("lightbox").classList.remove("open")};
</script>`;
}
