import { z } from "zod";
import { Sha256 } from "../readiness/contracts.js";

export const NonEmptyText = z.string().trim().min(1);
export const StableId = z.string().trim().regex(/^[a-z0-9]+(?:[.:_-][a-z0-9]+)*$/);
export const PositiveVersion = z.number().int().min(1);
export const RepoRelativePath = z.string().trim().min(1).refine(
  (value) => !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes(".."),
  "path must be normalized and repository-relative",
);

export const C2_CASE_FAMILIES = ["product", "migration", "safety"] as const;
export const C2CaseFamilySchema = z.enum(C2_CASE_FAMILIES);
export const C2_CONTROL_CONDITIONS = ["brief-only", "current-grounded", "gold-evidence", "corrected-label-shadow"] as const;
export const C2ControlConditionSchema = z.enum(C2_CONTROL_CONDITIONS);
export const AuthorityLaneSchema = z.enum(["retain", "adapt", "reject"]);

export const ArtifactFileRefSchema = z.object({
  artifactId: StableId,
  path: RepoRelativePath,
  sha256: Sha256,
}).strict();

export function hasUniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

export const UniqueNonEmptyStrings = z.array(NonEmptyText).min(1).refine(hasUniqueStrings, "values must be unique");
export type ArtifactFileRef = z.infer<typeof ArtifactFileRefSchema>;
