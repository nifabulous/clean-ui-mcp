if (window.location.protocol === "file:") {
  window.location.replace("http://localhost:3131/");
}

const API = "/api";
const today = () => new Date().toISOString().slice(0, 10);
const state = {
  entries: [],
  schema: { categories: [], styleTags: [], components: [], domainTags: [], patternTypes: [], spacingDensities: [], cornerStyles: [], imageVisibilities: [] },
  selectedId: null,
  view: "detail",
  query: "",
	  filters: { categories: new Set(), styleTags: new Set() },
	  draft: null,
	  draftMode: "create",
	  uploadedImage: null,
	  bulkQueue: [],
	  bulkDefaultProduct: "",
	  bulkBatchId: null,
	  bulkEditingIndex: null,
	  captureBatches: [],
	  orphans: [],
	  config: { openaiKeyConfigured: false, anthropicKeyConfigured: false, geminiKeyConfigured: false, visionKeyConfigured: false, autoTagProvider: "openai", extractionProvider: "openai", critiqueProvider: "openai", extractionModel: "", critiqueModel: "", envFileLoaded: false, openaiAutoTagModel: "gpt-5.4-nano" },
	};

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
})[char]);
const slugify = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-") || "sample";
const lines = (value) => String(value || "").split("\n").map((line) => line.trim()).filter(Boolean);

// Derive the active provider display name + model from config (mirrors tagger.resolveProvider).
const providerName = () => {
  const p = state.config.autoTagProvider || "openai";
  const has = { openai: state.config.openaiKeyConfigured, claude: state.config.anthropicKeyConfigured, gemini: state.config.geminiKeyConfigured };
  let active = p;
  if (!has[p]) { for (const k of ["openai","claude","gemini"]) { if (has[k]) { active = k; break; } } }
  return { openai: "OpenAI", claude: "Claude", gemini: "Gemini" }[active] || "OpenAI";
};

async function request(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.issues?.join("\n") || data.error || "Request failed";
    throw new Error(message);
  }
  return data;
}

function qualityDots(score) {
  return `<span class="quality">${[1,2,3,4,5].map((n) => `<i class="${n <= score ? "on" : ""}"></i>`).join("")}</span>`;
}

function renderIcons() {
  if (window.lucide) window.lucide.createIcons();
}

// ── Image fallback ─────────────────────────────────────────────────────────
// <img> error events do NOT bubble, so a delegated listener on document can't
// see them via the bubble phase. We register on the CAPTURE phase instead
// (addEventListener('error', fn, true)) — capture fires top-down regardless of
// bubbling, so this catches every thumbnail whose src 404s (e.g. a private
// screenshot deleted between load and render). When an <img data-img-id="…">
// fails, swap it for a colored placeholder div labelled with the entry's title.
function imgFallbackMarkup(id) {
  const entry = state.entries.find((e) => e.id === id);
  const label = entry?.title || entry?.source?.productName || "Image unavailable";
  const accent = entry?.visual?.accentColor || entry?.visual?.dominantColors?.[1] || "#71717a";
  const bg = entry?.visual?.dominantColors?.[0] || "#f4f4f5";
  return `<div class="img-fallback" style="background:${bg};color:${accent}">
    <i data-lucide="image-off"></i><span>${esc(label)}</span>
  </div>`;
}

// Capture-phase listener — see comment above for why `true` is required.
document.addEventListener("error", (event) => {
  const img = event.target;
  if (!(img instanceof HTMLImageElement) || !img.dataset.imgId) return;
  // Avoid loops: only swap if the failing node is still an <img>.
  img.outerHTML = imgFallbackMarkup(img.dataset.imgId);
  renderIcons();
}, true);

async function loadAll({ keepSelection = true } = {}) {
	  const [schema, entries, stats, orphanData, config, health] = await Promise.all([
	    request("/schema"),
	    request("/entries"),
	    request("/stats"),
	    request("/orphans"),
	    request("/config"),
	    request("/health").catch(() => null), // non-critical — stats page degrades without it
	  ]);
	  state.schema = schema;
	  state.entries = entries.entries;
	  state.orphans = orphanData.orphans || [];
	  state.config = config;
	  state.health = health;
  if (!keepSelection || !state.entries.some((entry) => entry.id === state.selectedId)) {
    state.selectedId = state.entries[0]?.id ?? null;
  }
  renderList();
  renderPage();
}

// Filtering moved into the search bar. Tokens prefixed `cat:` or `style:`
// filter by category / style tag; everything else is a free-text term over
// the entry's searchable fields. Replaces the 32 always-visible chip buttons.
function parseQuery(raw) {
  const tokens = raw.toLowerCase().split(/\s+/).filter(Boolean);
  const cats = new Set(), styles = new Set(), terms = [];
  for (const tok of tokens) {
    const cat = tok.match(/^cat:(.+)$/), st = tok.match(/^style:(.+)$/);
    if (cat) cats.add(cat[1]);
    else if (st) styles.add(st[1]);
    else terms.push(tok);
  }
  return { cats, styles, terms };
}

function filteredEntries() {
  const { cats, styles, terms } = parseQuery(state.query || "");
  return state.entries.filter((entry) => {
    if (cats.size && ![entry.patternType, ...entry.categories].some((c) => cats.has(c))) return false;
    if (styles.size && !entry.styleTags.some((s) => styles.has(s))) return false;
    if (!terms.length) return true;
    const haystack = [
      entry.id, entry.title, entry.source.productName, entry.source.url, entry.critique,
      ...entry.whatToSteal, ...(entry.antiPatterns?.antiPatterns || []), ...(entry.antiPatterns?.whereThisFails || []), entry.patternType, ...entry.categories, ...entry.styleTags, ...(entry.components || []), ...(entry.domainTags || []),
      entry.colorScheme, entry.industryVertical, entry.responsiveBehavior, entry.mood,
      ...entry.visual.dominantColors, entry.visual.accentColor, entry.visual.spacingDensity,
      entry.visual.cornerStyle, entry.visual.typePairing.display, entry.visual.typePairing.body,
      entry.visual.typePairing.notes,
    ].filter(Boolean).join(" ").toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

function renderList() {
  const entries = filteredEntries();
  $("#listFooter").textContent = `${entries.length} of ${state.entries.length} entries`;
  $("#entryList").innerHTML = entries.length ? entries.map((entry) => `
    <button class="entry-row ${entry.id === state.selectedId ? "active" : ""}" data-entry-id="${entry.id}">
      <span class="entry-top">
        <span class="product">${esc(entry.source.productName)}</span>
        ${qualityDots(entry.qualityScore)}
      </span>
      <span class="entry-title">${esc(entry.title)}</span>
      <span class="entry-meta">
        ${entry.categories.slice(0, 2).map((cat) => `<span class="mini-tag">${cat}</span>`).join("")}
        ${entry.platform === "mobile" ? `<span class="mini-tag">mobile</span>` : entry.platform === "tablet" ? `<span class="mini-tag">tablet</span>` : ""}
        ${entry.image.path ? `<span class="mini-tag">image</span>` : `<span class="mini-tag">link-only</span>`}
        ${entry.reviewStatus === "draft" ? `<span class="mini-tag draft">draft</span>` : ""}
      </span>
    </button>
  `).join("") : `<div class="empty-state"><div><i data-lucide="search-x"></i><p>No entries match those filters yet — this is a small, hand-picked corpus, so try fewer.</p></div></div>`;
  renderIcons();
}

function setView(view) {
  state.view = view;
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === view));
  if (view === "form" && !state.draft) resetDraft();
  // Fetch capture batches on view entry — they live on disk under
  // images-private/captures and change between visits, so always refresh.
  if (view === "capture") loadCaptureBatches().catch((e) => toast(e.message, "error"));
  renderPage();
}

function selectedEntry() {
  return state.entries.find((entry) => entry.id === state.selectedId) || null;
}

function renderPage() {
  if (state.view === "form") renderForm();
  else if (state.view === "bulk") renderBulk();
  else if (state.view === "stats") renderStatsPage();
  else if (state.view === "capture") renderCapture();
  else renderLibrary();
  renderIcons();
}

// Render the entry's structured layout field as a mini wireframe — this is the
// dogfood proof: the entry's own layout.regions drawn back as a diagram.
function renderLayoutWireframe(layout) {
  if (!layout?.form) return "";
  const widthFlex = (w) => (w === "fixed-narrow" ? "60px" : w === "fixed-wide" ? "120px" : "1fr");
  const isRow = ["two-column", "three-column"].includes(layout.form);
  const style = isRow
    ? `display:grid;grid-template-columns:${layout.regions.map((r) => widthFlex(r.width)).join(" ")};gap:4px`
    : `display:grid;gap:4px`;
  const blocks = layout.regions.map((r) =>
    `<div class="wire-block" data-role="${r.role}"><span>${r.role}</span></div>`
  ).join("");
  return `
    <div class="rail-card">
      <div class="section-title">Layout · ${layout.form}</div>
      <div class="wireframe" style="${style}">${blocks}</div>
    </div>`;
}

function renderLibrary() {
  const entry = selectedEntry();
  if (!entry) {
    $("#page").innerHTML = `<div class="empty-state"><div><i data-lucide="library"></i><p>The corpus starts empty on purpose — pick one example worth defending and add it.</p><button class="btn primary" id="emptyNew"><i data-lucide="plus"></i>New sample</button></div></div>`;
    return;
  }

  const image = entry.image.path
    ? `<img data-img-id="${entry.id}" src="${API}/image?path=${encodeURIComponent(entry.image.path)}" alt="${esc(entry.title)}">${entry.provenance?.capture ? `<span class="pv-capture" title="Real capture — ${esc(entry.provenance.capture.viewport)} ${esc(entry.provenance.capture.mode)}"></span>` : ""}<span class="badge image-badge">${entry.image.visibility}</span>`
    : `<div class="image-empty"><i data-lucide="image-off"></i><span>Link-only sample</span><span class="badge">${entry.image.visibility}</span></div>`;

  // Classify the screenshot shape so the image-stage picks the right fit.
  // Mobile (portrait) screenshots were getting center-cropped to a landscape
  // slot, losing the top and bottom — the most common mobile pattern (actions
  // at the bottom) was invisible. Landscape → cover-crop; portrait → contain,
  // no crop; square → contain in a square slot.
  const stageShape = (() => {
    const w = entry.image.width, h = entry.image.height;
    if (!w || !h) return "is-landscape"; // unknown — default to web (most corpus)
    if (h > w * 1.2) return "is-portrait";   // tall → mobile
    if (w > h * 1.2) return "is-landscape";  // wide → desktop
    return "is-square";                        // roughly equal → tablet/square
  })();

  // ── Attribute rail (right column) — renders only what the entry has.
  // Sibling to .detail-main, not nested inside the critique card.
  const rail = `
    ${entry.layout ? `<section class="panel">${renderLayoutWireframe(entry.layout)}</section>` : ""}
    <section class="panel">
      <div class="panel-head"><div class="panel-title">Visual attributes</div></div>
      <div class="panel-body">
        <div class="attr-grid">
          <div>
            <div class="swatches">
              ${entry.visual.dominantColors.map((c) => `<div class="swatch" style="background:${c}" title="${c}"></div>`).join("")}
              ${entry.visual.accentColor ? `<div class="swatch accent" style="background:${entry.visual.accentColor}" title="accent ${entry.visual.accentColor}"></div>` : ""}
            </div>
          </div>
          <dl>
            <div class="kv"><dt>Spacing</dt><dd>${entry.visual.spacingDensity}</dd></div>
            <div class="kv"><dt>Corners</dt><dd>${entry.visual.cornerStyle}</dd></div>
            <div class="kv"><dt>Shadows</dt><dd>${entry.visual.usesShadows ? "yes" : "no"}</dd></div>
            <div class="kv"><dt>Borders</dt><dd>${entry.visual.usesBorders ? "yes" : "no"}</dd></div>
            <div class="kv"><dt>Display</dt><dd>${entry.visual.typePairing.display || "—"}</dd></div>
            <div class="kv"><dt>Body</dt><dd>${entry.visual.typePairing.body || "—"}</dd></div>
            ${entry.visual.typePairing.notes ? `<div class="kv"><dt>Notes</dt><dd>${esc(entry.visual.typePairing.notes)}</dd></div>` : ""}
          </dl>
        </div>
      </div>
    </section>
    ${entry.visual.colorRoles ? `
    <section class="panel">
      <div class="panel-head"><div class="panel-title">Color roles · token set</div></div>
      <div class="panel-body">
        <div class="color-tokens">
          ${[
            ["canvas", entry.visual.colorRoles.canvas],
            ["surface", entry.visual.colorRoles.surface],
            ["ink", entry.visual.colorRoles.ink],
            entry.visual.colorRoles.muted ? ["muted", entry.visual.colorRoles.muted] : null,
            ["accent", entry.visual.colorRoles.accent],
          ].filter(Boolean).map(([role, hex]) =>
            `<div class="color-token"><span class="color-chip" style="background:${hex}"></span><span class="color-role">${role}</span><span class="color-hex">${hex}</span></div>`
          ).join("")}
        </div>
      </div>
    </section>` : ""}
    ${entry.businessRationale ? `
    <section class="panel">
      <div class="panel-head"><div class="panel-title">Business rationale</div></div>
      <div class="panel-body">
        <dl>
          <div class="kv"><dt>Goal</dt><dd>${esc(entry.businessRationale.businessGoal)}</dd></div>
          <div class="kv"><dt>Target</dt><dd>${esc(entry.businessRationale.targetUser)}</dd></div>
          <div class="kv"><dt>Status</dt><dd>${entry.businessRationale.confirmed ? "confirmed" : "inferred"}</dd></div>
        </dl>
        <div class="voice-tone">${esc(entry.businessRationale.rationale)}</div>
      </div>
    </section>` : ""}
    ${entry.voice ? `
    <section class="panel">
      <div class="panel-head"><div class="panel-title">Voice</div></div>
      <div class="panel-body">
        <div class="voice-tone">${esc(entry.voice.tone)}</div>
        <ul class="voice-examples">${entry.voice.examples.map((ex) => `<li>${esc(ex)}</li>`).join("")}</ul>
        ${entry.voice.avoid.length ? `<div class="voice-avoid">Avoids: ${entry.voice.avoid.map(esc).join("; ")}</div>` : ""}
      </div>
    </section>` : ""}
  `;

  // ── Detail view: unframed hero on top, then main + rail as sibling grid regions.
  // No card-within-card — the panel--spacious wraps the whole thing, but the
  // hero is unframed and the main/rail columns are direct grid children.
  $("#page").innerHTML = `
    <div class="panel panel--spacious">
      <div class="panel-head">
        <div>
          <div class="panel-title tier-label">${esc(entry.source.productName)}</div>
          <div class="panel-sub">${esc(entry.id)} · ${entry.patternType} · ${entry.platform || "web"}</div>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn secondary" id="editSelected"><i data-lucide="pencil"></i>Edit</button>
          <button class="btn danger" id="deleteSelected"><i data-lucide="trash-2"></i>Delete</button>
        </div>
      </div>
      <div class="panel-body">
        <div class="detail-hero">
          <h1 class="sample-title tier-label">${esc(entry.title)}</h1>
          <div class="source-line">
            ${entry.source.url ? `<a href="${esc(entry.source.url)}" target="_blank" rel="noopener">${esc(entry.source.url)}</a>` : `<span>No source URL</span>`}
            <span class="tier-temporal">· ${entry.source.capturedAt}</span>
            ${qualityDots(entry.qualityScore)}
            ${entry.reviewStatus === "draft" ? `<span class="mini-tag draft">draft — hidden from search</span>` : ""}
          </div>
          <div class="tag-row">
            ${entry.categories.map((cat) => `<span class="tag category">${cat}</span>`).join("")}
            ${entry.styleTags.map((tag) => `<span class="tag style">${tag}</span>`).join("")}
            ${(entry.components || []).map((component) => `<span class="tag">${component}</span>`).join("")}
            ${(entry.domainTags || []).map((domain) => `<span class="tag">${domain}</span>`).join("")}
          </div>
        </div>
        <div class="detail-body">
          <div class="detail-main">
            <div class="image-stage ${stageShape}">${image}</div>
            <section class="panel"><div class="panel-body"><h2 class="section-title">Critique</h2><p class="critique">${esc(entry.critique)}</p></div></section>
            <section class="panel"><div class="panel-body"><h2 class="section-title">What to steal</h2><ul class="steal-list">${entry.whatToSteal.map((item) => `<li>${esc(item)}</li>`).join("")}</ul></div></section>
            ${(entry.antiPatterns?.antiPatterns || []).length ? `<section class="panel"><div class="panel-body"><h2 class="section-title">Anti-patterns (mistakes avoided)</h2><ul class="avoid-list">${entry.antiPatterns.antiPatterns.map((item) => `<li>${esc(item)}</li>`).join("")}</ul></div></section>` : ""}
            ${(entry.antiPatterns?.whereThisFails || []).length ? `<section class="panel"><div class="panel-body"><h2 class="section-title">Where copying this fails</h2><ul class="avoid-list">${entry.antiPatterns.whereThisFails.map((item) => `<li>${esc(item)}</li>`).join("")}</ul></div></section>` : ""}
            ${(entry.antiPatterns?.accessibilityRisks || []).length ? `<section class="panel"><div class="panel-body"><h2 class="section-title">Accessibility risks</h2><ul class="avoid-list">${entry.antiPatterns.accessibilityRisks.map((item) => `<li>${esc(item)}</li>`).join("")}</ul></div></section>` : ""}
          </div>
          <div class="detail-rail">${rail}</div>
        </div>
      </div>
    </div>
  `;
}

function blankDraft() {
  return {
    id: "",
    title: "",
    patternType: "dashboard",
    categories: [],
    styleTags: [],
    components: [],
    domainTags: [],
    source: { productName: "", url: null, capturedAt: today(), capturedBy: "self" },
    image: { visibility: "private", path: null, width: null, height: null },
    visual: {
      dominantColors: ["#ffffff", "#111111"],
      accentColor: null,
      typePairing: { display: null, body: null, notes: "" },
      spacingDensity: "moderate",
      cornerStyle: "slight-round",
      usesShadows: false,
      usesBorders: true,
    },
    critique: "",
    whatToSteal: [""],
    antiPatterns: { antiPatterns: [], whereThisFails: [], accessibilityRisks: [] },
    qualityTier: "exceptional",
    qualityScore: 4,
    addedAt: today(),
  };
}

function resetDraft(entry = null) {
  state.draft = entry ? JSON.parse(JSON.stringify(entry)) : blankDraft();
  state.draftMode = entry ? "edit" : "create";
  state.uploadedImage = null;
  state.bulkEditingIndex = null;
}

function syncDraftFromForm() {
  if (!state.draft || !$("#entryForm")) return;
  const form = $("#entryForm");
  const isEditing = state.draftMode === "edit";
  const productName = form.productName.value.trim();
  const title = form.title.value.trim();
  const proposedId = slugify(`${productName}-${title || "sample"}`).slice(0, 80);
  state.draft.id = isEditing && form.id ? form.id.value.trim() || proposedId : "";
  state.draft.title = title;
  state.draft.source.productName = productName;
  state.draft.source.url = form.url.value.trim() || null;
  state.draft.source.capturedAt = form.capturedAt.value;
  state.draft.source.capturedBy = form.capturedBy.value;
  state.draft.categories = [...new Set([
    form.primaryCategory.value,
    ...[...form.querySelectorAll("input[name='categories']:checked")].map((input) => input.value),
  ].filter(Boolean))];
  state.draft.styleTags = [...new Set([
    form.primaryStyleTag.value,
    ...[...form.querySelectorAll("input[name='styleTags']:checked")].map((input) => input.value),
  ].filter(Boolean))];
  state.draft.components = [...new Set(
    [...form.querySelectorAll("input[name='components']:checked")].map((input) => input.value),
  )];
  state.draft.domainTags = [...new Set(
    [...form.querySelectorAll("input[name='domainTags']:checked")].map((input) => input.value),
  )];
  state.draft.patternType = form.patternType.value;
  if (form.platform) state.draft.platform = form.platform.value;
  state.draft.image.visibility = form.visibility.value;
  state.draft.image.path = form.imagePath.value.trim() || null;
  state.draft.image.width = form.imageWidth.value ? Number(form.imageWidth.value) : null;
  state.draft.image.height = form.imageHeight.value ? Number(form.imageHeight.value) : null;
  state.draft.visual.dominantColors = lines(form.dominantColors.value);
  state.draft.visual.accentColor = form.accentColor.value.trim() || null;
  state.draft.visual.typePairing.display = form.displayFont.value.trim() || null;
  state.draft.visual.typePairing.body = form.bodyFont.value.trim() || null;
  state.draft.visual.typePairing.notes = form.typeNotes.value.trim() || undefined;
  state.draft.visual.spacingDensity = form.spacingDensity.value;
  state.draft.visual.cornerStyle = form.cornerStyle.value;
  state.draft.visual.usesShadows = form.usesShadows.checked;
  state.draft.visual.usesBorders = form.usesBorders.checked;
  state.draft.critique = form.critique.value.trim();
  state.draft.whatToSteal = lines(form.whatToSteal.value);
  state.draft.antiPatterns = {
    antiPatterns: lines(form.antiPatterns.value),
    whereThisFails: lines(form.whereThisFails.value),
    accessibilityRisks: lines(form.accessibilityRisks.value),
  };
  // Voice + qualityTier + colorRoles — all optional/advanced.
  if (form.voiceTone && form.voiceTone.value.trim()) {
    state.draft.voice = {
      tone: form.voiceTone.value.trim(),
      examples: lines(form.voiceExamples.value),
      avoid: lines(form.voiceAvoid.value),
    };
  } else {
    state.draft.voice = undefined;
  }
  if (form.colorRolesCanvas && form.colorRolesCanvas.value.trim()) {
    state.draft.visual.colorRoles = {
      canvas: form.colorRolesCanvas.value.trim(),
      surface: form.colorRolesSurface.value.trim(),
      ink: form.colorRolesInk.value.trim(),
      muted: form.colorRolesMuted.value.trim() || null,
      accent: form.colorRolesAccent.value.trim(),
    };
  } else {
    state.draft.visual.colorRoles = undefined;
  }
  state.draft.qualityTier = form.qualityTier ? form.qualityTier.value : "exceptional";
  state.draft.qualityScore = Number(form.qualityScore.value);
  if (form.reviewStatus) state.draft.reviewStatus = form.reviewStatus.value;
  if (form.provenanceTaggedBy) state.draft.provenance = {
    taggedBy: form.provenanceTaggedBy.value,
    ...(state.draft.provenance?.reviewedBy ? { reviewedBy: state.draft.provenance.reviewedBy } : {}),
    // Preserve capture provenance — the promote flow stamps it from the capture
    // manifest, and the provenance select above only edits taggedBy/reviewedBy.
    ...(state.draft.provenance?.capture ? { capture: state.draft.provenance.capture } : {}),
  };
  state.draft.addedAt = form.addedAt.value;
}

function validateDraft() {
  const entry = state.draft;
  const issues = [];
  if (state.draftMode === "edit" && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.id)) issues.push("Use a stable kebab-case id.");
  if (state.draftMode === "edit" && state.entries.some((candidate) => candidate.id === entry.id && candidate.id !== state.selectedId)) issues.push("That id already exists.");
  if (!entry.title) issues.push("Add a title.");
  if (!entry.source.productName) issues.push("Add a product name.");
  if (entry.source.url && !/^https?:\/\/.+/.test(entry.source.url)) issues.push("Use a valid source URL or leave it blank.");
  if (!entry.categories.length) issues.push("Choose at least one category.");
  if (!entry.styleTags.length) issues.push("Choose at least one style tag.");
  if (!entry.visual.dominantColors.length || !entry.visual.dominantColors.every((color) => /^#[0-9a-fA-F]{6}$/.test(color))) issues.push("Dominant colors must be #RRGGBB values.");
  if (entry.visual.accentColor && !/^#[0-9a-fA-F]{6}$/.test(entry.visual.accentColor)) issues.push("Accent color must be #RRGGBB or blank.");
  if (entry.critique.length < 80) issues.push("Critique must be at least 80 characters.");
  if (!entry.whatToSteal.length || entry.whatToSteal.some((item) => item.length < 10)) issues.push("Add at least one concrete technique.");
  if (!entry.antiPatterns || !entry.antiPatterns.antiPatterns || !entry.antiPatterns.antiPatterns.length || entry.antiPatterns.antiPatterns.some((a) => a.length < 10)) issues.push("Add at least one anti-pattern (what mistake does this design avoid?).");
  if (!entry.image.path) issues.push("Capture or upload a screenshot before saving.");
  if (entry.image.visibility !== "private" && (!entry.image.path || !entry.image.width || !entry.image.height)) issues.push("Public images need path, width, and height.");
  if (entry.image.path && !/^(images-private|images-public)\/[^/].+/.test(entry.image.path)) issues.push("Image path must be corpus-relative.");
  // Draft-hygiene gate (mirrors the centralized findDraftMarkers in schema.ts):
  // block save if any text field still carries a [DRAFT]/[PLACEHOLDER]/[TODO] marker.
  const draftTexts = [
    entry.critique, ...entry.whatToSteal,
    ...(entry.antiPatterns?.antiPatterns || []), ...(entry.antiPatterns?.whereThisFails || []), ...(entry.antiPatterns?.accessibilityRisks || []),
    ...(entry.businessRationale ? [entry.businessRationale.targetUser, entry.businessRationale.rationale] : []),
    ...(entry.voice ? [entry.voice.tone, ...entry.voice.examples, ...entry.voice.avoid] : []),
  ];
  if (draftTexts.some((t) => /\[(?:DRAFT|PLACEHOLDER|TODO\b)/i.test(t))) issues.push("Remove all [DRAFT] / [PLACEHOLDER] / [TODO] markers before saving — rewrite those fields in your own words.");
  return issues;
}

function renderForm() {
  if (!state.draft) resetDraft();
  const entry = state.draft;
  const isEditing = state.draftMode === "edit";
  const isLegacyLinkOnly = isEditing && !entry.image.path;
  const keyStatus = state.config.visionKeyConfigured
    ? `<div class="key-status ready">Auto-fill: ${esc(state.config.extractionProvider || "openai")} (${esc(state.config.extractionModel || "?")}) → ${esc(state.config.critiqueProvider || "openai")} (${esc(state.config.critiqueModel || "?")}).</div>`
    : `<div class="key-status missing">Auto-fill needs a vision provider key (OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY) in .env.</div>`;
  const imagePreview = entry.image.path
    ? `<figure class="image-preview"><img data-img-id="${entry.id || "draft"}" src="${API}/image?path=${encodeURIComponent(entry.image.path)}" alt="${esc(entry.title || entry.source.productName || "Captured screenshot")}"><figcaption class="image-ready">Image ready: ${esc(entry.image.path)} (${entry.image.width || "?"} x ${entry.image.height || "?"})</figcaption></figure>`
    : `<div class="image-empty"><i data-lucide="image-off"></i><span>No screenshot yet</span><span class="badge">required for new samples</span></div>`;
  $("#page").innerHTML = `
    <div class="form-layout">
      <section class="panel">
        <div class="panel-head">
          <div><div class="panel-title">${isEditing ? "Edit sample" : "New sample"}</div><div class="panel-sub">${isEditing ? esc(entry.id) : "ID assigned on save"}</div></div>
          <div style="display:flex;gap:6px">
            <button class="btn" id="autoFill"><i data-lucide="wand-sparkles"></i>Auto-fill</button>
            <button class="btn" id="resetForm"><i data-lucide="rotate-ccw"></i>Reset</button>
            <button class="btn primary" id="saveForm"><i data-lucide="save"></i>Save</button>
          </div>
        </div>
        <div class="panel-body">
          <form id="entryForm">
            <div class="starter">
              <strong>Fast path</strong>
              <p>Choose one image source: capture one rendered viewport from a Source URL, or upload a screenshot. Auto-fill and Save use that screenshot.</p>
            </div>
            ${keyStatus}
            ${isLegacyLinkOnly ? `<div class="legacy-note">This is a legacy link-only sample. You can keep editing it, but new samples created here need a screenshot.</div>` : ""}

            <fieldset>
              <legend>Start here</legend>
              <div class="grid-2">
                <label>Product<input name="productName" value="${esc(entry.source.productName)}"></label>
                <label>Source URL <span style="font-weight:400;color:var(--faint)">(used only for capture/attribution)</span><input name="url" value="${esc(entry.source.url)}" placeholder="https://example.com"></label>
              </div>
              <div class="source-actions">
                <button class="source-action" type="button" id="captureSource"><i data-lucide="globe"></i><span>Pull one screenshot from Source URL</span></button>
                <label class="source-action" id="dropzone">
                  <input type="file" id="imageFile" accept="image/png,image/jpeg,image/webp">
                  <i data-lucide="upload"></i>
                  <span>${entry.image.path ? esc(entry.image.path) : "Upload screenshot"}</span>
                </label>
              </div>
              ${imagePreview}
            </fieldset>

            <fieldset>
              <legend>Review draft</legend>
              <label>Title<input name="title" value="${esc(entry.title)}"></label>
              <label>Primary pattern type (the ONE pattern this exemplifies)<select name="patternType">${state.schema.patternTypes.map((p) => `<option value="${p}" ${entry.patternType === p ? "selected" : ""}>${p}</option>`).join("")}</select></label>
              <label>Platform<select name="platform"><option value="web" ${(entry.platform || "web") === "web" ? "selected" : ""}>web (desktop)</option><option value="mobile" ${entry.platform === "mobile" ? "selected" : ""}>mobile (phone)</option><option value="tablet" ${entry.platform === "tablet" ? "selected" : ""}>tablet</option></select></label>
              <div class="grid-2">
                <label>Primary category<select name="primaryCategory"><option value="">Choose one</option>${state.schema.categories.map((cat) => `<option value="${cat}" ${entry.categories[0] === cat ? "selected" : ""}>${cat}</option>`).join("")}</select></label>
                <label>Primary style<select name="primaryStyleTag"><option value="">Choose one</option>${state.schema.styleTags.map((tag) => `<option value="${tag}" ${entry.styleTags[0] === tag ? "selected" : ""}>${tag}</option>`).join("")}</select></label>
              </div>
              <label>Critique<textarea name="critique">${esc(entry.critique)}</textarea></label>
              <label>What to steal<textarea name="whatToSteal">${esc(entry.whatToSteal.join("\n"))}</textarea></label>
              <label>Anti-patterns — what mistake does this design avoid? (one per line, required)<textarea name="antiPatterns" placeholder="e.g. Avoids drop shadows — uses background-color steps for depth instead">${esc((entry.antiPatterns?.antiPatterns || []).join("\n"))}</textarea></label>
            </fieldset>

            <details class="advanced">
              <summary>Advanced metadata</summary>
              <div class="advanced-body">
              <div class="grid-3">
                ${isEditing ? `<label>Entry id<input name="id" value="${esc(entry.id)}"></label>` : `<label>Entry id<input value="Assigned automatically on save" disabled></label>`}
                <label>Captured<input name="capturedAt" type="date" value="${entry.source.capturedAt}"></label>
                <label>Captured by<select name="capturedBy">${["self","automated-collection"].map((v) => `<option ${entry.source.capturedBy === v ? "selected" : ""}>${v}</option>`).join("")}</select></label>
              </div>
              <div class="grid-2">
                <label>Visibility<select name="visibility">${state.schema.imageVisibilities.map((v) => `<option ${entry.image.visibility === v ? "selected" : ""}>${v}</option>`).join("")}</select></label>
                <label>Path<input name="imagePath" value="${esc(entry.image.path || "")}"></label>
              </div>
              <div class="grid-2">
                <label>Width<input name="imageWidth" type="number" min="1" value="${entry.image.width || ""}"></label>
                <label>Height<input name="imageHeight" type="number" min="1" value="${entry.image.height || ""}"></label>
              </div>
              <label>Where copying this fails (one per line, optional)<textarea name="whereThisFails" placeholder="Contexts where lifting this technique would hurt">${esc((entry.antiPatterns?.whereThisFails || []).join("\n"))}</textarea></label>
              <label>Accessibility risks (one per line, optional)<textarea name="accessibilityRisks" placeholder="Specific a11y concerns">${esc((entry.antiPatterns?.accessibilityRisks || []).join("\n"))}</textarea></label>
              <label>Quality tier<select name="qualityTier"><option value="exceptional" ${entry.qualityTier !== "cautionary" ? "selected" : ""}>exceptional (great example)</option><option value="cautionary" ${entry.qualityTier === "cautionary" ? "selected" : ""}>cautionary (bad example — teach what NOT to do)</option></select></label>
              <label>Review state<select name="reviewStatus"><option value="approved" ${(entry.reviewStatus || "approved") !== "draft" ? "selected" : ""}>approved (visible in MCP search)</option><option value="draft" ${entry.reviewStatus === "draft" ? "selected" : ""}>draft (hidden from search — work in progress)</option></select></label>
              <label>Provenance<select name="provenanceTaggedBy"><option value="human" ${entry.provenance?.taggedBy === "human" ? "selected" : ""}>human (hand-authored)</option><option value="auto" ${entry.provenance?.taggedBy === "auto" ? "selected" : ""}>auto (tagger-generated)</option><option value="auto-reviewed" ${(entry.provenance?.taggedBy || "auto-reviewed") === "auto-reviewed" ? "selected" : ""}>auto-reviewed (tagger + human edit)</option></select></label>
              <label>Voice — tone (leave blank if copy isn't notable)<input name="voiceTone" value="${esc(entry.voice?.tone || "")}" placeholder="restrained, confident, slightly dry"></label>
              <label>Voice — real copy examples (one per line)<textarea name="voiceExamples" placeholder="Verbatim copy that defines the voice">${esc((entry.voice?.examples || []).join("\n"))}</textarea></label>
              <label>Voice — what to avoid (one per line, optional)<textarea name="voiceAvoid" placeholder="e.g. no exclamation enthusiasm on financial data">${esc((entry.voice?.avoid || []).join("\n"))}</textarea></label>
              <label>Extra categories<div class="check-grid">${state.schema.categories.map((cat) => `<label class="check-chip"><input type="checkbox" name="categories" value="${cat}" ${entry.categories.slice(1).includes(cat) ? "checked" : ""}><span>${cat}</span></label>`).join("")}</div></label>
              <label>Extra style tags<div class="check-grid">${state.schema.styleTags.map((tag) => `<label class="check-chip"><input type="checkbox" name="styleTags" value="${tag}" ${entry.styleTags.slice(1).includes(tag) ? "checked" : ""}><span>${tag}</span></label>`).join("")}</div></label>
              <label>Visible components<div class="check-grid">${(state.schema.components || []).map((component) => `<label class="check-chip"><input type="checkbox" name="components" value="${component}" ${(entry.components || []).includes(component) ? "checked" : ""}><span>${component}</span></label>`).join("")}</div></label>
              <label>Business domain tags<div class="check-grid">${(state.schema.domainTags || []).map((domain) => `<label class="check-chip"><input type="checkbox" name="domainTags" value="${domain}" ${(entry.domainTags || []).includes(domain) ? "checked" : ""}><span>${domain}</span></label>`).join("")}</div></label>
              <label>Added<input name="addedAt" type="date" value="${entry.addedAt}"></label>
              </div>
            </details>

            <details class="advanced">
              <summary>Advanced visual attributes</summary>
              <div class="advanced-body">
              <div class="grid-2">
                <label>Dominant colors<textarea name="dominantColors">${esc(entry.visual.dominantColors.join("\n"))}</textarea></label>
                <label>Accent color<input name="accentColor" value="${esc(entry.visual.accentColor || "")}" placeholder="#15803d"></label>
              </div>
              <div class="grid-3">
                <label>Spacing<select name="spacingDensity">${state.schema.spacingDensities.map((v) => `<option ${entry.visual.spacingDensity === v ? "selected" : ""}>${v}</option>`).join("")}</select></label>
                <label>Corners<select name="cornerStyle">${state.schema.cornerStyles.map((v) => `<option ${entry.visual.cornerStyle === v ? "selected" : ""}>${v}</option>`).join("")}</select></label>
                <label>Quality<input name="qualityScore" type="number" min="1" max="5" value="${entry.qualityScore}"></label>
              </div>
              <div class="grid-2">
                <label>Display font<input name="displayFont" value="${esc(entry.visual.typePairing.display || "")}"></label>
                <label>Body font<input name="bodyFont" value="${esc(entry.visual.typePairing.body || "")}"></label>
              </div>
              <label>Type notes<input name="typeNotes" value="${esc(entry.visual.typePairing.notes || "")}"></label>
              <div class="check-grid">
                <label class="check-chip"><input type="checkbox" name="usesShadows" ${entry.visual.usesShadows ? "checked" : ""}><span>uses shadows</span></label>
                <label class="check-chip"><input type="checkbox" name="usesBorders" ${entry.visual.usesBorders ? "checked" : ""}><span>uses borders</span></label>
              </div>
              <div class="grid-3">
                <label>Color role · canvas<input name="colorRolesCanvas" value="${esc(entry.visual.colorRoles?.canvas || "")}" placeholder="#fcfcfd"></label>
                <label>Color role · surface<input name="colorRolesSurface" value="${esc(entry.visual.colorRoles?.surface || "")}" placeholder="#ffffff"></label>
                <label>Color role · ink<input name="colorRolesInk" value="${esc(entry.visual.colorRoles?.ink || "")}" placeholder="#18181b"></label>
              </div>
              <div class="grid-2">
                <label>Color role · muted (optional)<input name="colorRolesMuted" value="${esc(entry.visual.colorRoles?.muted || "")}" placeholder="#71717a"></label>
                <label>Color role · accent<input name="colorRolesAccent" value="${esc(entry.visual.colorRoles?.accent || "")}" placeholder="#635bff"></label>
              </div>
              </div>
            </details>
          </form>
        </div>
      </section>
    </div>
  `;
  // Save-check panel renders into the right rail (or inline if rail is hidden).
  const saveCheck = `
    <div class="rail-card">
      <div class="section-title">Save check</div>
      <div class="attr-grid">
        <div class="validation" id="validationPanel"></div>
        <details class="advanced">
          <summary>JSON preview</summary>
          <div class="advanced-body"><pre class="preview-json" id="jsonPreview"></pre></div>
        </details>
      </div>
    </div>`;
  // Validation/save summary — rendered in-page now (no right rail exists).
  $("#page").insertAdjacentHTML("beforeend", `<div class="in-page-rail">${saveCheck}</div>`);
  updatePreview();
}

function updatePreview() {
  syncDraftFromForm();
  const issues = validateDraft();
  $("#validationPanel").innerHTML = issues.length
    ? issues.map((issue) => `<div class="issue"><i data-lucide="circle-alert"></i><span>${esc(issue)}</span></div>`).join("")
    : `<div class="issue ok"><i data-lucide="circle-check"></i><span>Ready to save</span></div>`;
  $("#jsonPreview").textContent = JSON.stringify(state.draft, null, 2);
  $("#saveForm").disabled = issues.length > 0;
  const autoFill = $("#autoFill");
  // Auto-fill needs a vision key + an image. Product name is NOT required —
  // the model reads it off the screenshot when none is supplied.
  if (autoFill) autoFill.disabled = !state.config.visionKeyConfigured || !state.draft.image.path;
  renderIcons();
}

async function saveDraft() {
  syncDraftFromForm();
  const issues = validateDraft();
  if (issues.length) {
    toast(issues[0], "error");
    updatePreview();
    return;
  }
  // Editing a bulk-queue item: write back to the queue, not the corpus.
  if (state.bulkEditingIndex !== null && state.bulkEditingIndex >= 0 && state.bulkQueue[state.bulkEditingIndex]) {
    const idx = state.bulkEditingIndex;
    const prev = state.bulkQueue[idx];
    state.bulkQueue[idx] = { ...JSON.parse(JSON.stringify(state.draft)), _status: prev._status, _error: null, _filename: prev._filename };
    state.bulkEditingIndex = null;
    state.draft = null;
    setView("bulk");
    toast("Updated queue item", "success");
    return;
  }
  const isEditing = state.draftMode === "edit";
  // The promote flow stashes {batchId, captureId} on the draft. Strip it before
  // sending (it's not part of the schema), then flip triage to "promoted" after
  // the entry lands. If triage fails, the entry still saved — just warn.
  const pendingCapture = state.draft._pendingCapture;
  const payload = JSON.parse(JSON.stringify(state.draft));
  delete payload._pendingCapture;
  try {
    const data = await request(isEditing ? `/entries/${encodeURIComponent(state.draft.id)}` : "/entries", {
      method: isEditing ? "PUT" : "POST",
      body: JSON.stringify(payload),
    });
    state.selectedId = data.entry.id;
    state.draft = null;
    if (pendingCapture) {
      try {
        await request("/capture-triage", {
          method: "POST",
          body: JSON.stringify({ batchId: pendingCapture.batchId, captureId: pendingCapture.captureId, status: "promoted" }),
        });
      } catch (triageErr) {
        toast(`Saved, but triage update failed: ${triageErr.message}`, "error");
      }
    }
    await loadAll({ keepSelection: true });
    setView("detail");
    toast("Saved", "success");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function uploadImage(file) {
  if (!file) return;
  syncDraftFromForm();
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  try {
	    const uploaded = await request("/upload-image", {
	      method: "POST",
	      body: JSON.stringify({ filename: file.name, slug: state.draft.title || state.draft.source.productName || file.name, dataUrl }),
	    });
    state.draft.image = {
      visibility: uploaded.visibility,
      path: uploaded.path,
      width: uploaded.width,
      height: uploaded.height,
    };
    renderForm();
	    toast("Image uploaded", "success");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function captureSourceImage() {
  syncDraftFromForm();
  if (!state.draft.source.url) {
    toast("Add a source URL first", "error");
    return;
  }

  const button = $("#captureSource");
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = `<i data-lucide="loader-circle"></i><span>Capturing source</span>`;
  renderIcons();

  try {
    const captured = await request("/capture-url", {
      method: "POST",
      body: JSON.stringify({
	        url: state.draft.source.url,
	        slug: state.draft.title || state.draft.source.productName || "source-screenshot",
	      }),
    });
    state.draft.image = {
      visibility: captured.visibility,
      path: captured.path,
      width: captured.width,
      height: captured.height,
    };
    renderForm();
	    toast("Screenshot captured. Review the preview, then Auto-fill.", "success");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    const nextButton = $("#captureSource");
    if (nextButton) {
      nextButton.disabled = false;
      nextButton.innerHTML = original;
      renderIcons();
    }
  }
}

// Strip any [DRAFT...]/[PLACEHOLDER...]/[TODO...] marker the tagger prepends.
// Matches the centralized server gate (findDraftMarkers in schema.ts) exactly:
// it rejects all three, so the client-side stripper must too — otherwise a row
// auto-critiqued in bulk stays uncommittable. Marker may sit anywhere in the
// string (the model occasionally wraps it mid-sentence), and may repeat, so we
// loop until stable.
function stripDraftMarker(s) {
  if (typeof s !== "string") return s;
  let prev;
  let out = s;
  do {
    prev = out;
    out = out.replace(/\[(?:DRAFT|PLACEHOLDER|TODO)[^\]]*\]\s*/gi, "");
  } while (out !== prev);
  return out.trim();
}

// Apply stripDraftMarker to every free-text field the hygiene gate inspects —
// the same field set entryTextFields() enumerates server-side. Used by both the
// single-sample auto-fill and the bulk critique pass so they share one rule.
function stripMarkersFromEntry(entry) {
  const e = entry;
  if (typeof e.critique === "string") e.critique = stripDraftMarker(e.critique);
  if (Array.isArray(e.whatToSteal)) e.whatToSteal = e.whatToSteal.map(stripDraftMarker);
  if (e.antiPatterns) {
    if (Array.isArray(e.antiPatterns.antiPatterns)) e.antiPatterns.antiPatterns = e.antiPatterns.antiPatterns.map(stripDraftMarker);
    if (Array.isArray(e.antiPatterns.whereThisFails)) e.antiPatterns.whereThisFails = e.antiPatterns.whereThisFails.map(stripDraftMarker);
    if (Array.isArray(e.antiPatterns.accessibilityRisks)) e.antiPatterns.accessibilityRisks = e.antiPatterns.accessibilityRisks.map(stripDraftMarker);
  }
  if (e.voice) {
    if (typeof e.voice.tone === "string") e.voice.tone = stripDraftMarker(e.voice.tone);
    if (Array.isArray(e.voice.examples)) e.voice.examples = e.voice.examples.map(stripDraftMarker);
    if (Array.isArray(e.voice.avoid)) e.voice.avoid = e.voice.avoid.map(stripDraftMarker);
  }
  if (e.businessRationale) {
    if (typeof e.businessRationale.targetUser === "string") e.businessRationale.targetUser = stripDraftMarker(e.businessRationale.targetUser);
    if (typeof e.businessRationale.rationale === "string") e.businessRationale.rationale = stripDraftMarker(e.businessRationale.rationale);
  }
  return e;
}

function cleanTaggedDraft(entry, previous) {
  const cleaned = JSON.parse(JSON.stringify(entry));
  cleaned.title = cleaned.title.replace(" — (add descriptive subtitle)", "");
  stripMarkersFromEntry(cleaned);
  // The server owns id assignment for both new single samples and bulk items.
  // Keep an existing id only when explicitly editing a saved entry (draftMode
  // === "edit" and NOT a bulk-queue edit, which uses bulkEditingIndex).
  const editingSaved = state.draftMode === "edit" && state.bulkEditingIndex === null;
  if (!editingSaved) cleaned.id = "";
  cleaned.image = previous.image;
  // Preserve the user's qualityScore and qualityTier — don't let auto-fill
  // overwrite them. Cautionary entries should stay low-scored.
  cleaned.qualityScore = previous.qualityScore || cleaned.qualityScore || 4;
  if (previous.qualityTier) cleaned.qualityTier = previous.qualityTier;
  // Preserve reviewStatus — auto-fill shouldn't flip a draft to approved.
  if (previous.reviewStatus) cleaned.reviewStatus = previous.reviewStatus;
  // Preserve provenance — auto-fill produces "auto" but a human may have set it.
  if (previous.provenance) cleaned.provenance = previous.provenance;
  // Preserve platform — auto-fill detects it, but a human may have corrected it.
  if (previous.platform) cleaned.platform = previous.platform;
  cleaned.addedAt = previous.addedAt || today();
  return cleaned;
}

// ── Bulk import ────────────────────────────────────────────────────────────
// Mirrors the terminal bulk-import.ts flow: upload → stage blank drafts →
// Auto-fill all (OpenAI vision) → review → commit. The server endpoints are
// unchanged; the browser orchestrates them with a small bounded-concurrency
// pool so we don't fire N simultaneous uploads.

const KNOWN_PRODUCTS = {
  linear:      { name: "Linear",      url: "https://linear.app" },
  stripe:      { name: "Stripe",      url: "https://stripe.com" },
  vercel:      { name: "Vercel",      url: "https://vercel.com" },
  arc:         { name: "Arc",         url: "https://arc.net" },
  notion:      { name: "Notion",      url: "https://notion.so" },
  figma:       { name: "Figma",       url: "https://figma.com" },
  github:      { name: "GitHub",      url: "https://github.com" },
  raycast:     { name: "Raycast",     url: "https://raycast.com" },
  craft:       { name: "Craft",       url: "https://craft.do" },
  loom:        { name: "Loom",        url: "https://loom.com" },
  retool:      { name: "Retool",      url: "https://retool.com" },
  planetscale: { name: "PlanetScale", url: "https://planetscale.com" },
  supabase:    { name: "Supabase",    url: "https://supabase.com" },
  resend:      { name: "Resend",      url: "https://resend.com" },
  clerk:       { name: "Clerk",       url: "https://clerk.com" },
};

function inferProduct(filename) {
  const stem = filename.replace(/\.[^.]+$/, "");
  const slug = stem.split("__")[0].toLowerCase().replace(/[^a-z0-9]/g, "-");
  return KNOWN_PRODUCTS[slug] ?? null;
}

async function runWithPool(tasks, limit, onResult, onError) {
  const queue = [...tasks.entries()];
  let active = 0;
  await new Promise((resolve) => {
    const next = () => {
      while (active < limit && queue.length > 0) {
        const [i, task] = queue.shift();
        active += 1;
        task()
          .then((r) => onResult(r, i))
          .catch((e) => onError(e, i))
          .finally(() => { active -= 1; next(); if (active === 0 && queue.length === 0) resolve(); });
      }
    };
    if (tasks.length === 0) resolve();
    next();
  });
}

function bulkTally() {
  const q = state.bulkQueue;
  return {
    total: q.length,
    staged: q.filter((i) => i._status === "staged").length,
    extraction: q.filter((i) => i._status === "extraction").length,
    tagging: q.filter((i) => i._status === "tagging").length,
    tagged: q.filter((i) => i._status === "tagged").length,
    error: q.filter((i) => i._status === "error").length,
    committed: q.filter((i) => i._status === "committed").length,
  };
}

function renderBulk() {
  const t = bulkTally();
  const keyReady = state.config.visionKeyConfigured;
  const keyStatus = keyReady
    ? `<div class="key-status ready">Auto-fill: ${esc(state.config.extractionProvider || "openai")} (${esc(state.config.extractionModel || "?")}) → ${esc(state.config.critiqueProvider || "openai")} (${esc(state.config.critiqueModel || "?")}).</div>`
    : `<div class="key-status missing">Auto-fill needs a vision provider key in .env. Staging still works; tag later.</div>`;
  const autoFillBtn = `<button class="btn" id="bulkAutoFill" ${(!t.staged || !keyReady) ? "disabled" : ""}><i data-lucide="wand-sparkles"></i>Auto-fill all (${t.staged})</button>`;
  // Deferred Pass 2: only enabled when rows sit in 'extraction' status awaiting
  // critique. This is the button that spends the critique tokens.
  const critiqueBtn = `<button class="btn" id="bulkCritique" ${(!t.extraction || !keyReady) ? "disabled" : ""}><i data-lucide="pen-line"></i>Generate critique (${t.extraction})</button>`;
  const commitBtn = `<button class="btn primary" id="bulkCommit" ${(t.tagged === 0) ? "disabled" : ""}><i data-lucide="save"></i>Commit ready (${t.tagged})</button>`;
  const clearBtn = `<button class="btn" id="bulkClear" ${(state.bulkQueue.length === 0) ? "disabled" : ""}><i data-lucide="trash-2"></i>Clear queue</button>`;

  const queue = state.bulkQueue.length
    ? `<div class="bulk-queue">${state.bulkQueue.map(renderBulkRow).join("")}</div>`
    : `<div class="bulk-empty"><div><i data-lucide="images"></i><p>No files staged yet. Add screenshots to begin.</p></div></div>`;

  $("#page").innerHTML = `
    <div class="form-layout">
      <section class="panel">
        <div class="panel-head">
          <div><div class="panel-title">Bulk import</div><div class="panel-sub">Stage → Auto-fill → Commit</div></div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            ${autoFillBtn}${critiqueBtn}${commitBtn}${clearBtn}
          </div>
        </div>
        <div class="panel-body">
          <div class="starter">
            <strong>How this works</strong>
            <p>Add several screenshots at once. Each becomes a private draft. Click <em>Auto-fill all</em> to draft critique and visual attributes with vision AI, review, then <em>Commit ready</em> to add approved drafts to the corpus.</p>
          </div>
          ${keyStatus}
          <div class="bulk-bar" style="margin-top:14px">
            <label class="btn source-action bulk-add">
              <input type="file" id="bulkFileInput" accept="image/png,image/jpeg,image/webp,application/zip,.zip" multiple hidden>
              <i data-lucide="upload"></i><span>Add files or .zip</span>
            </label>
            <label class="source-action" id="bulkDropzone" style="position:relative">
              <i data-lucide="folder-input"></i><span>Or drop files here</span>
            </label>
            <input class="product-input bulk-default-product" id="bulkDefaultProduct" placeholder="Default product name (used when filename can't infer one)" value="${esc(state.bulkDefaultProduct)}">
          </div>
          ${queue}
        </div>
      </section>

      <aside class="panel">
        <div class="panel-head"><div><div class="panel-title">Queue check</div><div class="panel-sub">Live tally</div></div></div>
        <div class="panel-body">
          <div class="queue-tally">
            <div class="t">Staged <b>${t.staged}</b></div>
            <div class="t">Tagging <b>${t.tagging}</b></div>
            <div class="t">Tagged <b>${t.tagged}</b></div>
            <div class="t">Errors <b>${t.error}</b></div>
          </div>
          <div class="starter" style="margin-top:14px">
            <strong>Notes</strong>
            <p>Auto-fill writes <code>[DRAFT]</code> critique and steal text — rewrite those before or after committing; the validator blocks any entry still carrying a marker. Commit assigns ids server-side and refreshes the library.</p>
          </div>
          ${t.error ? `<div class="legacy-note" style="margin-top:12px">${t.error} item(s) failed. Open the row to see the error, or remove it and re-add.</div>` : ""}
        </div>
      </aside>
    </div>
  `;
}

function renderBulkRow(item, index) {
  const thumb = item.image.path
    ? `<img class="thumb" data-img-id="${item.id || "bulk"}" src="${API}/image?path=${encodeURIComponent(item.image.path)}" alt="">`
    : `<div class="thumb empty"><i data-lucide="image-off"></i></div>`;
  const filename = item._filename || "(unknown)";
  const statusLabel = {
    staged: "Staged", extraction: "Extraction", tagging: "Tagging…", tagged: "Tagged", error: "Error", committing: "Saving…", committed: "Committed",
  }[item._status] || item._status;
  const editable = item._status === "staged" || item._status === "tagged" || item._status === "extraction";
  const productInput = editable
    ? `<input class="product-input" data-bulk-product="${index}" value="${esc(item.source.productName)}" placeholder="Product name">`
    : `<div class="filename">${esc(item.source.productName || "—")}</div>`;
  const errLine = item._error ? `<div class="err">${esc(item._error)}</div>` : "";
  return `
    <div class="bulk-row ${item._status}" data-bulk-index="${index}">
      ${thumb}
      <div class="meta">
        <div class="filename">${esc(filename)}</div>
        ${productInput}
        ${errLine}
      </div>
      <div class="actions">
        <span class="status-chip ${item._status}">${statusLabel}</span>
        <button class="btn remove" data-bulk-remove="${index}" title="Remove"><i data-lucide="x"></i></button>
      </div>
    </div>`;
}

// ── Capture triage ─────────────────────────────────────────────────────────
// Mirrors the bulk-import flow but against the batch-capture pipeline's output
// (corpus/images-private/captures/{batchId}/). Each batch has a manifest of
// CaptureMeta and a triage.json of {captureId: status}. Promote stamps a new
// corpus entry with capture provenance and flips triage to "promoted"; reject
// just flips triage to "rejected"; cleanup deletes the batch dir but only when
// nothing is pending (the server enforces the gate).

async function loadCaptureBatches() {
  const data = await request("/capture-batches");
  state.captureBatches = data.batches || [];
  if (state.view === "capture") renderCapture();
}

function captureTally(batch) {
  return {
    total: batch.items.length,
    pending: batch.items.filter((i) => i.status === "pending").length,
    promoted: batch.items.filter((i) => i.status === "promoted").length,
    rejected: batch.items.filter((i) => i.status === "rejected").length,
  };
}

function renderCapture() {
  const batches = state.captureBatches;
  const empty = `<div class="empty-state"><div><i data-lucide="images"></i><p>No capture batches found. Run <code>npm run capture-batch -- sources.json</code> to crawl a site — batches land under <code>images-private/captures/</code> and show up here for triage.</p></div></div>`;
  const body = batches.length
    ? batches.map(renderCaptureBatch).join("")
    : empty;
  $("#page").innerHTML = `
    <div class="form-layout">
      <section class="panel">
        <div class="panel-head">
          <div><div class="panel-title">Capture triage</div><div class="panel-sub">Review batch captures · promote, reject, clean up</div></div>
          <div style="display:flex;gap:6px">
            <button class="btn" id="captureRefresh"><i data-lucide="refresh-cw"></i>Refresh</button>
          </div>
        </div>
        <div class="panel-body">
          <div class="starter">
            <strong>How this works</strong>
            <p>Each batch is a crawl. <em>Promote</em> opens the entry form prefilled from the capture's manifest and stamps capture provenance on save. <em>Reject</em> marks the capture as rejected without creating an entry. <em>Clean up batch</em> deletes the batch folder once nothing is pending.</p>
          </div>
          ${body}
        </div>
      </section>
    </div>
  `;
}

function renderCaptureBatch(batch) {
  const t = captureTally(batch);
  const cleanable = t.pending === 0 && t.total > 0;
  return `
    <section class="panel" style="margin-top:18px">
      <div class="panel-head">
        <div>
          <div class="panel-title">Batch ${esc(batch.batchId)}</div>
          <div class="panel-sub">${esc(batch.capturedAt)} · ${t.total} capture(s) · ${t.promoted} promoted · ${t.rejected} rejected · ${t.pending} pending</div>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn danger" data-capture-cleanup="${esc(batch.batchId)}" ${cleanable ? "" : "disabled"} title="${cleanable ? "Delete this batch folder" : "Resolve all pending items first"}"><i data-lucide="trash-2"></i>Clean up batch</button>
        </div>
      </div>
      <div class="panel-body">
        <div class="capture-queue">${batch.items.map((item) => renderCaptureRow(batch, item)).join("")}</div>
      </div>
    </section>`;
}

function renderCaptureRow(batch, item) {
  const thumb = `<img class="thumb" data-img-id="capture-${esc(item.id)}" src="${API}/image?path=${encodeURIComponent(item.imagePath)}" alt="">`;
  const statusLabel = { pending: "Pending", promoted: "Promoted", rejected: "Rejected" }[item.status] || item.status;
  // Promote is only meaningful for not-yet-promoted captures; reject only for
  // not-yet-rejected. The triage endpoint is idempotent but the buttons reflect
  // the actionable transition.
  const promoteBtn = item.status !== "promoted"
    ? `<button class="btn" data-capture-promote="${esc(batch.batchId)}|${esc(item.id)}"><i data-lucide="arrow-up-circle"></i>Promote</button>`
    : "";
  const rejectBtn = item.status !== "rejected"
    ? `<button class="btn remove" data-capture-reject="${esc(batch.batchId)}|${esc(item.id)}"><i data-lucide="x-circle"></i>Reject</button>`
    : "";
  return `
    <div class="bulk-row ${item.status}" data-capture-id="${esc(item.id)}">
      ${thumb}
      <div class="meta">
        <div class="filename">${esc(item.id)}</div>
        <div class="filename">${esc(item.sourceName)} · ${esc(item.captureMode)} · ${esc(item.viewport)}</div>
      </div>
      <div class="actions">
        <span class="status-chip ${item.status}">${statusLabel}</span>
        ${promoteBtn}${rejectBtn}
      </div>
    </div>`;
}

// Promote: prefill the entry form from the manifest's data, then on save stamp
// capture provenance and flip triage to "promoted". We stash the pending
// capture on the draft so saveDraft() can read it after the human edits.
async function promoteCapture(batchId, captureId) {
  const batch = state.captureBatches.find((b) => b.batchId === batchId);
  if (!batch) return;
  const item = batch.items.find((i) => i.id === captureId);
  if (!item) return;
  // Build a draft from the manifest: sourceName → productName, imagePath, and a
  // capture-provenance block stamped from the manifest's per-item fields. Earlier
  // this hardcoded sourceUrl:"" and dropped selectorPath, which silently lost the
  // recapture metadata the pipeline exists to record. The server now surfaces
  // these per-item (CaptureBatchItem), so use them.
  const draft = blankDraft();
  draft.source.productName = item.sourceName;
  // Prefer the manifest's per-item sourceUrl for the entry's source.url too —
  // it's the actual page the screenshot came from, which is what source.url
  // is documented to mean.
  if (item.sourceUrl) draft.source.url = item.sourceUrl;
  draft.image = { visibility: "private", path: item.imagePath, width: null, height: null };
  draft.title = `${item.sourceName} — (add descriptive subtitle)`;
  // Stash batchId + captureId so saveDraft flips triage to "promoted" after the
  // entry lands. resetDraft deep-clones, so this survives into state.draft.
  draft._pendingCapture = { batchId, captureId };
  draft.provenance = {
    taggedBy: "auto",
    capture: {
      mode: item.captureMode,
      viewport: item.viewport,
      // Per-item timestamp when present (more accurate than batch-level); fall
      // back to the batch's dir-derived timestamp for older manifests.
      capturedAt: item.capturedAt || batch.capturedAt,
      sourceUrl: item.sourceUrl || "",
      // selectorPath is optional in the schema — only include when the manifest
      // had one. Empty string would also validate (it's a non-required string)
      // but omitting is cleaner.
      ...(item.selectorPath ? { selectorPath: item.selectorPath } : {}),
    },
  };
  resetDraft(draft);
  setView("form");
  toast("Prefilled from capture — review, then save to promote", "success");
}

async function rejectCapture(batchId, captureId) {
  try {
    await request("/capture-triage", {
      method: "POST",
      body: JSON.stringify({ batchId, captureId, status: "rejected" }),
    });
    await loadCaptureBatches();
    toast("Marked rejected", "success");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function cleanupCaptureBatch(batchId) {
  if (!confirm(`Delete the batch folder for ${batchId}? This removes all capture screenshots in that batch from disk.`)) return;
  try {
    await request("/capture-cleanup", {
      method: "POST",
      body: JSON.stringify({ batchId }),
    });
    await loadCaptureBatches();
    toast("Batch folder deleted", "success");
  } catch (error) {
    toast(error.message, "error");
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Recursively expand any .zip files in a File list into their image members,
// so a user can drop "batch-01.zip" (or a folder of zips) instead of selecting
// hundreds of images one by one. Nested zips are unpacked too. Non-image entries
// are skipped. fflate (loaded via unpkg) handles every zip variant; we recurse
// by re-invoking on any extracted .zip.
const IMAGE_EXT_RE = /\.(png|jpe?g|webp)$/i;
const ZIP_EXT_RE = /\.zip$/i;
const RECURSION_LIMIT = 8; // guard against zip-bombs of nested zips

async function unzipOne(file) {
  if (!window.fflate) throw new Error("zip library failed to load (check your connection)");
  const buf = new Uint8Array(await file.arrayBuffer());
  // fflate.unzipSync returns a { name: Uint8Array } map of every entry.
  const entries = window.fflate.unzipSync(buf);
  return Object.entries(entries).map(([name, data]) => ({ name, data }));
}

async function expandFiles(fileList, depth = 0) {
  const out = [];
  for (const file of fileList) {
    const isZip = file.type === "application/zip" || file.type === "application/x-zip-compressed" || ZIP_EXT_RE.test(file.name);
    if (isZip) {
      if (depth >= RECURSION_LIMIT) {
        toast(`Skipping deeply-nested zip (${file.name}) — recursion limit`, "error");
        continue;
      }
      try {
        const entries = await unzipOne(file);
        // Recurse: a zip may contain more zips. Build pseudo-Files from each entry.
        const nested = await Promise.all(entries.map(async ({ name, data }) => {
          const path = name.replace(/^([A-Za-z]:)?[\\/]+/, ""); // strip leading slashes/drives
          // Skip directory entries (name ends with /) and macOS metadata junk.
          if (path.endsWith("/") || /(^|\/)__MACOSX\//.test(path) || /(^|\/)\./.test(path.split("/").pop() || "")) return null;
          if (ZIP_EXT_RE.test(path)) {
            const f = new File([data], path.split("/").pop(), { type: "application/zip" });
            return f;
          }
          if (IMAGE_EXT_RE.test(path)) {
            const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
            const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
            return new File([data], path.split("/").pop(), { type: mime });
          }
          return null;
        }));
        out.push(...(await expandFiles(nested.filter(Boolean), depth + 1)));
      } catch (err) {
        toast(`Could not read ${file.name}: ${err.message}`, "error");
      }
    } else if (IMAGE_EXT_RE.test(file.name)) {
      out.push(file);
    }
  }
  return out;
}

async function enqueueFiles(fileList) {
  // Expand any .zip members (recursing into nested zips) into individual image
  // files first, so the rest of the pipeline (dedup, stage, auto-fill) is
  // unchanged whether the input was loose files or zips.
  const expanded = await expandFiles([...fileList]);
  const files = expanded.filter((f) => /^image\/(png|jpe?g|webp)$/.test(f.type));
  const rejected = expanded.length - files.length;
  if (files.length === 0) {
    toast(rejected ? "No images found (PNG, JPEG, WebP only — check the zip contents)" : "No files selected", "error");
    return;
  }

  // One batchId per enqueue call: the server tracks sibling uploads under this
  // id so the 2nd..Nth near-duplicate in the SAME batch is caught (the old code
  // only checked the committed corpus, so batch siblings all leaked through).
  const batchId = `b${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  state.bulkBatchId = batchId;

  const tasks = files.map((file) => async () => {
    const dataUrl = await readFileAsDataUrl(file);
    const slug = slugify(file.name.replace(/\.[^.]+$/, ""));
    const uploaded = await request("/upload-image", {
      method: "POST",
      body: JSON.stringify({ filename: file.name, slug, dataUrl }),
    });
    // Dedup check: corpus + perceptual hash, AND siblings already staged in
    // this batch (batchId). batch-near = a near-dup of another file uploaded
    // in the same run — the most common leak source.
    const dupCheck = await request("/check-duplicate", {
      method: "POST",
      body: JSON.stringify({ hash: uploaded.hash, dhash: uploaded.dhash, width: uploaded.width, height: uploaded.height, path: uploaded.path, batchId, filename: file.name }),
    });
    if (dupCheck.duplicate) {
      const label = dupCheck.type === "batch-near" ? "near-dup in this batch" : dupCheck.type;
      throw new Error(`Duplicate (${label}) of "${dupCheck.match}" — skipped`);
    }
    const draft = blankDraft();
    const inferred = inferProduct(file.name);
    draft.source.productName = inferred?.name ?? state.bulkDefaultProduct ?? "";
    if (inferred?.url) draft.source.url = inferred.url;
    draft.image = { visibility: uploaded.visibility, path: uploaded.path, width: uploaded.width, height: uploaded.height };
    draft.title = draft.source.productName ? `${draft.source.productName} — (add descriptive subtitle)` : "";
    return { draft, filename: file.name };
  });

  let added = 0;
  await runWithPool(
    tasks,
    3,
    ({ draft, filename }) => {
      state.bulkQueue.push({ ...draft, _status: "staged", _error: null, _filename: filename });
      added += 1;
      renderBulk();
    },
    (err, i) => {
      const filename = files[i]?.name ?? "(unknown)";
      state.bulkQueue.push({ ...blankDraft(), _status: "error", _error: err.message || "Upload failed", _filename: filename, image: { visibility: "private", path: null, width: null, height: null } });
      renderBulk();
    },
  );

  toast(`Staged ${added} of ${files.length} file(s)${rejected ? `; ${rejected} unsupported` : ""}`, added ? "success" : "error");
}

async function autoFillQueue() {
  if (!state.config.visionKeyConfigured) { toast("Add a vision provider key to .env, then restart npm run ui.", "error"); return; }
  const staged = state.bulkQueue
    .map((item, index) => ({ item, index }))
    .filter((x) => x.item._status === "staged");
  if (staged.length === 0) { toast("Nothing staged to auto-fill", "error"); return; }

  // Snapshot the batch default in case the user edits the field mid-run.
  const batchDefault = state.bulkDefaultProduct.trim();

  const tasks = staged.map(({ item, index }) => async () => {
    // Name is optional: per-row → batch default → empty (the vision model reads
    // it off the screenshot). A missing name must NOT block auto-fill — the
    // upload already happened; gating here would waste that work.
    const productName = (item.source.productName || "").trim() || batchDefault;
    state.bulkQueue[index]._status = "tagging";
    state.bulkQueue[index]._error = null;
    renderBulk();
    // Bulk = extraction only, low detail. Halves per-image cost: one cheap
    // vision pass now, critique deferred to 'Generate critique'. Rows land in
    // 'extraction' status (not committable) until critique runs.
    const data = await request("/auto-tag", {
      method: "POST",
      body: JSON.stringify({ imagePath: item.image.path, productName, url: item.source.url || null, imageDetail: "low", extractionOnly: true }),
    });
    // Merge the tagged fields onto the staged draft, preserving its image.
    const cleaned = cleanTaggedDraft(data.entry, item);
    cleaned._filename = item._filename;
    // Preserve the raw extraction so deferred critique (/auto-critique) can
    // re-run Pass 2 without re-sending the image.
    cleaned._raw = data.entry?._raw;
    state.bulkQueue[index] = { ...cleaned, _status: "extraction", _error: null, _filename: item._filename };
    renderBulk();
  });

  let ok = 0;
  await runWithPool(
    tasks,
    3,
    () => { ok += 1; },
    (err, i) => {
      const { index } = staged[i];
      state.bulkQueue[index]._status = "error";
      state.bulkQueue[index]._error = err.message || "Auto-fill failed";
      renderBulk();
    },
  );

  const t = bulkTally();
  toast(`Extracted ${ok}; ${t.extraction} awaiting critique, ${t.error} error(s)`, ok ? "success" : "error");
}

// Deferred Pass 2: run critique (text-only, no image) on every row staged
// extraction-only, flipping them to 'tagged' (committable). This is where the
// deferred cost lands — only paid when you actually want critique drafted.
async function critiqueQueue() {
  if (!state.config.visionKeyConfigured) { toast("Add a vision provider key to .env, then restart npm run ui.", "error"); return; }
  const pending = state.bulkQueue
    .map((item, index) => ({ item, index }))
    .filter((x) => x.item._status === "extraction");
  if (pending.length === 0) { toast("Nothing awaiting critique", "error"); return; }

  const tasks = pending.map(({ item, index }) => async () => {
    if (!item._raw?.extraction) throw new Error("No saved extraction — re-run Auto-fill first");
    state.bulkQueue[index]._status = "tagging";
    renderBulk();
    const data = await request("/auto-critique", {
      method: "POST",
      body: JSON.stringify({ productName: item.source.productName, extraction: item._raw.extraction }),
    });
    const c = data.critique;
    const next = { ...item, _status: "tagged", _error: null };
    // The critique endpoint prepends [DRAFT]/[DRAFT — REWRITE] markers to every
    // field (it's a draft awaiting human review). Strip them on merge — without
    // this, the deferred-critique path stores markered text straight into the
    // queue, and commit fails the hygiene gate on every field at once. The
    // single-sample path strips via cleanTaggedDraft; this mirrors that.
    next.critique = stripDraftMarker(c.critique);
    next.whatToSteal = (c.whatToSteal || []).map(stripDraftMarker);
    next.antiPatterns = c.antiPatterns;
    if (next.antiPatterns) {
      next.antiPatterns.antiPatterns = (next.antiPatterns.antiPatterns || []).map(stripDraftMarker);
      next.antiPatterns.whereThisFails = (next.antiPatterns.whereThisFails || []).map(stripDraftMarker);
      next.antiPatterns.accessibilityRisks = (next.antiPatterns.accessibilityRisks || []).map(stripDraftMarker);
    }
    if (c.voice) {
      next.voice = c.voice;
      next.voice.tone = stripDraftMarker(next.voice.tone || "");
      next.voice.examples = (next.voice.examples || []).map(stripDraftMarker);
      next.voice.avoid = (next.voice.avoid || []).map(stripDraftMarker);
    }
    if (c.qualityTier) next.qualityTier = c.qualityTier;
    if (typeof c.qualityScore === "number") next.qualityScore = c.qualityScore;
    if (c.typographyNotes) next.visual.typePairing.notes = c.typographyNotes;
    if (c.mood) next.mood = c.mood;
    next._raw = { ...item._raw, critique: true };
    state.bulkQueue[index] = next;
    renderBulk();
  });

  let ok = 0;
  await runWithPool(
    tasks,
    3,
    () => { ok += 1; },
    (err, i) => {
      const { index } = pending[i];
      state.bulkQueue[index]._status = "error";
      state.bulkQueue[index]._error = err.message || "Critique failed";
      renderBulk();
    },
  );

  const t = bulkTally();
  toast(`Critiqued ${ok}; ${t.tagged} ready to commit, ${t.error} error(s)`, ok ? "success" : "error");
}

async function commitQueue() {
  const ready = state.bulkQueue
    .map((item, index) => ({ item, index }))
    .filter((x) => x.item._status === "tagged");
  if (ready.length === 0) { toast("Nothing ready to commit (auto-fill first)", "error"); return; }

  let committed = 0;
  let duplicateSkipped = 0;
  const tasks = ready.map(({ item, index }) => async () => {
    state.bulkQueue[index]._status = "committing";
    renderBulk();
    // Server assigns a unique id; strip any client-side id first.
    const payload = JSON.parse(JSON.stringify(item));
    payload.id = "";
    // Commit is the authoritative dedup gate (POST /entries re-checks against
    // the live corpus). Read the response directly so a 409 duplicate can be
    // marked distinctly from a validation error — a duplicate isn't a failure,
    // it's the gate catching something the upload-time check missed.
    const response = await fetch(`${API}/entries`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 409 && data.duplicate) {
      state.bulkQueue[index]._status = "error";
      state.bulkQueue[index]._error = `Duplicate (${data.type}) of ${data.match} — skipped`;
      duplicateSkipped += 1;
      renderBulk();
      return;
    }
    if (!response.ok) {
      const message = data.issues?.join("\n") || data.error || "Commit failed (validation)";
      throw new Error(message);
    }
    state.bulkQueue[index]._status = "committed";
    committed += 1;
    renderBulk();
  });

  await runWithPool(
    tasks,
    3,
    () => {},
    (err, i) => {
      const { index } = ready[i];
      state.bulkQueue[index]._status = "error";
      state.bulkQueue[index]._error = err.message || "Commit failed (validation)";
      renderBulk();
    },
  );

  // Drop committed rows, keep errors for review.
  state.bulkQueue = state.bulkQueue.filter((i) => i._status !== "committed");
  await loadAll();
  renderBulk();
  const parts = [`Committed ${committed} to corpus`];
  if (duplicateSkipped) parts.push(`${duplicateSkipped} duplicate${duplicateSkipped === 1 ? "" : "s"} skipped`);
  const errs = state.bulkQueue.filter((i) => i._status === "error" && !/Duplicate/.test(i._error || "")).length;
  if (errs) parts.push(`${errs} error(s)`);
  toast(parts.join(" · "), committed ? "success" : (duplicateSkipped && !errs ? "success" : "error"));
}

function bulkRemoveAt(index) {
  state.bulkQueue.splice(index, 1);
  renderBulk();
}

function bulkEditAt(index) {
  // Open a tagged/staged draft in the full editor; on save it returns here.
  const item = state.bulkQueue[index];
  if (!item) return;
  resetDraft(JSON.parse(JSON.stringify(item)));
  state.draftMode = "create"; // server owns id assignment on commit
  state.bulkEditingIndex = index; // set AFTER resetDraft (which clears it)
  setView("form");
}

async function autoFillDraft() {
  syncDraftFromForm();
  if (!state.config.visionKeyConfigured) {
    toast("Add a vision provider key to .env, then restart npm run ui.", "error");
    return;
  }
  if (!state.draft.image.path) {
    toast("Upload a screenshot or pull one from Source URL first", "error");
    return;
  }
  // No productName guard: the vision model infers it from the screenshot when
  // none is supplied, so a missing name never blocks auto-fill.

  const button = $("#autoFill");
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = `<i data-lucide="loader-circle"></i>Analyzing`;
  renderIcons();

  try {
    const data = await request("/auto-tag", {
      method: "POST",
      body: JSON.stringify({
        imagePath: state.draft.image.path,
        productName: state.draft.source.productName,
        url: state.draft.source.url || null,
	        id: state.draftMode === "edit" ? state.draft.id : undefined,
      }),
    });
    state.draft = cleanTaggedDraft(data.entry, state.draft);
    renderForm();
    toast("Auto-filled from image", "success");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    const nextButton = $("#autoFill");
    if (nextButton) {
      nextButton.disabled = false;
      nextButton.innerHTML = original;
      renderIcons();
    }
  }
}

// Recovery surface — shows snapshot count + newest age so the curator knows
// their work is recoverable. Falls back gracefully if /api/health is absent.
function recoveryLine() {
  const h = state.health;
  if (!h || !h.snapshotCount) {
    return `<div class="panel-sub" style="margin-top:12px">Recovery: no snapshots yet — your first save creates one.</div>`;
  }
  const age = h.newestSnapshotAgeMs != null ? ageLabel(h.newestSnapshotAgeMs) : "unknown";
  return `<div class="panel-sub" style="margin-top:12px">Recovery: ${h.snapshotCount} snapshot${h.snapshotCount === 1 ? "" : "s"} retained · newest ${age}. Recover with <code>npm run restore-corpus -- --list</code></div>`;
}
function ageLabel(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function renderStatsPage() {
  const byCategory = {};
  const byStyle = {};
  const imageCount = state.entries.filter((entry) => !!entry.image.path).length;
  const legacyCount = state.entries.filter((entry) => !entry.image.path).length;
  for (const entry of state.entries) {
    entry.categories.forEach((cat) => byCategory[cat] = (byCategory[cat] || 0) + 1);
    entry.styleTags.forEach((tag) => byStyle[tag] = (byStyle[tag] || 0) + 1);
  }
  const rows = (object) => Object.entries(object).sort((a, b) => b[1] - a[1]).map(([name, count]) =>
    `<div class="kv"><dt>${esc(name)}</dt><dd>${count}</dd></div>`
  ).join("");
	  $("#page").innerHTML = `
	    <div class="detail-layout">
	      <section class="panel">
	        <div class="panel-head"><div><div class="panel-title">Category coverage</div><div class="panel-sub">${Object.keys(byCategory).length} represented</div></div></div>
	        <div class="panel-body"><dl>${rows(byCategory) || `<div class="panel-sub">No data</div>`}</dl></div>
	      </section>
	      <aside class="panel">
	        <div class="panel-head"><div><div class="panel-title">Corpus health</div><div class="panel-sub">${imageCount} image samples, ${legacyCount} legacy link-only</div></div></div>
	        <div class="panel-body attr-grid">
	          <div>
	            <div class="section-title">Style coverage</div>
	            <dl>${rows(byStyle) || `<div class="panel-sub">No data</div>`}</dl>
	          </div>
	          <div>
	            <div class="section-title">Unused private images</div>
	            <div class="cleanup-row">
	              <p class="small-copy">${state.orphans.length ? `${state.orphans.length} uploaded or captured file${state.orphans.length === 1 ? "" : "s"} are not referenced by any entry.` : "No orphaned private screenshots found."}</p>
	              <button class="btn danger" id="cleanupOrphans" ${state.orphans.length ? "" : "disabled"}><i data-lucide="trash-2"></i>Clean up</button>
	            </div>
	            ${state.orphans.length ? `<div class="panel-sub">${state.orphans.slice(0, 6).map(esc).join("<br>")}${state.orphans.length > 6 ? "<br>..." : ""}</div>` : ""}
	          </div>
	        </div>
	        ${recoveryLine()}
	      </aside>
	    </div>
	  `;
}

async function cleanupOrphans() {
  if (!state.orphans.length) return;
  if (!confirm(`Delete ${state.orphans.length} unused private screenshot file${state.orphans.length === 1 ? "" : "s"}?`)) return;
  try {
    const result = await request("/orphans", { method: "DELETE" });
    await loadAll({ keepSelection: true });
    setView("stats");
    toast(`Deleted ${result.count} unused file${result.count === 1 ? "" : "s"}`, "success");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function deleteSelected() {
  const entry = selectedEntry();
  if (!entry || !confirm(`Delete ${entry.title}?`)) return;
  try {
    await request(`/entries/${encodeURIComponent(entry.id)}`, { method: "DELETE" });
    state.selectedId = null;
    await loadAll({ keepSelection: false });
    toast("Deleted", "success");
  } catch (error) {
    toast(error.message, "error");
  }
}

function toast(message, type = "") {
  const el = $("#toast");
  el.textContent = message;
  el.className = `toast show ${type}`;
  clearTimeout(window.toastTimer);
  window.toastTimer = setTimeout(() => el.classList.remove("show"), 2800);
}

document.addEventListener("click", (event) => {
  const entryButton = event.target.closest("[data-entry-id]");
  if (entryButton) {
    state.selectedId = entryButton.dataset.entryId;
    state.view = "detail";
    document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === "detail"));
    renderList();
    renderPage();
    return;
  }
  const tab = event.target.closest(".tab");
  if (tab) setView(tab.dataset.view);
  if (event.target.closest("#newBtn") || event.target.closest("#emptyNew")) {
    resetDraft();
    setView("form");
  }
  if (event.target.closest("#refreshBtn")) loadAll().then(() => toast("Refreshed", "success")).catch((error) => toast(error.message, "error"));
  if (event.target.closest("#editSelected")) {
    const entry = selectedEntry();
    if (entry) {
      resetDraft(entry);
      setView("form");
    }
  }
	  if (event.target.closest("#deleteSelected")) deleteSelected();
	  if (event.target.closest("#cleanupOrphans")) cleanupOrphans();
  if (event.target.closest("#resetForm")) {
    resetDraft();
    renderForm();
  }
  if (event.target.closest("#captureSource")) captureSourceImage();
  if (event.target.closest("#autoFill")) autoFillDraft();
  if (event.target.closest("#saveForm")) saveDraft();
  // ── bulk import wiring ──
  if (event.target.closest("#bulkAutoFill")) autoFillQueue();
  if (event.target.closest("#bulkCritique")) critiqueQueue();
  if (event.target.closest("#bulkCommit")) commitQueue();
  if (event.target.closest("#bulkClear")) { state.bulkQueue = []; renderBulk(); }
  const bulkRemove = event.target.closest("[data-bulk-remove]");
  if (bulkRemove) bulkRemoveAt(Number(bulkRemove.dataset.bulkRemove));
  const bulkRow = event.target.closest("[data-bulk-index]");
  if (bulkRow && !event.target.closest("input") && !event.target.closest("button")) {
    bulkEditAt(Number(bulkRow.dataset.bulkIndex));
  }
  // ── capture triage wiring ──
  if (event.target.closest("#captureRefresh")) loadCaptureBatches().catch((e) => toast(e.message, "error"));
  const capturePromote = event.target.closest("[data-capture-promote]");
  if (capturePromote) {
    const [batchId, captureId] = capturePromote.dataset.capturePromote.split("|");
    promoteCapture(batchId, captureId);
  }
  const captureReject = event.target.closest("[data-capture-reject]");
  if (captureReject) {
    const [batchId, captureId] = captureReject.dataset.captureReject.split("|");
    rejectCapture(batchId, captureId);
  }
  const captureCleanup = event.target.closest("[data-capture-cleanup]");
  if (captureCleanup) cleanupCaptureBatch(captureCleanup.dataset.captureCleanup);
});

document.addEventListener("input", (event) => {
  if (event.target.id === "searchInput") {
    state.query = event.target.value;
    renderList();
    return;
  }
  if (event.target.id === "bulkDefaultProduct") {
    state.bulkDefaultProduct = event.target.value;
    return;
  }
  const productField = event.target.closest("[data-bulk-product]");
  if (productField) {
    const idx = Number(productField.dataset.bulkProduct);
    if (state.bulkQueue[idx]) state.bulkQueue[idx].source.productName = productField.value;
    return;
  }
  if (event.target.closest("#entryForm")) updatePreview();
});

document.addEventListener("change", (event) => {
  if (event.target.id === "imageFile") uploadImage(event.target.files[0]);
  if (event.target.id === "bulkFileInput" && event.target.files.length) {
    enqueueFiles(event.target.files);
    event.target.value = ""; // allow re-adding the same file later
  }
  if (event.target.closest("#entryForm")) updatePreview();
});

document.addEventListener("dragover", (event) => {
  const zone = event.target.closest("#dropzone, #bulkDropzone");
  if (!zone) return;
  event.preventDefault();
  zone.classList.add("drag");
});
document.addEventListener("dragleave", (event) => {
  const zone = event.target.closest("#dropzone, #bulkDropzone");
  if (zone) zone.classList.remove("drag");
});
document.addEventListener("drop", (event) => {
  const bulkZone = event.target.closest("#bulkDropzone");
  if (bulkZone) {
    event.preventDefault();
    bulkZone.classList.remove("drag");
    if (event.dataTransfer.files.length) enqueueFiles(event.dataTransfer.files);
    return;
  }
  const zone = event.target.closest("#dropzone");
  if (!zone) return;
  event.preventDefault();
  zone.classList.remove("drag");
  uploadImage(event.dataTransfer.files[0]);
});

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s" && state.view === "form") {
    event.preventDefault();
    saveDraft();
  }
});

// Inject the Capture triage tab into the static nav. The tabs live in
// index-classic.html (out of this file's edit scope), so add the route here on
// boot — keeps the classic workbench's nav a single source of truth.
function addCaptureTab() {
  const nav = document.querySelector(".tabs");
  if (!nav || nav.querySelector('[data-view="capture"]')) return;
  const bulkTab = nav.querySelector('[data-view="bulk"]');
  const tab = document.createElement("button");
  tab.className = "tab";
  tab.dataset.view = "capture";
  tab.textContent = "Capture triage";
  // Place it right after Bulk import so the review surfaces stay grouped.
  if (bulkTab && bulkTab.nextSibling) nav.insertBefore(tab, bulkTab.nextSibling);
  else nav.appendChild(tab);
}
addCaptureTab();

// Inject the capture-triage + provenance-dot + image-fallback styles. The
// canonical definitions live in ui/styles.css (loaded by the SPA), but the
// classic workbench loads classic-styles.css which predates these classes.
// Rather than touch classic-styles.css (out of scope), inject the small set
// the classic view needs so the dot, triage chips, and fallback render.
(function injectCaptureStyles() {
  if (document.getElementById("classic-capture-styles")) return;
  const css = `
.pv-capture { position:absolute; top:6px; right:6px; width:6px; height:6px; border-radius:50%;
  background:var(--accent); opacity:0.7; z-index:2; }
.status-chip.pending { color:var(--faint); border-color:var(--line); }
.status-chip.promoted { color:var(--green); border-color:#c3ddd0; }
.status-chip.rejected { color:var(--red); border-color:#ead7d7; }
.capture-queue { display:flex; flex-direction:column; gap:0; }
.capture-queue .bulk-row.promoted { opacity:.7; }
.capture-queue .bulk-row.rejected { opacity:.55; background:var(--hover); }
.img-fallback { width:100%; min-height:120px; display:flex; flex-direction:column;
  align-items:center; justify-content:center; gap:6px; font-size:11px;
  font-family:var(--mono); text-align:center; padding:12px;
  border:1px dashed var(--line); border-radius:var(--r); }
.img-fallback svg { width:18px; height:18px; opacity:.5; }`;
  const style = document.createElement("style");
  style.id = "classic-capture-styles";
  style.textContent = css;
  document.head.appendChild(style);
})();

loadAll({ keepSelection: false }).catch((error) => {
  $("#page").innerHTML = `<div class="empty-state"><div><i data-lucide="circle-alert"></i><p>${esc(error.message)}</p></div></div>`;
  renderIcons();
});
