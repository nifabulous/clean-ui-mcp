import { z } from "zod";
import {
  ArtifactFileRefSchema,
  AuthorityLaneSchema,
  C2CaseFamilySchema,
  NonEmptyText,
  PositiveVersion,
  StableId,
  UniqueNonEmptyStrings,
  hasUniqueStrings,
} from "./primitives.js";
import { Sha256 } from "../readiness/contracts.js";

const ScreenRequirementSchema = z.object({
  id: StableId,
  states: UniqueNonEmptyStrings,
  mobileRules: UniqueNonEmptyStrings,
}).strict();

const SourceSnapshotRefSchema = ArtifactFileRefSchema.extend({
  artifactType: z.literal("design-source-snapshot"),
}).strict();

export const C2CaseBriefSchema = z.object({
  schemaVersion: z.literal("1.0"),
  artifactType: z.literal("c2-case-brief"),
  artifactId: StableId,
  caseId: StableId,
  caseVersion: PositiveVersion,
  family: C2CaseFamilySchema,
  stratum: StableId,
  title: NonEmptyText,
  productContext: NonEmptyText,
  users: UniqueNonEmptyStrings,
  jobs: UniqueNonEmptyStrings,
  platform: z.enum(["responsive-web", "mobile-app"]),
  requiredJourneys: UniqueNonEmptyStrings,
  constraints: UniqueNonEmptyStrings,
  requiredScreens: z.array(ScreenRequirementSchema).min(1).refine(
    (screens) => hasUniqueStrings(screens.map((screen) => screen.id)),
    "screen IDs must be unique",
  ),
  sourceSnapshotRef: SourceSnapshotRefSchema.nullable(),
}).strict().superRefine((brief, ctx) => {
  if (brief.family === "migration" && brief.sourceSnapshotRef === null) {
    ctx.addIssue({ code: "custom", path: ["sourceSnapshotRef"], message: "migration case requires source snapshot" });
  }
  if (brief.family !== "migration" && brief.sourceSnapshotRef !== null) {
    ctx.addIssue({ code: "custom", path: ["sourceSnapshotRef"], message: "only migration cases bind source snapshots" });
  }
});

const RubricDimensionSchema = z.enum([
  "product-appropriateness",
  "cross-screen-coherence",
  "implementation-clarity",
  "originality",
  "accessibility-and-failure-states",
  "evidence-discipline",
]);

const RubricAnchorSchema = z.object({
  dimension: RubricDimensionSchema,
  score1: NonEmptyText,
  score3: NonEmptyText,
  score5: NonEmptyText,
}).strict();

export const C2DecisionLabelSchema = z.object({
  schemaVersion: z.literal("1.0"),
  artifactType: z.literal("c2-decision-label"),
  artifactId: StableId,
  caseId: StableId,
  caseVersion: PositiveVersion,
  labelVersion: z.literal(2),
  requiredSections: UniqueNonEmptyStrings,
  requiredDecisionIds: UniqueNonEmptyStrings,
  requiredAcceptanceCriteria: UniqueNonEmptyStrings,
  permittedAuthorityLanes: z.array(AuthorityLaneSchema).min(1).refine(hasUniqueStrings, "authority lanes must be unique"),
  validEvidenceIds: UniqueNonEmptyStrings,
  goldEvidenceIds: UniqueNonEmptyStrings,
  forbiddenClaims: UniqueNonEmptyStrings,
  privateMarkers: UniqueNonEmptyStrings,
  rubricAnchors: z.array(RubricAnchorSchema).length(6).refine(
    (anchors) => hasUniqueStrings(anchors.map((anchor) => anchor.dimension)),
    "exactly one anchor per rubric dimension is required",
  ),
  adjudicationNotes: UniqueNonEmptyStrings,
}).strict().superRefine((label, ctx) => {
  const valid = new Set(label.validEvidenceIds);
  for (const id of label.goldEvidenceIds) if (!valid.has(id)) {
    ctx.addIssue({ code: "custom", path: ["goldEvidenceIds"], message: `gold evidence is not valid: ${id}` });
  }
});

export const C2CasePackageManifestSchema = z.object({
  schemaVersion: z.literal("1.0"),
  artifactType: z.literal("c2-case-package"),
  artifactId: StableId,
  caseId: StableId,
  caseVersion: PositiveVersion,
  family: C2CaseFamilySchema,
  brief: ArtifactFileRefSchema,
  label: ArtifactFileRefSchema,
  sourceSnapshot: ArtifactFileRefSchema.nullable(),
}).strict().superRefine((manifest, ctx) => {
  if (manifest.family === "migration" && manifest.sourceSnapshot === null) {
    ctx.addIssue({ code: "custom", path: ["sourceSnapshot"], message: "migration package requires source snapshot" });
  }
  if (manifest.family !== "migration" && manifest.sourceSnapshot !== null) {
    ctx.addIssue({ code: "custom", path: ["sourceSnapshot"], message: "non-migration package forbids source snapshot" });
  }
});

// ---------------------------------------------------------------------------
// Gold-evidence descriptors (Task 3)
//
// A descriptor maps every reviewer-only `goldEvidenceId` declared on a label
// to exact source JSON pointers + the source artifact's hash — it does NOT
// duplicate prose. The manifest builder resolves each pointer against the
// bound source artifact, hashes the resolved bytes, rejects unknown
// pointers/IDs, and binds a per-record `resolvedSha256` without copying any
// reviewer field into the brief.
//
// The `C2GoldEvidenceRecordBinding` shape is the per-record binding the pilot
// manifest carries: the descriptor record ID + its source artifact id + a
// canonical SHA-256 over the resolved bytes at every declared pointer. The
// manifest does NOT carry the resolved content itself (content stays private).
// ---------------------------------------------------------------------------

const JsonPointer = z
  .string()
  .min(1)
  .refine((p) => p === "" || p.startsWith("/"), "JSON pointer must be empty or start with '/'")
  .refine(
    (p) => !p.includes("//"),
    "JSON pointer must not contain empty segments",
  );

export const C2GoldEvidenceRecordSchema = z.object({
  id: StableId,
  sourceArtifactId: StableId,
  jsonPointers: z.array(JsonPointer).min(1),
}).strict();

export const C2GoldEvidenceDescriptorSchema = z.object({
  schemaVersion: z.literal("1.0"),
  artifactType: z.literal("c2-gold-evidence-descriptor"),
  artifactId: StableId,
  caseId: StableId,
  records: z.array(C2GoldEvidenceRecordSchema).min(1).refine(
    (records) => hasUniqueStrings(records.map((r) => r.id)),
    "gold evidence record IDs must be unique within a descriptor",
  ),
}).strict();

export const C2GoldEvidenceRecordBindingSchema = z.object({
  id: StableId,
  sourceArtifactId: StableId,
  resolvedSha256: Sha256,
}).strict();

export const C2PilotGoldEvidenceBindingSchema = z.object({
  schemaVersion: z.literal("1.0"),
  artifactType: z.literal("c2-gold-evidence-binding"),
  artifactId: StableId,
  caseId: StableId,
  descriptor: ArtifactFileRefSchema,
  records: z.array(C2GoldEvidenceRecordBindingSchema).min(1),
}).strict();

export const C2PilotManifestSchema = z.object({
  schemaVersion: z.literal("1.0"),
  artifactType: z.literal("c2-pilot-manifest"),
  artifactId: StableId,
  manifestVersion: z.literal(1),
  caseCount: z.literal(3),
  families: z.tuple([z.literal("migration"), z.literal("product"), z.literal("safety")]),
  packages: z.array(C2CasePackageManifestSchema).length(3),
  goldEvidenceBindings: z.array(C2PilotGoldEvidenceBindingSchema).length(3),
}).strict().superRefine((manifest, ctx) => {
  if (!hasUniqueStrings(manifest.packages.map((pkg) => pkg.caseId))) {
    ctx.addIssue({ code: "custom", path: ["packages"], message: "pilot case IDs must be unique" });
  }
  for (const family of manifest.families) {
    if (manifest.packages.filter((pkg) => pkg.family === family).length !== 1) {
      ctx.addIssue({ code: "custom", path: ["packages"], message: `exactly one ${family} package required` });
    }
  }
  if (!hasUniqueStrings(manifest.goldEvidenceBindings.map((b) => b.caseId))) {
    ctx.addIssue({ code: "custom", path: ["goldEvidenceBindings"], message: "gold-evidence binding case IDs must be unique" });
  }
  const packageCaseIds = new Set(manifest.packages.map((pkg) => pkg.caseId));
  for (const binding of manifest.goldEvidenceBindings) {
    if (!packageCaseIds.has(binding.caseId)) {
      ctx.addIssue({ code: "custom", path: ["goldEvidenceBindings"], message: `gold-evidence binding caseId ${binding.caseId} has no matching package` });
    }
  }
});

export type C2CaseBrief = z.infer<typeof C2CaseBriefSchema>;
export type C2DecisionLabel = z.infer<typeof C2DecisionLabelSchema>;
export type C2CasePackageManifest = z.infer<typeof C2CasePackageManifestSchema>;
export type C2PilotManifest = z.infer<typeof C2PilotManifestSchema>;
// Gold-evidence descriptor + record types (Task 3). The descriptor maps every
// reviewer-only goldEvidenceId to exact source JSON pointers; the condition
// resolver (Task 6) consumes these to resolve model-visible bytes without
// copying reviewer fields. Exported as inferred types so consumers (resolver,
// manifest builder) share one canonical shape with the schema.
export type C2GoldEvidenceRecord = z.infer<typeof C2GoldEvidenceRecordSchema>;
export type C2GoldEvidenceDescriptor = z.infer<typeof C2GoldEvidenceDescriptorSchema>;
export type C2GoldEvidenceRecordBinding = z.infer<typeof C2GoldEvidenceRecordBindingSchema>;
export type C2PilotGoldEvidenceBinding = z.infer<typeof C2PilotGoldEvidenceBindingSchema>;
