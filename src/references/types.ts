export type ReferenceAuthority =
  | "machine-rule"
  | "editorial"
  | "external-standard";

export type ReferencePurpose =
  | "critique-structure"
  | "text-anti-slop"
  | "visual-anti-slop"
  | "motion-guidance"
  | "design-taxonomy";

export interface ReferenceDescriptor {
  id: string;
  version: number;
  path: string;
  sha256: string;
  authority: ReferenceAuthority;
  purposes: ReferencePurpose[];
  sourceUrl: string;
  sourceCommit: string;
  license: string;
}
