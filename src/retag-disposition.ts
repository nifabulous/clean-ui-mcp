import { createHash } from "node:crypto";
import { z } from "zod";
import { SERVABLE_FIELD_KEYS } from "./corpus-trust.js";
import { valueAtFieldKey } from "./verification-carry.js";
import type { CorpusEntryT } from "./schema.js";

export const DISPOSITION_FIELDS = [
  ...new Set([
    ...SERVABLE_FIELD_KEYS,
    "industryVertical",
    "qualityTier",
    "qualityScore",
    "businessRationale",
  ]),
].sort();

export const FieldDispositionSchema = z.object({
  status: z.enum([
    "retain-mechanical",
    "retain-curatorial",
    "defer-replacement",
    "defer-fill",
    "structurally-unfillable",
  ]),
  reason: z.string().min(1),
  existingCount: z.number().int().nonnegative(),
  futurePolicy: z.string().min(1),
});

export const RetagDispositionSchema = z.object({
  schemaVersion: z.literal("1.0"),
  artifactType: z.literal("retag-disposition"),
  status: z.literal("deferred"),
  decision: z.string().min(1),
  corpusPath: z.literal("corpus/entries.json"),
  corpusSha256: z.string().regex(/^[a-f0-9]{64}$/),
  generatedAt: z.string().datetime(),
  generatedBy: z.string().min(1),
  entryCount: z.number().int().nonnegative(),
  entryIds: z.array(z.string().min(1)).min(1),
  entryIdsSha256: z.string().regex(/^[a-f0-9]{64}$/),
  fields: z.record(z.string(), FieldDispositionSchema),
});

export type FieldDisposition = z.infer<typeof FieldDispositionSchema>;
export type RetagDisposition = z.infer<typeof RetagDispositionSchema>;

// These policies govern replacement/fill authorization, not verifier routing.
// A field may have a mechanical/factual verifier tier and still be deferred
// for corpus replacement when that lane is disabled or lacks independent gold
// labels (notably usesBorders and screenshot-only typePairing).
const POLICIES: Readonly<Record<string, Omit<FieldDisposition, "existingCount">>> = {
  platform: { status: "retain-mechanical", reason: "platform is derived from image dimensions", futurePolicy: "keep detector-produced values; verify drift mechanically" },
  "visual.dominantColors": { status: "retain-mechanical", reason: "dominant colors are deterministic pixel output", futurePolicy: "compute from pixels; never use model hex guesses" },
  "visual.spacingDensity": { status: "defer-replacement", reason: "no independent gold labels for visual taxonomy", futurePolicy: "model may abstain; do not replace existing values without a scored field gate" },
  "visual.cornerStyle": { status: "defer-replacement", reason: "no independent gold labels for visual taxonomy", futurePolicy: "model may abstain; do not replace existing values without a scored field gate" },
  "visual.usesBorders": { status: "defer-replacement", reason: "single screenshots do not supply a reliable label authority", futurePolicy: "retain unknown when evidence is insufficient; require reviewed evidence for replacement" },
  "visual.usesShadows": { status: "structurally-unfillable", reason: "pixel and model verification lanes are exhausted for this screenshot-only corpus", futurePolicy: "new authoring must abstain unless capture/DOM evidence changes the field authority" },
  "visual.accentColor": { status: "structurally-unfillable", reason: "exact accent-role attribution lacks a defensible verifier lane", futurePolicy: "keep null/absent unless a reviewed evidence lane is added" },
  "visual.colorRoles": { status: "structurally-unfillable", reason: "unordered pixels cannot establish semantic color roles reliably", futurePolicy: "keep absent unless DOM or human evidence is attached" },
  responsiveBehavior: { status: "structurally-unfillable", reason: "one screenshot cannot prove responsive behavior", futurePolicy: "derive only from multi-viewport capture evidence" },
  "visual.typePairing": { status: "structurally-unfillable", reason: "font identity is not recoverable from bare screenshots", futurePolicy: "persist hash-bound DOM font signals on future captures" },
  colorScheme: { status: "defer-fill", reason: "deterministic fill calibration and held-out gate are not closed", futurePolicy: "new entries use deterministic luminance with abstention; existing rows stay unchanged until calibration" },
  patternType: { status: "defer-replacement", reason: "no independent gold labels for primary pattern classification", futurePolicy: "shadow and score exact classification before replacement" },
  categories: { status: "defer-replacement", reason: "no independent gold labels for category classification", futurePolicy: "shadow and score multilabel precision/recall before replacement" },
  styleTags: { status: "defer-replacement", reason: "no independent gold labels for style taxonomy", futurePolicy: "shadow and score precision before replacement" },
  components: { status: "defer-fill", reason: "coverage is sparse and no independent gold labels exist", futurePolicy: "quarantine OOV candidates; fill only after a scored field gate" },
  domainTags: { status: "defer-fill", reason: "coverage is sparse and domain labels are model-vs-model today", futurePolicy: "quarantine OOV candidates; promote taxonomy only after adjudication" },
  mood: { status: "defer-replacement", reason: "mood has no controlled vocabulary or falsifiable gold contract", futurePolicy: "leave absent unless a controlled vocabulary and label rubric are approved" },
  layout: { status: "defer-replacement", reason: "no independent gold labels for structural extraction", futurePolicy: "image/DOM-backed shadow scoring before replacement" },
  critique: { status: "defer-replacement", reason: "editorial quality is not measured by current verifier agreement", futurePolicy: "generate as draft, require evidence-linked human review before serving" },
  whatToSteal: { status: "defer-replacement", reason: "recommendation quality lacks independent labels and citation scoring", futurePolicy: "keep draft until evidence-linked review and quality scoring exist" },
  antiPatterns: { status: "defer-replacement", reason: "anti-pattern advice is judgment, not screenshot-grounded fact", futurePolicy: "serve only verified prose; require distinct evidence and human review" },
  "antiPatterns.accessibilityRisks": { status: "defer-replacement", reason: "a11y claims need concrete DOM or visible evidence", futurePolicy: "retain only structured evidence-backed risks" },
  voice: { status: "defer-replacement", reason: "copy quality cannot be proven from metadata-only corpus rows", futurePolicy: "quote only hash-bound DOM/screenshot copy and review before serving" },
  industryVertical: { status: "defer-replacement", reason: "free-text industry vocabulary is uncontrolled", futurePolicy: "do not infer from product name alone; promote a controlled vocabulary first" },
  qualityTier: { status: "retain-curatorial", reason: "quality tier is a curator judgment, not a model field", futurePolicy: "preserve through retag; human changes only" },
  qualityScore: { status: "retain-curatorial", reason: "quality score is a curator judgment, not a model field", futurePolicy: "preserve through retag; human changes only" },
  businessRationale: { status: "defer-replacement", reason: "business intent is not reliably visible on isolated screenshots", futurePolicy: "emit only when visible context supports it; keep unverified values out of serving" },
};

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).some(isPresent);
  return true;
}

export function buildDisposition(
  entries: readonly CorpusEntryT[],
  corpusSha256: string,
  generatedAt = new Date().toISOString(),
): RetagDisposition {
  const entryIds = entries.map((entry) => entry.id).sort();
  const fields = Object.fromEntries(DISPOSITION_FIELDS.map((field) => {
    const policy = POLICIES[field];
    if (!policy) throw new Error(`missing disposition policy for ${field}`);
    return [field, {
      ...policy,
      existingCount: entries.filter((entry) => isPresent(valueAtFieldKey(entry, field))).length,
    }];
  }));
  return RetagDispositionSchema.parse({
    schemaVersion: "1.0",
    artifactType: "retag-disposition",
    status: "deferred",
    decision: "Retain all existing canonical values; defer corpus-wide replacement/fill until the named field gates close.",
    corpusPath: "corpus/entries.json",
    corpusSha256,
    generatedAt,
    generatedBy: "retag-disposition-v1",
    entryCount: entries.length,
    entryIds,
    entryIdsSha256: sha256(entryIds.join("\n") + "\n"),
    fields,
  });
}

export function validateDisposition(
  artifact: unknown,
  entries: readonly CorpusEntryT[],
  corpusSha256: string,
): RetagDisposition {
  const parsed = RetagDispositionSchema.parse(artifact);
  const ids = entries.map((entry) => entry.id).sort();
  if (parsed.corpusSha256 !== corpusSha256) throw new Error("retag disposition is bound to a different corpus bytes hash");
  if (parsed.entryCount !== entries.length) throw new Error(`retag disposition covers ${parsed.entryCount} entries, corpus has ${entries.length}`);
  if (JSON.stringify(parsed.entryIds) !== JSON.stringify(ids)) throw new Error("retag disposition entry IDs do not exactly match the corpus");
  if (parsed.entryIdsSha256 !== sha256(ids.join("\n") + "\n")) throw new Error("retag disposition entry ID hash is invalid");
  const fields = Object.keys(parsed.fields).sort();
  if (JSON.stringify(fields) !== JSON.stringify(DISPOSITION_FIELDS)) throw new Error("retag disposition field coverage is incomplete or contains an unknown field");
  return parsed;
}
