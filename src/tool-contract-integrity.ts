/**
 * Pure semantic validators for tool contract integrity.
 *
 * These functions are called from makeEnvelope's superRefine.
 * They receive already-parsed typed values and add issues to the context.
 */
import type { z } from "zod";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RetrievalMode = "hybrid" | "vector" | "keyword" | "structured-fallback" | "none";
export type RetrievalModality = "text" | "image" | "metadata" | "none";
export type FallbackReason =
  | "missing-index" | "incompatible-index" | "missing-provider-key"
  | "community-edition" | "provider-error" | "no-image-evidence";

export interface RetrievalPolicyState {
  readonly mode: RetrievalMode;
  readonly modality: RetrievalModality;
  readonly fallbackReasons: readonly FallbackReason[];
}

export interface RetrievalPolicy {
  readonly states: readonly RetrievalPolicyState[];
  readonly attemptedModes: readonly RetrievalMode[];
}

// ---------------------------------------------------------------------------
// Set helpers
// ---------------------------------------------------------------------------

export function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const a = new Set(left);
  const b = new Set(right);
  return a.size === b.size && [...a].every(v => b.has(v));
}

// ---------------------------------------------------------------------------
// Retrieval validation
// ---------------------------------------------------------------------------

export interface RetrievalStateValue {
  mode: string;
  modality: string;
  resultCount: number;
  fallbackUsed: boolean;
  attemptedCount: number;
  fallbackReason?: string;
  attemptedModes: string[];
}

/**
 * Validate retrieval state against a tool's policy at the envelope level.
 * Checks status-dependent rules, fallback truth, and tool-specific constraints.
 */
export function validateEnvelopeRetrieval(
  status: "ok" | "error",
  retrieval: RetrievalStateValue,
  policy: RetrievalPolicy,
  ctx: z.RefinementCtx,
): void {
  // The returned mode/modality pair must be in the policy
  const matchingState = policy.states.find(
    s => s.mode === retrieval.mode && s.modality === retrieval.modality,
  );
  if (!matchingState) {
    ctx.addIssue({
      code: "custom",
      message: `retrieval ${retrieval.mode}/${retrieval.modality} not allowed for this tool`,
      path: ["retrieval", "mode"],
    });
    return;
  }

  // Error status: fallbackUsed must be false, no fallbackReason
  if (status === "error") {
    if (retrieval.fallbackUsed) {
      ctx.addIssue({
        code: "custom",
        message: "error status cannot have fallbackUsed true",
        path: ["retrieval", "fallbackUsed"],
      });
    }
    if (retrieval.fallbackReason !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "error status cannot have fallbackReason",
        path: ["retrieval", "fallbackReason"],
      });
    }
    // Attempted modes are allowed on error (records what failed)
  }

  // Success + fallback: requires positive resultCount, a valid reason, and attempted modes
  if (status === "ok" && retrieval.fallbackUsed) {
    if (retrieval.resultCount === 0) {
      ctx.addIssue({
        code: "custom",
        message: "fallback with zero results is not a successful fallback",
        path: ["retrieval", "resultCount"],
      });
    }
    if (retrieval.fallbackReason === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "fallbackUsed requires fallbackReason",
        path: ["retrieval", "fallbackReason"],
      });
    } else if (matchingState.fallbackReasons.length > 0 && !matchingState.fallbackReasons.includes(retrieval.fallbackReason as FallbackReason)) {
      ctx.addIssue({
        code: "custom",
        message: `fallbackReason "${retrieval.fallbackReason}" not allowed for ${retrieval.mode}/${retrieval.modality}`,
        path: ["retrieval", "fallbackReason"],
      });
    }
    if (retrieval.attemptedModes.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "fallback requires non-empty attemptedModes",
        path: ["retrieval", "attemptedModes"],
      });
    }
  }

  // Success without fallback: attemptedModes must be empty
  if (status === "ok" && !retrieval.fallbackUsed && retrieval.attemptedModes.length > 0) {
    ctx.addIssue({
      code: "custom",
      message: "attemptedModes must be empty when fallbackUsed is false and status is ok",
      path: ["retrieval", "attemptedModes"],
    });
  }

  // Every attempted mode must be in the policy's allowed attempted modes
  for (const am of retrieval.attemptedModes) {
    if (!policy.attemptedModes.includes(am as RetrievalMode)) {
      ctx.addIssue({
        code: "custom",
        message: `attemptedMode "${am}" not allowed for this tool`,
        path: ["retrieval", "attemptedModes"],
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Evidence reference validation
// ---------------------------------------------------------------------------

export interface EvidenceReference {
  path: PropertyKey[];
  ids: readonly string[];
}

/**
 * Validate that all referenced evidence IDs exist in the authoritative envelope set.
 */
export function validateEvidenceReferences(
  authoritativeIds: ReadonlySet<string>,
  references: readonly EvidenceReference[],
  ctx: z.RefinementCtx,
): void {
  for (const ref of references) {
    // Check for empty/whitespace IDs
    for (const id of ref.ids) {
      if (!id || !id.trim()) {
        ctx.addIssue({
          code: "custom",
          message: `evidence ID at ${ref.path.join(".")} is empty or whitespace`,
          path: ref.path,
        });
      } else if (!authoritativeIds.has(id)) {
        ctx.addIssue({
          code: "custom",
          message: `evidence ID "${id}" at ${ref.path.join(".")} not found in envelope evidence`,
          path: ref.path,
        });
      }
    }
    // Check for duplicates within this reference list
    const seen = new Set<string>();
    for (const id of ref.ids) {
      if (seen.has(id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate evidence ID "${id}" at ${ref.path.join(".")}`,
          path: ref.path,
        });
      }
      seen.add(id);
    }
  }
}
