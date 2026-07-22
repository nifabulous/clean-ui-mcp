#!/usr/bin/env tsx
/**
 * One-off validation harness for the 5 finance-news (mobile-app, product family)
 * C2 case packages. Parses each brief, label, and evidence descriptor through
 * the C2 zod schemas, then performs cross-file integrity checks:
 *   - every label.goldEvidenceId is in label.validEvidenceIds
 *   - every descriptor record id is in label.validEvidenceIds
 *   - every goldEvidenceId has a matching descriptor record
 *   - every descriptor JSON pointer resolves against the brief
 *   - label.caseId / brief.caseId / descriptor.caseId agree
 * Exit code is non-zero on any failure.
 *
 * Mirrors scripts/validate-c2-pass3-cases.mts but targets the mobile-app
 * finance-news product family, so the platform invariant is mobile-app.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  C2CaseBriefSchema,
  C2DecisionLabelSchema,
  C2GoldEvidenceDescriptorSchema,
} from "../src/c2/case-contracts.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const BASE = resolve(ROOT, "eval/c2/baseline");

const CASE_IDS = [
  "finance-news-onboarding",
  "finance-news-feed",
  "finance-news-story-detail",
  "finance-news-alerts-saved",
  "finance-news-search",
];

// Minimal JSON-pointer resolver (RFC 6901) — supports the subset used by the
// descriptors (object keys and array indices, no escaping). Throws on miss.
function resolvePointer(doc: unknown, pointer: string): unknown {
  if (pointer === "") return doc;
  if (!pointer.startsWith("/")) {
    throw new Error(`pointer does not start with '/': ${pointer}`);
  }
  let cursor: unknown = doc;
  for (const raw of pointer.split("/").slice(1)) {
    if (raw === "") throw new Error(`empty segment in pointer: ${pointer}`);
    const tok = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(cursor)) {
      const idx = Number(tok);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cursor.length) {
        throw new Error(`array index out of range: ${pointer} (idx=${tok})`);
      }
      cursor = cursor[idx];
    } else if (cursor && typeof cursor === "object") {
      const obj = cursor as Record<string, unknown>;
      if (!(tok in obj)) {
        throw new Error(`key not found: ${pointer} (key=${tok})`);
      }
      cursor = obj[tok];
    } else {
      throw new Error(`cannot descend into primitive at ${pointer} (tok=${tok})`);
    }
  }
  return cursor;
}

let failures = 0;
const log = (msg: string) => console.log(msg);
const err = (msg: string) => {
  console.error(`  FAIL: ${msg}`);
  failures++;
};

function readJson(p: string): unknown {
  return JSON.parse(readFileSync(p, "utf8"));
}

for (const caseId of CASE_IDS) {
  log(`\n=== ${caseId} ===`);
  const briefPath = resolve(BASE, "briefs", `${caseId}.json`);
  const labelPath = resolve(BASE, "labels", `${caseId}.json`);
  const evidencePath = resolve(BASE, "evidence", `${caseId}.json`);

  const briefRaw = readJson(briefPath);
  const labelRaw = readJson(labelPath);
  const evidenceRaw = readJson(evidencePath);

  // Schema validation
  const brief = C2CaseBriefSchema.safeParse(briefRaw);
  if (!brief.success) {
    err(`brief schema: ${JSON.stringify(brief.error.issues, null, 2)}`);
  }
  const label = C2DecisionLabelSchema.safeParse(labelRaw);
  if (!label.success) {
    err(`label schema: ${JSON.stringify(label.error.issues, null, 2)}`);
  }
  const evidence = C2GoldEvidenceDescriptorSchema.safeParse(evidenceRaw);
  if (!evidence.success) {
    err(`evidence schema: ${JSON.stringify(evidence.error.issues, null, 2)}`);
  }

  // Stop cross-checks if schema parse failed
  if (!brief.success || !label.success || !evidence.success) continue;

  const b = brief.data;
  const l = label.data;
  const e = evidence.data;

  // caseId agreement across the three files
  if (b.caseId !== caseId) err(`brief.caseId (${b.caseId}) != ${caseId}`);
  if (l.caseId !== caseId) err(`label.caseId (${l.caseId}) != ${caseId}`);
  if (e.caseId !== caseId) err(`descriptor.caseId (${e.caseId}) != ${caseId}`);

  // artifactId cross-references
  const expectedBriefArtifactId = `c2-brief-${caseId}-v1`;
  for (const rec of e.records) {
    if (rec.sourceArtifactId !== expectedBriefArtifactId) {
      err(`descriptor record ${rec.id} sourceArtifactId (${rec.sourceArtifactId}) != ${expectedBriefArtifactId}`);
    }
  }

  // validEvidenceIds ⊇ goldEvidenceIds (already enforced by schema superRefine; double-check)
  const valid = new Set(l.validEvidenceIds);
  for (const g of l.goldEvidenceIds) {
    if (!valid.has(g)) err(`goldEvidenceId not in validEvidenceIds: ${g}`);
  }

  // Every descriptor record id should be a valid evidence id
  for (const rec of e.records) {
    if (!valid.has(rec.id)) err(`descriptor record id not in validEvidenceIds: ${rec.id}`);
  }

  // Every gold evidence id should have a descriptor record
  const descriptorIds = new Set(e.records.map((r) => r.id));
  for (const g of l.goldEvidenceIds) {
    if (!descriptorIds.has(g)) err(`goldEvidenceId has no descriptor record: ${g}`);
  }

  // Every descriptor record id that is a validEvidenceId should be unique and
  // every JSON pointer in every descriptor record must resolve against the brief
  for (const rec of e.records) {
    for (const ptr of rec.jsonPointers) {
      try {
        const val = resolvePointer(briefRaw, ptr);
        if (val === undefined) err(`descriptor ${rec.id} pointer resolves to undefined: ${ptr}`);
      } catch (e) {
        err(`descriptor ${rec.id} pointer failed (${(e as Error).message}): ${ptr}`);
      }
    }
  }

  // Spot-check: at least one safety/AI-attribution constraint exists
  const safetyKeywords = ["do not claim", "critical", "machine-generated", "must not", "accuracy", "attributed", "guarantee", "no pressure", "no fake"];
  const hasSafety = b.constraints.some((c) =>
    safetyKeywords.some((k) => c.toLowerCase().includes(k)),
  );
  if (!hasSafety) err(`brief has no safety-relevant constraint (keywords: ${safetyKeywords.join(", ")})`);

  // family / platform / sourceSnapshotRef invariants for this product family
  if (b.family !== "product") err(`brief.family (${b.family}) != product`);
  if (b.platform !== "mobile-app") err(`brief.platform (${b.platform}) != mobile-app`);
  if (b.sourceSnapshotRef !== null) err(`brief.sourceSnapshotRef is not null for product case`);

  // productContext must name Newswire and use example.com
  if (!/Newswire/.test(b.productContext)) err(`brief.productContext does not name Newswire`);
  if (!/example\.com/.test(b.productContext)) err(`brief.productContext does not use example.com`);

  // rubric dimensions: exactly 6 anchors covering all dimensions (enforced by schema; double-check AI-attribution is on point)
  const dims = new Set(l.rubricAnchors.map((a) => a.dimension));
  if (dims.size !== 6) err(`expected 6 unique rubric dimensions, got ${dims.size}`);

  log(`  brief: ${b.requiredScreens.length} screens, ${b.constraints.length} constraints, ${b.users.length} users, ${b.jobs.length} jobs`);
  log(`  label: ${l.requiredDecisionIds.length} decisions, ${l.requiredAcceptanceCriteria.length} ACs, ${l.forbiddenClaims.length} forbidden, ${l.rubricAnchors.length} rubric anchors`);
  log(`  evidence: ${e.records.length} records`);
  log(`  gold evidence ids: ${l.goldEvidenceIds.length}`);
}

console.log("");
if (failures === 0) {
  console.log(`All ${CASE_IDS.length} finance-news case packages passed schema + integrity validation.`);
  process.exit(0);
} else {
  console.error(`${failures} validation failure(s) across ${CASE_IDS.length} finance-news case packages.`);
  process.exit(1);
}
