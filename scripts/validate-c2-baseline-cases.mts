/**
 * Generic C2 baseline case-package validator. Covers ALL 22 baseline cases
 * (stablecoin + finance-news + uk-loan + migration + safety). Validates:
 *   - Brief / label / evidence each parse through their Zod schemas
 *   - caseId agreement across all three files
 *   - goldEvidenceIds ⊆ validEvidenceIds
 *   - every descriptor record id is in validEvidenceIds
 *   - every gold id has a descriptor record
 *   - every JSON pointer in every descriptor resolves against the brief
 *   - family/platform/sourceSnapshotRef invariants
 *
 * Run: npx tsx scripts/validate-c2-baseline-cases.mts
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  C2CaseBriefSchema,
  C2DecisionLabelSchema,
  C2GoldEvidenceDescriptorSchema,
} from "../src/c2/case-contracts.ts";
import { DesignSourceSnapshotSchema } from "../src/design-source/contracts.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const BRIEFS_DIR = join(REPO, "eval/c2/baseline/briefs");
const LABELS_DIR = join(REPO, "eval/c2/baseline/labels");
const EVIDENCE_DIR = join(REPO, "eval/c2/baseline/evidence");

/** RFC 6901 JSON pointer resolver. */
export function resolvePointer(doc: unknown, pointer: string): unknown {
  if (pointer === "") return doc;
  if (!pointer.startsWith("/")) throw new Error(`pointer must start with /: ${pointer}`);
  let current: unknown = doc;
  for (const part of pointer.slice(1).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (current === null || typeof current !== "object") {
      throw new Error(`pointer ${pointer} cannot resolve segment "${key}" on non-object`);
    }
    let indexed: string | number = key;
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0) {
        throw new Error(`pointer ${pointer} has invalid array index "${key}"`);
      }
      indexed = index;
    }
    current = (current as Record<string | number, unknown>)[indexed];
    if (current === undefined) {
      throw new Error(`pointer ${pointer} segment "${key}" not found`);
    }
  }
  return current;
}

export function sourceDocumentForEvidence(
  sourceArtifactId: string,
  brief: { artifactId: string },
  snapshot: { artifactId: string } | null,
): unknown {
  if (sourceArtifactId === brief.artifactId) return brief;
  if (snapshot && sourceArtifactId === snapshot.artifactId) return snapshot;
  throw new Error(
    `source artifact ${sourceArtifactId} is neither the bound brief (${brief.artifactId}) `
    + `nor the bound source snapshot (${snapshot?.artifactId ?? "none"})`,
  );
}

export function runBaselineCaseValidation(): number {
let failures = 0;
const caseIds = readdirSync(BRIEFS_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""))
  .sort();

console.log(`validating ${caseIds.length} baseline case packages...`);

for (const caseId of caseIds) {
  const prefix = `  ${caseId}:`;
  let ok = true;

  // Load all three files.
  let brief: unknown, label: unknown, evidence: unknown;
  try {
    brief = JSON.parse(readFileSync(join(BRIEFS_DIR, `${caseId}.json`), "utf-8"));
    label = JSON.parse(readFileSync(join(LABELS_DIR, `${caseId}.json`), "utf-8"));
    evidence = JSON.parse(readFileSync(join(EVIDENCE_DIR, `${caseId}.json`), "utf-8"));
  } catch (err) {
    console.error(`${prefix} FAIL file read: ${err instanceof Error ? err.message : String(err)}`);
    failures++;
    continue;
  }

  // Schema parse.
  const briefParsed = C2CaseBriefSchema.safeParse(brief);
  if (!briefParsed.success) {
    console.error(`${prefix} FAIL brief schema: ${briefParsed.error.message.slice(0, 120)}`);
    ok = false;
  }
  const labelParsed = C2DecisionLabelSchema.safeParse(label);
  if (!labelParsed.success) {
    console.error(`${prefix} FAIL label schema: ${labelParsed.error.message.slice(0, 120)}`);
    ok = false;
  }
  const evidenceParsed = C2GoldEvidenceDescriptorSchema.safeParse(evidence);
  if (!evidenceParsed.success) {
    console.error(`${prefix} FAIL evidence schema: ${evidenceParsed.error.message.slice(0, 120)}`);
    ok = false;
  }
  if (!ok) { failures++; continue; }

  const b = briefParsed.data!;
  const l = labelParsed.data!;
  const e = evidenceParsed.data!;

  let sourceSnapshot: ReturnType<typeof DesignSourceSnapshotSchema.parse> | null = null;
  if (b.sourceSnapshotRef !== null) {
    const snapshotPath = join(REPO, b.sourceSnapshotRef.path);
    if (existsSync(snapshotPath)) {
      try {
        sourceSnapshot = DesignSourceSnapshotSchema.parse(
          JSON.parse(readFileSync(snapshotPath, "utf-8")),
        );
      } catch (err) {
        console.error(`${prefix} FAIL source snapshot schema: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`);
        ok = false;
      }
      if (sourceSnapshot && sourceSnapshot.artifactId !== b.sourceSnapshotRef.artifactId) {
        console.error(`${prefix} FAIL source snapshot artifactId does not match brief sourceSnapshotRef`);
        ok = false;
      }
      if (sourceSnapshot && sourceSnapshot.projectId !== b.caseId) {
        console.error(`${prefix} FAIL source snapshot projectId does not match brief caseId`);
        ok = false;
      }
    }
  }

  // caseId agreement.
  if (b.caseId !== caseId || l.caseId !== caseId || e.caseId !== caseId) {
    console.error(`${prefix} FAIL caseId mismatch across files`);
    ok = false;
  }

  // goldEvidenceIds ⊆ validEvidenceIds.
  const validSet = new Set(l.validEvidenceIds);
  for (const gold of l.goldEvidenceIds) {
    if (!validSet.has(gold)) {
      console.error(`${prefix} FAIL gold evidence "${gold}" not in validEvidenceIds`);
      ok = false;
    }
  }

  // Descriptor records: each id must be in validEvidenceIds.
  for (const rec of e.records) {
    if (!validSet.has(rec.id)) {
      console.error(`${prefix} FAIL descriptor record id "${rec.id}" not in validEvidenceIds`);
      ok = false;
    }
  }

  // EXACT equality: descriptor record IDs must equal goldEvidenceIds as sets.
  // The production resolver (condition-resolver.ts) requires this — extra
  // records cause gold-evidence condition resolution to fail.
  const descIds = new Set(e.records.map((r) => r.id));
  const goldIds = new Set(l.goldEvidenceIds);
  if (descIds.size !== goldIds.size || [...descIds].some((id) => !goldIds.has(id))) {
    const extra = [...descIds].filter((id) => !goldIds.has(id));
    const missing = [...goldIds].filter((id) => !descIds.has(id));
    console.error(`${prefix} FAIL descriptor records do not exactly match goldEvidenceIds`);
    if (extra.length) console.error(`${prefix}   extra (in descriptor, not gold): ${extra.join(", ")}`);
    if (missing.length) console.error(`${prefix}   missing (gold, not in descriptor): ${missing.join(", ")}`);
    ok = false;
  }

  // Every gold evidence id must have a descriptor record.
  const descriptorIds = new Set(e.records.map((r) => r.id));
  for (const gold of l.goldEvidenceIds) {
    if (!descriptorIds.has(gold)) {
      console.error(`${prefix} FAIL gold evidence "${gold}" has no descriptor record`);
      ok = false;
    }
  }

  // Every JSON pointer in every descriptor record resolves against the brief.
  for (const rec of e.records) {
    let sourceDoc: unknown;
    try {
      sourceDoc = sourceDocumentForEvidence(rec.sourceArtifactId, b, sourceSnapshot);
    } catch (err) {
      console.error(`${prefix} FAIL record "${rec.id}" source binding: ${err instanceof Error ? err.message : String(err)}`);
      ok = false;
      continue;
    }
    for (const ptr of rec.jsonPointers) {
      try {
        resolvePointer(sourceDoc, ptr);
      } catch (err) {
        console.error(`${prefix} FAIL pointer "${ptr}" in record "${rec.id}" does not resolve: ${err instanceof Error ? err.message : String(err)}`);
        ok = false;
      }
    }
  }

  // Family invariants.
  if (b.family === "migration" && b.sourceSnapshotRef === null) {
    console.error(`${prefix} FAIL migration brief must have non-null sourceSnapshotRef`);
    ok = false;
  }
  if (b.family !== "migration" && b.sourceSnapshotRef !== null) {
    console.error(`${prefix} FAIL non-migration brief must have null sourceSnapshotRef`);
    ok = false;
  }

  if (ok) {
    console.log(`${prefix} OK`);
  } else {
    failures++;
  }
}

console.log("");
if (failures === 0) {
  console.log(`All ${caseIds.length} baseline case packages passed schema + integrity validation.`);
  return 0;
} else {
  console.error(`${failures} case package(s) failed validation.`);
  return 1;
}
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  process.exitCode = runBaselineCaseValidation();
}
