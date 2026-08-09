import { z } from "zod";
import { Component, DomainTag, TypePairing } from "./schema.js";
import type { GoldField, GoldLabel } from "./retag-eval.js";

/** Fields that need human evidence before a corpus-wide replacement/fill. */
export const RETAG_GOLD_FIELDS = [
  "components",
  "domainTags",
  "colorScheme",
  "mood",
  "visual.typePairing",
] as const;

export type RetagGoldField = (typeof RETAG_GOLD_FIELDS)[number];
export type RetagGoldStatus = "present" | "none" | "abstain" | "oov";
export type RetagGoldEvidenceSource = "image" | "dom" | "both";

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const EvidenceSource = z.enum(["image", "dom", "both"]);
const Status = z.enum(["present", "none", "abstain", "oov"]);

const RawFieldLabelSchema = z.object({
  status: Status,
  value: z.unknown().optional(),
  oov: z.array(z.string().trim().min(1).max(80)).min(1).max(8).refine((values) => new Set(values).size === values.length, "OOV candidates must be unique").optional(),
  evidenceSource: EvidenceSource,
  note: z.string().trim().min(1).max(500).optional(),
}).strict();

function fieldLabelSchema(field: RetagGoldField) {
  return RawFieldLabelSchema.superRefine((value, ctx) => {
    const hasValue = value.value !== undefined;
    const hasOov = value.oov !== undefined;
    if (value.status === "present") {
      if (!hasValue) ctx.addIssue({ code: "custom", path: ["value"], message: `${field} present labels require value` });
      if (hasOov) ctx.addIssue({ code: "custom", path: ["oov"], message: `${field} present labels cannot include OOV candidates` });
    } else if (value.status === "none") {
      if (hasValue || hasOov) ctx.addIssue({ code: "custom", path: ["value"], message: `${field} none labels cannot include a value or OOV candidate` });
    } else if (value.status === "abstain") {
      if (!value.note) ctx.addIssue({ code: "custom", path: ["note"], message: `${field} abstain labels require a note` });
      if (hasValue || hasOov) ctx.addIssue({ code: "custom", path: ["value"], message: `${field} abstain labels cannot include a value or OOV candidate` });
    } else {
      if (!value.note) ctx.addIssue({ code: "custom", path: ["note"], message: `${field} OOV labels require a note` });
      if (!hasOov) ctx.addIssue({ code: "custom", path: ["oov"], message: `${field} OOV labels require candidate values` });
      if (hasValue) ctx.addIssue({ code: "custom", path: ["value"], message: `${field} OOV labels cannot include a canonical value` });
    }
  });
}

const ComponentsFieldSchema = fieldLabelSchema("components").superRefine((value, ctx) => {
  if (value.status !== "present") return;
  const result = z.array(Component).min(1).max(10).safeParse(value.value);
  if (!result.success || new Set(result.data).size !== result.data.length) ctx.addIssue({ code: "custom", path: ["value"], message: "components must use unique canonical Component values" });
});

const DomainTagsFieldSchema = fieldLabelSchema("domainTags").superRefine((value, ctx) => {
  if (value.status !== "present") return;
  const result = z.array(DomainTag).min(1).max(4).safeParse(value.value);
  if (!result.success || new Set(result.data).size !== result.data.length) ctx.addIssue({ code: "custom", path: ["value"], message: "domainTags must use unique canonical DomainTag values" });
});

const ColorSchemeFieldSchema = fieldLabelSchema("colorScheme").superRefine((value, ctx) => {
  if (value.status !== "present") return;
  if (!z.enum(["light", "dark"]).safeParse(value.value).success) {
    ctx.addIssue({ code: "custom", path: ["value"], message: "colorScheme must be light or dark" });
  }
});

const MoodFieldSchema = fieldLabelSchema("mood").superRefine((value, ctx) => {
  if (value.status !== "present") return;
  ctx.addIssue({ code: "custom", path: ["status"], message: "mood has no frozen vocabulary; record a concrete phrase as OOV until the vocabulary is approved" });
});

const TypePairingFieldSchema = fieldLabelSchema("visual.typePairing").superRefine((value, ctx) => {
  if (value.status !== "present") return;
  const result = TypePairing.strict().safeParse(value.value);
  if (!result.success) ctx.addIssue({ code: "custom", path: ["value"], message: "typePairing must use display/body/notes" });
  if (value.evidenceSource !== "dom" && value.evidenceSource !== "both") {
    ctx.addIssue({ code: "custom", path: ["evidenceSource"], message: "typePairing present labels require DOM evidence" });
  }
});

export const RetagGoldSelectionEntrySchema = z.object({
  entryId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  imageSha256: Sha256,
  imagePath: z.string().min(1).optional(),
  cohort: z.enum(["reproducible", "challenge"]),
  stratum: z.string().min(1),
}).strict();

export const RetagGoldSelectionSchema = z.object({
  schemaVersion: z.literal("1.0"),
  artifactType: z.literal("retag-gold-selection"),
  artifactId: z.string().min(1),
  selectionArtifactId: z.string().min(1),
  selectionSha256: Sha256,
  fields: z.array(z.enum(RETAG_GOLD_FIELDS)).length(RETAG_GOLD_FIELDS.length),
  entries: z.array(RetagGoldSelectionEntrySchema).min(1),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.fields).size !== RETAG_GOLD_FIELDS.length) ctx.addIssue({ code: "custom", path: ["fields"], message: "gold fields must be unique and complete" });
  const ids = value.entries.map((entry) => entry.entryId);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: ["entries"], message: "selection entry IDs must be unique" });
});

export const RetagGoldLabelSchema = z.object({
  entryId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  imageSha256: Sha256,
  fields: z.object({
    components: ComponentsFieldSchema,
    domainTags: DomainTagsFieldSchema,
    colorScheme: ColorSchemeFieldSchema,
    mood: MoodFieldSchema,
    "visual.typePairing": TypePairingFieldSchema,
  }).strict(),
}).strict();

export const RetagGoldSubmissionSchema = z.object({
  schemaVersion: z.literal("1.0"),
  artifactType: z.literal("retag-gold-submission"),
  artifactId: z.string().min(1),
  selectionArtifactId: z.string().min(1),
  selectionSha256: Sha256,
  submissionVersion: z.number().int().positive(),
  actorId: z.string().min(1),
  actorKind: z.literal("human"),
  reviewerRole: z.enum(["gold", "qa"]),
  sealedAt: z.string().datetime(),
  labels: z.array(RetagGoldLabelSchema).min(1),
}).strict().superRefine((value, ctx) => {
  const ids = value.labels.map((label) => label.entryId);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: ["labels"], message: "submission labels must be unique" });
});

export type RetagGoldSelection = z.infer<typeof RetagGoldSelectionSchema>;
export type RetagGoldSelectionEntry = z.infer<typeof RetagGoldSelectionEntrySchema>;
export type RetagGoldSubmission = z.infer<typeof RetagGoldSubmissionSchema>;
export type RetagGoldLabel = z.infer<typeof RetagGoldLabelSchema>;

export type RetagGoldPacket = {
  schemaVersion: "1.0";
  artifactType: "retag-gold-packet";
  artifactId: string;
  selectionArtifactId: string;
  selectionSha256: string;
  fields: readonly RetagGoldField[];
  instructions: string[];
  entries: Array<RetagGoldSelectionEntry & {
    fields: Record<RetagGoldField, null>;
  }>;
};

export function buildRetagGoldPacket(selection: RetagGoldSelection): RetagGoldPacket {
  return {
    schemaVersion: "1.0",
    artifactType: "retag-gold-packet",
    artifactId: `${selection.artifactId}-packet`,
    selectionArtifactId: selection.selectionArtifactId,
    selectionSha256: selection.selectionSha256,
    fields: RETAG_GOLD_FIELDS,
    instructions: [
      "Label each field from the screenshot and available DOM evidence only; do not seed from the existing corpus value.",
      "Use present for an observed canonical value, none only when absence is observable, abstain when evidence is insufficient, and OOV when a real candidate is outside the closed vocabulary.",
      "Type pairing is present only with DOM font evidence; screenshot-only font guesses must be abstain.",
      "Keep this packet private: it contains local image paths and is not a durable repository artifact.",
    ],
    entries: selection.entries.map((entry) => ({
      ...entry,
      fields: Object.fromEntries(RETAG_GOLD_FIELDS.map((field) => [field, null])) as Record<RetagGoldField, null>,
    })),
  };
}

export function validateRetagGoldSubmission(
  submission: RetagGoldSubmission,
  selection: RetagGoldSelection,
  imageShaByEntry?: ReadonlyMap<string, string>,
): void {
  const parsed = RetagGoldSubmissionSchema.parse(submission);
  if (parsed.selectionArtifactId !== selection.selectionArtifactId) throw new Error("submission selection artifact does not match");
  if (parsed.selectionSha256 !== selection.selectionSha256) throw new Error("submission selection hash does not match");
  const expected = new Map(selection.entries.map((entry) => [entry.entryId, entry]));
  if (parsed.labels.length !== expected.size || parsed.labels.some((label) => !expected.has(label.entryId))) {
    throw new Error("submission entry IDs do not match selection");
  }
  for (const label of parsed.labels) {
    const selected = expected.get(label.entryId)!;
    if (label.imageSha256 !== selected.imageSha256) throw new Error(`submission image hash mismatch for ${label.entryId}`);
    const actual = imageShaByEntry?.get(label.entryId);
    if (actual !== undefined && actual !== label.imageSha256) throw new Error(`current image hash mismatch for ${label.entryId}`);
  }
}

/** Require two independently sealed human reviews before treating labels as gold. */
export function validateRetagGoldPair(
  first: RetagGoldSubmission,
  second: RetagGoldSubmission,
  selection: RetagGoldSelection,
): void {
  validateRetagGoldSubmission(first, selection);
  validateRetagGoldSubmission(second, selection);
  if (first.actorId === second.actorId) throw new Error("gold submissions must come from independent actors");
  if (first.reviewerRole === second.reviewerRole) throw new Error("gold submissions must have one gold and one qa reviewer");
}

export function toGoldLabels(submission: RetagGoldSubmission): GoldLabel[] {
  return submission.labels.map((label) => ({
    entryId: label.entryId,
    imageSha256: label.imageSha256,
    fields: Object.fromEntries(RETAG_GOLD_FIELDS.map((field) => {
      const value = label.fields[field];
      const gold: GoldField = {
        status: value.status,
        ...(value.status === "present" ? { value: value.value } : {}),
        ...(value.status === "oov" ? { value: value.oov } : {}),
      };
      return [field, gold];
    })),
  }));
}
