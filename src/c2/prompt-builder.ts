/**
 * C2 prompt builder — pure prompt assembly from a model-visible brief and a
 * resolved condition input.
 *
 * Boundary (spec §3 + §5.3): `buildC2Prompt` accepts ONLY a model-visible
 * `C2CaseBrief` and a resolved condition input. It does NOT accept a full case
 * package or any reviewer-only label. This is structural enforcement: the
 * function signature has no label parameter, so reviewer-only fields
 * (goldEvidenceIds, rubricAnchors, adjudicationNotes, requiredDecisionIds,
 * forbiddenClaims, privateMarkers) cannot enter prompt construction by
 * construction.
 *
 * The prompt contains exactly four sections, nothing else:
 *   1. A fixed system instruction.
 *   2. The canonical model-visible brief JSON.
 *   3. Ordered evidence blocks (one per declared evidence record, in order).
 *   4. The candidate JSON schema summary.
 *
 * Determinism: the prompt is assembled deterministically and hashed over its
 * exact UTF-8 bytes via `sha256Hex`. Two calls with identical inputs produce
 * identical bytes and identical `promptSha256`.
 *
 * Why evidence content is passed separately: the condition-input record carries
 * hashes and metadata, not content bytes (see `C2EvidenceRecord`). The caller
 * resolves actual model-visible content and supplies it via `evidenceContent`,
 * keyed by evidence record ID. The builder refuses to emit a prompt if any
 * declared evidence record lacks resolved content — fail closed before any
 * provider call.
 */
import { canonicalJsonStringify, sha256Hex } from "../readiness/contracts.js";
import type { C2CaseBrief } from "./case-contracts.js";
import type { C2ConditionInput, C2EvidenceRecord } from "./condition-contracts.js";

/** Model-visible evidence content keyed by evidence record ID. */
export type ResolvedEvidenceContent = ReadonlyMap<string, string>;

/**
 * Inputs to prompt construction. Deliberately carries NO label: only a
 * model-visible brief, a resolved condition input, and the resolved content
 * for every evidence record the input declares.
 */
export interface BuildC2PromptInput {
  /** Model-visible case brief. */
  brief: C2CaseBrief;
  /** Resolved condition input (carries evidence metadata + ordering). */
  conditionInput: C2ConditionInput;
  /**
   * Model-visible content for every evidence record in `conditionInput.evidence`,
   * keyed by evidence record ID. May be omitted for brief-only inputs whose
   * evidence array is empty.
   */
  evidenceContent?: ResolvedEvidenceContent;
}

/** Output of prompt construction: the canonical prompt and its SHA-256. */
export interface BuiltPrompt {
  prompt: string;
  promptSha256: string;
}

// ---------------------------------------------------------------------------
// Fixed instruction text — part of the prompt byte-stream, so changing this
// string changes every `promptSha256` by design. Edit deliberately.
// ---------------------------------------------------------------------------

const SYSTEM_INSTRUCTION = [
  "You are a design-decisions architect for a C2 case.",
  "Produce ONE JSON object that satisfies the supplied candidate schema summary.",
  "Ground every claim strictly in the supplied case brief and the supplied ordered evidence blocks.",
  "You MUST NOT make claims beyond the case brief and evidence: do not invent regulatory licences, supported corridors, exchange rates, settlement times, insurance coverage, partner counts, customer counts, volume figures, pricing tiers, or any uninspected content.",
  "Do not reproduce proprietary wordmarks, logos, exact copy, unique illustrations, exact branded palettes, or distinctive iconography.",
  "If a direction is not grounded in the supplied brief or evidence, record it as an explicit assumption with stated uncertainty.",
  "Return exactly one JSON object and nothing else — no prose, no markdown fence, no commentary.",
].join(" ");

// ---------------------------------------------------------------------------
// Candidate schema summary (model-visible). A condensed description of the
// required top-level shape so the model knows what to emit. This is NOT the
// full Zod schema; it is a stable summary whose bytes are part of the prompt.
// ---------------------------------------------------------------------------

const CANDIDATE_SCHEMA_SUMMARY = [
  "Candidate JSON schema summary (required top-level fields):",
  "- All id and authorityLanes values must be stable IDs: lowercase alphanumeric with . : _ - separators (e.g. landing, note-capture, sd1, retain-headline-stack). No spaces, uppercase, or prose.",
  "- schemaVersion: \"1.0\"",
  "- artifactType: \"c2-candidate-design\"",
  "- artifactId: stable id",
  "- caseId: must equal the brief caseId",
  "- globalDirection: { summary, principles[] }",
  "- screenBlueprints[]: { id, summary, requiredStates[], mobileRules[], accessibility[], failureAndRecovery[], inspectedUrls[] } — one blueprint per brief-required screen, including every required state and mobile rule",
  "- sourceDecisions[]: { id, lane: retain|adapt|reject, rationale, evidenceIds[] } — cite only evidence IDs supplied below",
  "- authorityLanes: { retain[], adapt[], reject[] } — each value is a stable ID referencing a retained/adapted/rejected concept (e.g. retain: [\"headline-stack\"], adapt: [\"branded-palette\"], reject: [\"decorative-gradient\"]), NOT a descriptive phrase",
  "- acceptanceCriteria[]: { id, statement }",
  "- assumptions[]",
  "- accessibilityAndRecovery[]",
  "- provenance: { conditionInputSha256 } — must equal the supplied conditionInput.inputSha256",
].join("\n");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function encodeEvidenceBlock(record: C2EvidenceRecord, content: string): string {
  // Each block is a stable, ordered serialization of the record's
  // model-visible metadata + the resolved content. The record carries hashes,
  // the authority lane, the source type, and rank/score; content is appended
  // as a fenced block so the model sees the actual bytes.
  const header = [
    `evidence-id: ${record.id}`,
    `authority-lane: ${record.authorityLane}`,
    `source-type: ${record.sourceType}`,
    `source-artifact-id: ${record.sourceArtifactId}`,
    `source-sha256: ${record.sourceSha256}`,
    `content-sha256: ${record.contentSha256}`,
  ].join("\n");
  return `${header}\ncontent:\n${content}`;
}

function assertEvidenceContentPresent(input: BuildC2PromptInput): void {
  const evidence = input.conditionInput.evidence;
  if (evidence.length === 0) return;
  const content = input.evidenceContent ?? new Map<string, string>();
  const missing: string[] = [];
  for (const record of evidence) {
    if (!content.has(record.id)) missing.push(record.id);
  }
  if (missing.length > 0) {
    throw new Error(
      `buildC2Prompt: missing evidence content for ${missing.length} declared evidence record(s): ${missing.join(", ")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build the canonical C2 prompt from a model-visible brief and a resolved
 * condition input. The function signature carries NO label parameter by
 * design; reviewer-only fields cannot reach prompt construction.
 *
 * Throws if any declared evidence record lacks resolved content.
 */
export function buildC2Prompt(input: BuildC2PromptInput): BuiltPrompt {
  assertEvidenceContentPresent(input);

  const briefJson = canonicalJsonStringify(input.brief);

  const evidence = input.conditionInput.evidence;
  const content = input.evidenceContent ?? new Map<string, string>();

  const evidenceSection =
    evidence.length === 0
      ? "Ordered evidence blocks: (none — brief-only condition; cite no evidence)."
      : evidence
          .map((record, index) => {
            const block = encodeEvidenceBlock(record, content.get(record.id) ?? "");
            return `--- EVIDENCE ${index + 1} ---\n${block}`;
          })
          .join("\n\n");

  // Deterministic assembly. Section order is fixed; section boundaries are
  // explicit markers so the model (and any byte-diff tooling) can locate them.
  const prompt = [
    "### SYSTEM INSTRUCTION ###",
    SYSTEM_INSTRUCTION,
    "",
    "### CASE BRIEF (canonical JSON) ###",
    briefJson,
    "",
    "### ORDERED EVIDENCE ###",
    evidenceSection,
    "",
    "### CANDIDATE SCHEMA SUMMARY ###",
    CANDIDATE_SCHEMA_SUMMARY,
    "",
  ].join("\n");

  const promptSha256 = sha256Hex(Buffer.from(prompt, "utf-8"));
  return { prompt, promptSha256 };
}
