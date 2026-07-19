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

export const C2PilotManifestSchema = z.object({
  schemaVersion: z.literal("1.0"),
  artifactType: z.literal("c2-pilot-manifest"),
  artifactId: StableId,
  manifestVersion: z.literal(1),
  caseCount: z.literal(3),
  families: z.tuple([z.literal("migration"), z.literal("product"), z.literal("safety")]),
  packages: z.array(C2CasePackageManifestSchema).length(3),
}).strict().superRefine((manifest, ctx) => {
  if (!hasUniqueStrings(manifest.packages.map((pkg) => pkg.caseId))) {
    ctx.addIssue({ code: "custom", path: ["packages"], message: "pilot case IDs must be unique" });
  }
  for (const family of manifest.families) {
    if (manifest.packages.filter((pkg) => pkg.family === family).length !== 1) {
      ctx.addIssue({ code: "custom", path: ["packages"], message: `exactly one ${family} package required` });
    }
  }
});

export type C2CaseBrief = z.infer<typeof C2CaseBriefSchema>;
export type C2DecisionLabel = z.infer<typeof C2DecisionLabelSchema>;
export type C2CasePackageManifest = z.infer<typeof C2CasePackageManifestSchema>;
export type C2PilotManifest = z.infer<typeof C2PilotManifestSchema>;
