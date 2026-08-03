// audit.mjs — value-quality audit over every captured brief output.
// The earlier pass counted PRESENCE (non-null fields) and called that "filled".
// This one checks whether the values actually work: contrast, role collisions,
// self-contradiction, template artifacts, and claims the text makes about itself.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// The capture directory. The original hardcoded paths pointed at a dead
// session scratchpad; verification now runs over a fresh capture via
// AUDIT_DIR (plan Task 7 Step 2: "fresh 10-brief capture").
const DIR = process.env.AUDIT_DIR ?? "/private/tmp/clean-ui-mcp/audit-captures";

const lum = (h) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(h.trim());
  if (!m) return null;
  const c = [0, 2, 4].map((i) => parseInt(m[1].substr(i, 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => {
  const x = lum(a), y = lum(b);
  if (x === null || y === null) return null;
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const r2 = (n) => (n === null ? "n/a" : n.toFixed(2));

const findings = [];
const add = (file, sev, code, detail) => findings.push({ file, sev, code, detail });

function auditTokens(file, tokens, label) {
  if (!tokens) return;
  const { primary, surface, ink, muted, accent } = tokens;
  // 1. role collisions — two roles resolving to the same value is a functional bug
  const pairs = [["primary", primary], ["surface", surface], ["ink", ink], ["muted", muted], ["accent", accent]];
  const byVal = new Map();
  for (const [role, v] of pairs) {
    if (!v) continue;
    byVal.set(v, [...(byVal.get(v) ?? []), role]);
  }
  for (const [v, roles] of byVal) {
    if (roles.length < 2) continue;
    const bg = roles.includes("surface") || roles.includes("primary") && roles.includes("accent");
    // primary===accent is a documented mapping in the synthesizer; surface collisions are not
    const benign = roles.length === 2 && roles.includes("primary") && roles.includes("accent");
    add(file, benign ? "INFO" : "CRITICAL", "role-collision",
      `${label}: ${roles.join(" === ")} all = ${v}${benign ? " (documented primary=accent mapping)" : " — an accent that equals a background is invisible"}`);
  }
  // 2. contrast against the surface the text sits on
  const checks = [["ink", ink, 4.5], ["muted", muted, 4.5], ["accent", accent, 3.0], ["primary", primary, 3.0]];
  for (const [role, v, floor] of checks) {
    if (!v || !surface) continue;
    const cr = ratio(v, surface);
    if (cr !== null && cr < floor) {
      add(file, "CRITICAL", "contrast-fail",
        `${label}: ${role} ${v} on surface ${surface} = ${r2(cr)}:1, below the ${floor}:1 floor`);
    }
  }
}

// ---- verify contrast ratios the PROSE claims about itself --------------
function auditClaims(file, text) {
  const re = /(#[0-9a-fA-F]{6})[^.]{0,90}?\((\d+(?:\.\d+)?):1\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const [, hex, claimed] = m;
    const actual = ratio(hex, "#ffffff");
    if (actual === null) continue;
    const delta = Math.abs(actual - Number(claimed));
    add(file, delta > 0.3 ? "IMPORTANT" : "OK", "self-claim",
      `claims ${hex} = ${claimed}:1 vs white; actual ${r2(actual)}:1${delta > 0.3 ? ` — off by ${delta.toFixed(2)}` : ""}`);
  }
}

function auditMarkdown(file, md, spec) {
  const empties = (md.match(/_\(no [^)]+recorded\)_/g) ?? []).length;
  const unavailable = (md.match(/: unavailable;/g) ?? []).length;
  add(file, "METRIC", "emptiness", `${empties} "(no X recorded)" sections, ${unavailable} unavailable token slots`);

  const dd = spec?.designDirection ?? "";
  // template artifact: "Ground this {brief} in ..." with a sentence-ending brief
  if (/^Ground this .*[.?!]\s+in the matched corpus references/s.test(dd)) {
    add(file, "IMPORTANT", "broken-grammar",
      `direction template interpolates a multi-sentence brief: "...${dd.slice(0, 60)}... ${dd.slice(dd.indexOf(". in the matched") - 20, dd.indexOf(". in the matched") + 30)}..."`);
  }
  // self-contradiction: direction cites evidence ids while Sources says none
  const citesEvidence = /evidence-\d/.test(dd);
  const sourcesEmpty = /## Sources\s*\n_\(no cited references recorded\)_/.test(md);
  if (citesEvidence && sourcesEmpty) {
    add(file, "IMPORTANT", "contradiction",
      "direction cites evidence ids but the Sources section reads '(no cited references recorded)'");
  }
  // self-contradiction: direction asserts typography AUTHORITY while the
  // Typography section refuses to record tokens. A cited typePairing
  // OBSERVATION ("Inter typography", "type notes: ...") is intended (C3
  // design spec §1B/§2d: typePairing appears as a cited signal, and an
  // observation is not token authority) — only an authority claim
  // contradicts the unavailable section.
  const typographyAuthorityClaim = /typography (tokens|stack)|font stack (is|should)|set (the )?(type|font)|use .* font stack/i;
  if (typographyAuthorityClaim.test(dd) && /Typography tokens are unavailable/.test(md)) {
    add(file, "IMPORTANT", "contradiction",
      "direction asserts a typography signal while the Typography section refuses to record one");
  }
  // layout regions that carry no content
  const regions = spec?.layoutRegions ?? [];
  const hollow = regions.filter((r) => (r.components?.length ?? 0) === 0);
  if (regions.length > 0 && hollow.length === regions.length) {
    add(file, "IMPORTANT", "hollow-regions",
      `${regions.length} layout regions, all with zero components and no responsive rules — labels only`);
  }
  // verifier monoculture
  const verifiers = [...new Set((spec?.acceptanceCriteria ?? []).map((a) => a.verifier))];
  if (verifiers.length === 1 && verifiers[0] === "manual") {
    add(file, "IMPORTANT", "manual-only-ac",
      `all ${spec.acceptanceCriteria.length} acceptance criteria use verifier "manual"; the tool description advertises axe/playwright/static-analysis`);
  }
}

function run(dir, files, arm) {
  for (const f of files) {
    const base = f.replace(/\.json$/, "");
    const spec = JSON.parse(readFileSync(join(dir, f), "utf8")).data;
    if (!spec) { add(base, "CRITICAL", "error-envelope", "no spec — error response"); continue; }
    let md = "";
    try { md = readFileSync(join(dir, base + ".md"), "utf8"); } catch { /* round1 naming */ }
    auditMarkdown(base, md, spec);
    auditTokens(base, spec.colorTokens, "accepted colorTokens");
    const p = spec.modelProposal;
    if (p) {
      auditTokens(base, p.colorTokens, "PROPOSED colorTokens");
      auditClaims(base, p.designDirection ?? "");
      const notes = p.motionNotes ?? [];
      const noDuration = notes.filter((n) => !/\d+\s*ms|\d+(\.\d+)?\s*s\b/.test(n));
      if (noDuration.length) add(base, "MINOR", "motion-vague", `${noDuration.length}/${notes.length} motion notes carry no duration`);
      if (p.typographyTokens && !p.typographyTokens.mono) add(base, "MINOR", "type-gap", "proposal has no mono role");
      else if (p.typographyTokens?.mono && !/mono|courier|consol|menlo/i.test(p.typographyTokens.mono)) {
        add(base, "IMPORTANT", "mono-not-mono", `mono role is "${p.typographyTokens.mono}" — not a fixed-width face, defeating its stated purpose`);
      }
      // the gating tension: proposal present => deterministic body suppressed
      if ((spec.layoutRegions?.length ?? 0) === 0 && spec.colorTokens === null) {
        add(base, "INFO", "synthesis-suppressed", "proposal present, so corpus synthesis is gated off: no regions, no accepted tokens");
      }
    }
  }
}

const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));
run(DIR, files, "capture");

const order = { CRITICAL: 0, IMPORTANT: 1, MINOR: 2, INFO: 3, OK: 4, METRIC: 5 };
findings.sort((a, b) => order[a.sev] - order[b.sev] || a.code.localeCompare(b.code) || a.file.localeCompare(b.file));
const bySev = {};
for (const f of findings) (bySev[f.sev] ??= []).push(f);
for (const sev of ["CRITICAL", "IMPORTANT", "MINOR", "OK", "INFO"]) {
  if (!bySev[sev]) continue;
  console.log(`\n===== ${sev} (${bySev[sev].length}) =====`);
  for (const f of bySev[sev]) console.log(`[${f.code}] ${f.file}\n    ${f.detail}`);
}
console.log("\n===== emptiness by file =====");
for (const f of bySev.METRIC ?? []) console.log(`${f.file.padEnd(32)} ${f.detail}`);
