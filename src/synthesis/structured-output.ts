import { CRITIQUE_SCHEMA_VERSION, StructuredCritique, type StructuredCritiqueT } from "./contracts.js";
import type { GuidanceLane } from "./context.js";
import type { RetrievalResult } from "../critique-retrieval.js";
import type { gateCritique } from "../critique-synthesis.js";

type GatedCritique = ReturnType<typeof gateCritique>;

export function buildStructuredCritique(input: {
  platform: string;
  retrieval: Pick<RetrievalResult, "mode" | "fallbackUsed" | "coverage">;
  gated: GatedCritique;
  evidenceIds: string[];
  guidance: GuidanceLane[];
  md3?: StructuredCritiqueT["md3"];
}): StructuredCritiqueT {
  const result = {
    schemaVersion: CRITIQUE_SCHEMA_VERSION,
    platform: input.platform,
    retrievalMode: input.retrieval.mode,
    fallbackUsed: input.retrieval.fallbackUsed,
    coverage: input.retrieval.coverage,
    summary: input.gated.summary,
    observations: input.gated.observations,
    recommendations: input.gated.recommendations.map((rec) => ({
      ...rec,
      basis: (rec.evidence.some((id) => id.startsWith("dom:")) ? "dom-grounded" : "visible") as "visible" | "dom-grounded",
    })),
    accessibilityRisks: input.gated.accessibilityRisks.map((risk) => ({ ...risk, basis: "visible" as const })),
    visualSlop: input.gated.visualSlop,
    motion: input.gated.motion,
    appliedReferences: input.guidance.map(({ id, version, purpose }) => ({ id, version, purpose })),
    evidenceIds: input.evidenceIds,
    confidence: input.retrieval.coverage === "strong" ? "high" as const
      : input.retrieval.coverage === "moderate" ? "medium" as const : "low" as const,
    ...(input.md3 ? { md3: input.md3 } : {}),
  };
  return StructuredCritique.parse(result);
}
