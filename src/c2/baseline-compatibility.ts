/**
 * C2 post-baseline compatibility contract (Task C4).
 *
 * After the 80-run baseline campaign + human scorecards, the Gold Label Owner
 * authors an OpenAI-vs-Claude compatibility checklist for the 5 independent
 * runs. This contract is the ONLY accepted post-baseline compatibility input —
 * no score completeness or CLI synthesis can create it.
 *
 * The contract binds exactly the 5 manifest-pinned independent run refs (the
 * same `executionMatrix.independentCaseIds` the matrix runs). The match is on
 * the full ref triple (artifactId + path + sha256), treated as a set, so:
 *   - the wrong count fails,
 *   - a foreign run ID fails,
 *   - a tampered hash fails,
 *   - a duplicate fails.
 *
 * The checklist carries the 6 compatibility booleans AND must NOT carry
 * `cliSynthesized: true` — that marker is reserved for the calibration
 * reducer's deterministic estimate and is forbidden on human-authored
 * evidence.
 */
import { z } from "zod";
import { Sha256 } from "../readiness/contracts.js";
import { ArtifactFileRefSchema, NonEmptyText, StableId } from "./primitives.js";

/** A run ref triple: the full content-addressed identity of a run manifest. */
export interface C2BaselineRunRef {
  artifactId: string;
  path: string;
  sha256: string;
}

/** The 6-boolean OpenAI-vs-Claude compatibility checklist (human-authored). */
export interface C2BaselineCompatibilityChecklist {
  criticalDecisionCoverageComplete: boolean;
  contradictoryCriticalDecisions: boolean;
  constraintsRespected: boolean;
  forbiddenClaimsRespected: boolean;
  compatibleJourneys: boolean;
  safetyPassedIndependently: boolean;
}

/** A validated post-baseline compatibility evaluation. */
export interface C2BaselineCompatibilityEvaluation {
  schemaVersion: "1.0";
  artifactType: "c2-baseline-compatibility-evaluation";
  artifactId: string;
  /** Exactly 5 manifest-pinned independent run refs (order-independent). */
  independentRunRefs: ReadonlyArray<C2BaselineRunRef>;
  /** The 6-boolean checklist. Must NOT carry `cliSynthesized`. */
  checklist: C2BaselineCompatibilityChecklist;
  /** The distinct human reviewer who authored the evaluation. */
  reviewerActorId: string;
  /** Non-empty rationale for the compatibility judgement. */
  rationale: string;
  /** ISO-8601 timestamp the evaluation was authored. */
  evaluatedAt: string;
}

/**
 * The base checklist schema (6 booleans). Mirrors
 * `IndependentCompatibilitySchema` from condition-contracts but WITHOUT the
 * optional `cliSynthesized` field — the compatibility evaluation is always
 * human-authored, so the synthesis marker is forbidden, not merely optional.
 */
const BaselineCompatibilityChecklistSchema = z
  .object({
    criticalDecisionCoverageComplete: z.boolean(),
    contradictoryCriticalDecisions: z.boolean(),
    constraintsRespected: z.boolean(),
    forbiddenClaimsRespected: z.boolean(),
    compatibleJourneys: z.boolean(),
    safetyPassedIndependently: z.boolean(),
  })
  .strict();

const BaselineCompatibilityEvaluationSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    artifactType: z.literal("c2-baseline-compatibility-evaluation"),
    artifactId: StableId,
    independentRunRefs: z.array(ArtifactFileRefSchema).length(5),
    checklist: BaselineCompatibilityChecklistSchema,
    reviewerActorId: StableId,
    rationale: NonEmptyText,
    evaluatedAt: z.string().datetime(),
  })
  .strict();

/**
 * Validate a post-baseline compatibility evaluation.
 *
 * @param input - The raw evaluation object (typically `JSON.parse`'d from the
 *   committed artifact).
 * @param expectedIndependentRunRefs - The 5 manifest-pinned independent run
 *   refs the evaluation MUST match (from
 *   `C2BaselineManifest.executionMatrix.independentCaseIds`, resolved to their
 *   run-manifest file refs). The match is order-independent (set equality) but
 *   each ref must match the expected triple exactly (artifactId + path + sha256).
 * @returns The validated evaluation (typed).
 * @throws When the input fails the schema OR the run refs do not match the
 *   expected set. The thrown message names the specific failure so the operator
 *   knows what to fix.
 */
export function validateBaselineCompatibility(
  input: unknown,
  expectedIndependentRunRefs: ReadonlyArray<{ artifactId: string; path: string; sha256: string }>,
): C2BaselineCompatibilityEvaluation {
  if (expectedIndependentRunRefs.length !== 5) {
    throw new Error(
      `[c2-compatibility] expectedIndependentRunRefs must contain exactly 5 refs (got ${expectedIndependentRunRefs.length}). `
        + `The caller must pass the manifest's resolved independent run refs.`,
    );
  }

  // 1. Schema parse (catches shape drift, wrong artifactType/schemaVersion,
  //    a smuggled extra field, missing checklist booleans, a non-ISO timestamp,
  //    and a non-5 ref array).
  let parsed: C2BaselineCompatibilityEvaluation;
  try {
    parsed = BaselineCompatibilityEvaluationSchema.parse(input) as C2BaselineCompatibilityEvaluation;
  } catch (err) {
    throw new Error(
      `[c2-compatibility] evaluation failed schema parse: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 2. Reject a CLI-synthesized checklist. The marker is optional on the
  //    IndependentCompatibility type but FORBIDDEN on a human-authored
  //    compatibility evaluation — score completeness or a CLI estimate can
  //    never stand in for the OpenAI-vs-Claude judgement.
  const raw = input as Record<string, unknown>;
  const rawChecklist = raw.checklist as Record<string, unknown> | undefined;
  if (rawChecklist && rawChecklist.cliSynthesized === true) {
    throw new Error(
      `[c2-compatibility] evaluation checklist carries cliSynthesized: true. `
        + `A compatibility evaluation must be human-authored; CLI synthesis is forbidden.`,
    );
  }

  // 3. Run-ref set match. Each ref must equal an expected ref (full triple).
  //    Order-independent; duplicates fail because the set sizes diverge.
  const expectedKeys = new Set(
    expectedIndependentRunRefs.map((r) => refKey(r)),
  );
  if (expectedKeys.size !== 5) {
    throw new Error(
      `[c2-compatibility] expectedIndependentRunRefs contains duplicates (set size ${expectedKeys.size} ≠ 5).`,
    );
  }
  const actualKeys = parsed.independentRunRefs.map((r) => refKey(r));
  const actualSet = new Set(actualKeys);
  if (actualSet.size !== 5) {
    throw new Error(
      `[c2-compatibility] independentRunRefs contains duplicates (5 slots but ${actualSet.size} unique refs).`,
    );
  }
  for (const key of actualKeys) {
    if (!expectedKeys.has(key)) {
      throw new Error(
        `[c2-compatibility] independentRunRefs mismatch: a run ref does not match any manifest-pinned independent ref. `
          + `The evaluation must bind exactly the 5 manifest independent run refs (artifactId + path + sha256, set-equal).`,
      );
    }
  }

  return parsed;
}

/** Content-addressed key for a run ref (the full triple). */
function refKey(r: { artifactId: string; path: string; sha256: string }): string {
  return `${r.artifactId}\u0000${r.path}\u0000${r.sha256}`;
}

// Re-export the schema primitive types so the barrel + callers can reference
// them without importing zod.
export type { Sha256 };
