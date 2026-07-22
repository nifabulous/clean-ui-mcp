#!/usr/bin/env tsx
/**
 * Validation harness for the 13 pass-3 case packages across three families:
 *   - 5 UK personal-loan product cases (family: "product")
 *   - 4 migration cases (family: "migration", sourceSnapshotRef REQUIRED)
 *   - 4 safety cases (family: "safety")
 *
 * Parses each brief, label, and evidence descriptor through the C2 zod schemas,
 * then performs cross-file integrity checks:
 *   - every label.goldEvidenceId is in label.validEvidenceIds
 *   - every descriptor record id is in label.validEvidenceIds
 *   - every goldEvidenceId has a matching descriptor record
 *   - every descriptor JSON pointer resolves against the brief
 *   - label.caseId / brief.caseId / descriptor.caseId agree
 *   - family invariants (migration requires sourceSnapshotRef + placeholder sha;
 *     non-migration forbids sourceSnapshotRef; platform = responsive-web)
 * Exit code is non-zero on any failure.
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

type Family = "product" | "migration" | "safety";
type CaseSpec = { id: string; family: Family };

const CASE_SPECS: CaseSpec[] = [
  // UK personal-loan product family
  { id: "uk-loan-eligibility", family: "product" },
  { id: "uk-loan-application", family: "product" },
  { id: "uk-loan-decision", family: "product" },
  { id: "uk-loan-dashboard", family: "product" },
  { id: "uk-loan-payment-difficulty", family: "product" },
  // Migration family
  { id: "migration-documentation-site", family: "migration" },
  { id: "migration-saas-dashboard", family: "migration" },
  { id: "migration-content-product", family: "migration" },
  { id: "migration-regulated-service", family: "migration" },
  // Safety family
  { id: "safety-conflicting-evidence", family: "safety" },
  { id: "safety-insufficient-evidence", family: "safety" },
  { id: "safety-private-corpus-leakage", family: "safety" },
  { id: "safety-deceptive-request", family: "safety" },
];

const PLACEHOLDER_SHA = "0".repeat(64);

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

for (const { id: caseId, family } of CASE_SPECS) {
  log(`\n=== ${caseId} (${family}) ===`);
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
  if (e.caseId !== caseId) err(`evidence.caseId (${e.caseId}) != ${caseId}`);

  // family agreement (declared vs brief)
  if (b.family !== family) err(`brief.family (${b.family}) != declared ${family}`);

  // platform invariant (all 13 cases are responsive-web per the task spec)
  if (b.platform !== "responsive-web") err(`brief.platform (${b.platform}) != responsive-web`);

  // sourceSnapshotRef family invariants (enforced by schema superRefine; double-check)
  if (family === "migration") {
    if (b.sourceSnapshotRef === null) {
      err(`migration brief has null sourceSnapshotRef`);
    } else {
      if (b.sourceSnapshotRef.artifactType !== "design-source-snapshot") {
        err(`migration sourceSnapshotRef.artifactType (${b.sourceSnapshotRef.artifactType}) != design-source-snapshot`);
      }
      if (b.sourceSnapshotRef.sha256 !== PLACEHOLDER_SHA) {
        err(`migration sourceSnapshotRef.sha256 is not the expected placeholder (expected ${PLACEHOLDER_SHA})`);
      }
      // the path should point at the baseline source-snapshots directory
      const expectedPath = `eval/c2/baseline/source-snapshots/${caseId}.json`;
      if (b.sourceSnapshotRef.path !== expectedPath) {
        err(`migration sourceSnapshotRef.path (${b.sourceSnapshotRef.path}) != ${expectedPath}`);
      }
    }
  } else {
    if (b.sourceSnapshotRef !== null) {
      err(`non-migration brief (${family}) has non-null sourceSnapshotRef`);
    }
  }

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

  // Every JSON pointer in every descriptor record must resolve against the brief
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

  // Spot-check: each brief must have at least one safety-relevant constraint
  const safetyKeywords = [
    "do not claim", "critical", "no pressure", "no fake", "must not", "guarantee",
    "licence", "scarcity", "forbidden", "do not imply", "not a guarantee", "do not reproduce",
    "must not be", "no fabricated", "no new data", "no fabricated", "honest", "transparent",
    "supportive", "not punitive",
  ];
  const hasSafety = b.constraints.some((c) =>
    safetyKeywords.some((k) => c.toLowerCase().includes(k)),
  );
  if (!hasSafety) err(`brief has no safety-relevant constraint (keywords: ${safetyKeywords.join(", ")})`);

  log(`  brief: ${b.requiredScreens.length} screens, ${b.constraints.length} constraints, ${b.users.length} users, ${b.jobs.length} jobs, family=${b.family}`);
  log(`  label: ${l.requiredDecisionIds.length} decisions, ${l.requiredAcceptanceCriteria.length} ACs, ${l.forbiddenClaims.length} forbidden, ${l.rubricAnchors.length} rubric anchors`);
  log(`  evidence: ${e.records.length} records`);
  log(`  gold evidence ids: ${l.goldEvidenceIds.length}`);
}

console.log("");
if (failures === 0) {
  console.log(`All ${CASE_SPECS.length} case packages passed schema + integrity validation.`);
  process.exit(0);
} else {
  console.error(`${failures} validation failure(s) across ${CASE_SPECS.length} case packages.`);
  process.exit(1);
}
