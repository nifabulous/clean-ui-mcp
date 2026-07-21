/**
 * Prompt-leakage and determinism tests for the C2 prompt builder.
 *
 * The security property under test is structural: `buildC2Prompt` accepts ONLY
 * a model-visible brief and a resolved condition input. It has NO label
 * parameter, so reviewer-only fields (goldEvidenceIds, rubricAnchors,
 * adjudicationNotes, requiredDecisionIds, forbiddenClaims, privateMarkers)
 * cannot enter prompt construction by construction.
 *
 * The sentinels below are defense-in-depth: they prove that even if a label
 * field name leaked into a fixture, it would never surface in the serialized
 * prompt. Evidence order is asserted stable, and any change to evidence bytes
 * changes `promptSha256`.
 */
import { describe, expect, it } from "vitest";
import type { C2CaseBrief } from "./case-contracts.js";
import type { C2ConditionInput } from "./condition-contracts.js";
import { buildC2Prompt } from "./prompt-builder.js";

// ---------------------------------------------------------------------------
// Unique reviewer-only sentinels. Each sentinel is a plausible leak shape for
// one reviewer-only field — a gold ID, a rubric anchor string, and an
// adjudication note. None may appear in the serialized prompt.
// ---------------------------------------------------------------------------

const GOLD_ID_SENTINEL = "gold:evidence:audience-hierarchy-7c3a";
const RUBRIC_SENTINEL = "RUBRIC_ANCHOR_score5_audience-hierarchy-bb91";
const ADJUDICATION_SENTINEL = "ADJUDICATION_NOTE_integrator-must-stay-secondary-2e44";
const REQUIRED_DECISION_SENTINEL = "decision:audience-hierarchy-gold-99f1";
const FORBIDDEN_CLAIM_SENTINEL = "FORBIDDEN_claim_licensed-in-every-market-11ad";
const PRIVATE_MARKER_SENTINEL = "/corpus/private/stablecoin-home/secret-00ff";

const REVIEWER_SENTINELS = [
  GOLD_ID_SENTINEL,
  RUBRIC_SENTINEL,
  ADJUDICATION_SENTINEL,
  REQUIRED_DECISION_SENTINEL,
  FORBIDDEN_CLAIM_SENTINEL,
  PRIVATE_MARKER_SENTINEL,
] as const;

// ---------------------------------------------------------------------------
// Helpers — minimal, schema-valid fixtures.
// ---------------------------------------------------------------------------

const SHA_64 = "a".repeat(64);

/**
 * A stand-in for the reviewer-only label. It exists in test scope ONLY and is
 * NEVER passed to `buildC2Prompt` (the function signature has no label
 * parameter). It carries every reviewer-only field populated with unique
 * sentinels. The leakage tests below assert none of these sentinels reaches
 * the prompt — proving the builder cannot surface reviewer-only data it was
 * never given.
 */
function reviewerOnlyLabel() {
  return {
    goldEvidenceIds: [GOLD_ID_SENTINEL],
    rubricAnchors: [
      {
        dimension: "product-appropriateness",
        score1: RUBRIC_SENTINEL,
        score3: RUBRIC_SENTINEL,
        score5: RUBRIC_SENTINEL,
      },
    ],
    adjudicationNotes: [ADJUDICATION_SENTINEL],
    requiredDecisionIds: [REQUIRED_DECISION_SENTINEL],
    forbiddenClaims: [FORBIDDEN_CLAIM_SENTINEL],
    privateMarkers: [PRIVATE_MARKER_SENTINEL],
  };
}

function brief(): C2CaseBrief {
  return {
    schemaVersion: "1.0",
    artifactType: "c2-case-brief",
    artifactId: "c2-brief-prompt-builder-test-v1",
    caseId: "prompt-builder-test",
    caseVersion: 1,
    family: "product",
    stratum: "prompt-builder-test",
    title: "Prompt builder determinism test brief",
    productContext:
      "A fictional early-stage infrastructure provider that lets businesses move between fiat and stablecoins.",
    users: ["cross-border payments lead at a business", "treasury operations lead at a business"],
    jobs: ["understand what the service does", "request access"],
    platform: "responsive-web",
    requiredJourneys: ["visitor lands on home and reaches the request-access form"],
    constraints: [
      "Do not claim regulatory licences or supported corridors.",
      "Businesses are the primary audience; the integrator path must remain available.",
    ],
    requiredScreens: [
      {
        id: "home",
        states: ["default", "request-access-success"],
        mobileRules: ["single primary action above the fold"],
      },
    ],
    sourceSnapshotRef: null,
  };
}

function fileRef(artifactId: string, path: string, sha256: string = SHA_64) {
  return { artifactId, path, sha256 };
}

function briefOnlyConditionInput(): C2ConditionInput {
  return {
    schemaVersion: "1.0",
    artifactType: "c2-condition-input",
    artifactId: "c2-condition-brief-only-prompt-builder-test-v1",
    casePackageRef: fileRef("c2-package-prompt-builder-test-v1", "eval/c2/pilot/package.json"),
    briefRef: fileRef("c2-brief-prompt-builder-test-v1", "eval/c2/pilot/brief.json"),
    sourceSnapshotRefs: [],
    inputSha256: SHA_64,
    condition: "brief-only",
    evidence: [],
    corpusSha256: null,
    retrievalIndexSha256: null,
    retrieval: null,
  };
}

function evidenceRecord(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    authorityLane: "adapt",
    sourceType: "brief-fragment",
    sourceArtifactId: "c2-brief-prompt-builder-test-v1",
    sourceSha256: SHA_64,
    contentSha256: SHA_64,
    rank: null,
    score: null,
    ...overrides,
  };
}

function goldEvidenceConditionInput(): C2ConditionInput {
  return {
    schemaVersion: "1.0",
    artifactType: "c2-condition-input",
    artifactId: "c2-condition-gold-evidence-prompt-builder-test-v1",
    casePackageRef: fileRef("c2-package-prompt-builder-test-v1", "eval/c2/pilot/package.json"),
    briefRef: fileRef("c2-brief-prompt-builder-test-v1", "eval/c2/pilot/brief.json"),
    sourceSnapshotRefs: [],
    inputSha256: SHA_64,
    condition: "gold-evidence",
    evidence: [
      evidenceRecord("evidence:brief:audience-hierarchy", { rank: 1, score: 0.9 }),
      evidenceRecord("evidence:brief:primary-cta", { rank: 2, score: 0.8 }),
    ],
    corpusSha256: SHA_64,
    retrievalIndexSha256: SHA_64,
    retrieval: null,
    goldPacketRef: fileRef("gold-packet-prompt-builder-test-v1", ".c2-private/c2/gold/test.json"),
    resolvedGoldIds: ["evidence:brief:audience-hierarchy", "evidence:brief:primary-cta"],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildC2Prompt — reviewer-only sentinels never appear in the prompt", () => {
  // The label is constructed here so a reviewer-only object carrying every
  // sentinel is provably in scope, then provably NOT passed to buildC2Prompt.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const label = reviewerOnlyLabel();

  const input = {
    brief: brief(),
    conditionInput: goldEvidenceConditionInput(),
    evidenceContent: new Map<string, string>([
      ["evidence:brief:audience-hierarchy", "Audience hierarchy finding: businesses lead, integrator secondary."],
      ["evidence:brief:primary-cta", "Primary call-to-action finding: exactly one primary CTA above the fold."],
    ]),
  };

  const { prompt } = buildC2Prompt(input);

  for (const sentinel of REVIEWER_SENTINELS) {
    it(`does not contain reviewer sentinel "${sentinel.slice(0, 24)}…"`, () => {
      // Defense-in-depth: even though a label carrying this sentinel was in
      // scope at call time, the builder never received it, so the bytes cannot
      // appear in the prompt.
      expect(prompt).not.toContain(sentinel);
    });
  }

  it("does not reference label-only field names (goldEvidenceIds, rubricAnchors, adjudicationNotes)", () => {
    // The canonical brief JSON carries none of the reviewer-only keys (the
    // brief schema omits them by design), so the field NAMES cannot surface
    // either. This guards against a future fixture accidentally including a
    // reviewer-only key in a brief.
    expect(prompt).not.toContain("goldEvidenceIds");
    expect(prompt).not.toContain("rubricAnchors");
    expect(prompt).not.toContain("adjudicationNotes");
    expect(prompt).not.toContain("requiredDecisionIds");
    expect(prompt).not.toContain("forbiddenClaims");
    expect(prompt).not.toContain("privateMarkers");
  });
});

describe("buildC2Prompt — determinism and evidence ordering", () => {
  it("produces a stable prompt and promptSha256 for identical inputs", () => {
    const input = {
      brief: brief(),
      conditionInput: goldEvidenceConditionInput(),
      evidenceContent: new Map<string, string>([
        ["evidence:brief:audience-hierarchy", "Audience hierarchy finding A."],
        ["evidence:brief:primary-cta", "Primary CTA finding A."],
      ]),
    };
    const first = buildC2Prompt(input);
    const second = buildC2Prompt(input);
    expect(first.prompt).toBe(second.prompt);
    expect(first.promptSha256).toBe(second.promptSha256);
    expect(first.promptSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changing evidence content changes promptSha256", () => {
    const base = {
      brief: brief(),
      conditionInput: goldEvidenceConditionInput(),
      evidenceContent: new Map<string, string>([
        ["evidence:brief:audience-hierarchy", "Audience hierarchy finding A."],
        ["evidence:brief:primary-cta", "Primary CTA finding A."],
      ]),
    };
    const mutated = {
      ...base,
      evidenceContent: new Map<string, string>([
        ["evidence:brief:audience-hierarchy", "Audience hierarchy finding B — mutated bytes."],
        ["evidence:brief:primary-cta", "Primary CTA finding A."],
      ]),
    };
    const before = buildC2Prompt(base);
    const after = buildC2Prompt(mutated);
    expect(before.promptSha256).not.toBe(after.promptSha256);
  });

  it("changing evidence ORDER changes promptSha256 (evidence is order-stable, not set-equivalent)", () => {
    const evidenceA = goldEvidenceConditionInput().evidence;
    const evidenceB = [...evidenceA].reverse();
    const content = new Map<string, string>([
      ["evidence:brief:audience-hierarchy", "Audience hierarchy finding A."],
      ["evidence:brief:primary-cta", "Primary CTA finding A."],
    ]);
    const a = buildC2Prompt({
      brief: brief(),
      conditionInput: { ...goldEvidenceConditionInput(), evidence: evidenceA },
      evidenceContent: content,
    });
    const b = buildC2Prompt({
      brief: brief(),
      conditionInput: { ...goldEvidenceConditionInput(), evidence: evidenceB },
      evidenceContent: content,
    });
    expect(a.promptSha256).not.toBe(b.promptSha256);
  });

  it("changing the brief changes promptSha256", () => {
    const baseBrief = brief();
    const mutatedBrief = { ...baseBrief, title: "Mutated prompt builder determinism test brief" };
    const content = new Map<string, string>([
      ["evidence:brief:audience-hierarchy", "Audience hierarchy finding A."],
      ["evidence:brief:primary-cta", "Primary CTA finding A."],
    ]);
    const input = {
      brief: baseBrief,
      conditionInput: goldEvidenceConditionInput(),
      evidenceContent: content,
    };
    const before = buildC2Prompt(input);
    const after = buildC2Prompt({ ...input, brief: mutatedBrief });
    expect(before.promptSha256).not.toBe(after.promptSha256);
  });
});

describe("buildC2Prompt — brief-only inputs", () => {
  it("produces a valid prompt with no evidence blocks when evidence is empty", () => {
    const { prompt, promptSha256 } = buildC2Prompt({
      brief: brief(),
      conditionInput: briefOnlyConditionInput(),
    });
    expect(prompt).toContain("case-brief");
    expect(promptSha256).toMatch(/^[0-9a-f]{64}$/);
    // Brief-only prompt is independent of the empty evidence-content map.
    const again = buildC2Prompt({
      brief: brief(),
      conditionInput: briefOnlyConditionInput(),
      evidenceContent: new Map(),
    });
    expect(again.promptSha256).toBe(promptSha256);
  });
});

describe("buildC2Prompt — instruction invariants", () => {
  const { prompt } = buildC2Prompt({
    brief: brief(),
    conditionInput: goldEvidenceConditionInput(),
    evidenceContent: new Map<string, string>([
      ["evidence:brief:audience-hierarchy", "Audience hierarchy finding A."],
      ["evidence:brief:primary-cta", "Primary CTA finding A."],
    ]),
  });

  it("tells the model to return a single JSON object", () => {
    expect(prompt.toLowerCase()).toMatch(/one json object|single json object/);
  });

  it("forbids claims beyond the supplied brief and evidence", () => {
    expect(prompt.toLowerCase()).toMatch(/forbid|do not (?:make|claim)|must not claim|beyond the/);
  });

  it("includes the canonical brief JSON", () => {
    expect(prompt).toContain("c2-brief-prompt-builder-test-v1");
    expect(prompt).toContain("prompt-builder-test");
  });

  it("includes ordered evidence blocks", () => {
    expect(prompt).toContain("evidence:brief:audience-hierarchy");
    expect(prompt).toContain("evidence:brief:primary-cta");
    // Evidence appears in declared order: audience-hierarchy before primary-cta.
    const a = prompt.indexOf("evidence:brief:audience-hierarchy");
    const b = prompt.indexOf("evidence:brief:primary-cta");
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThan(a);
  });

  it("includes the candidate JSON schema summary", () => {
    expect(prompt).toContain("globalDirection");
    expect(prompt).toContain("screenBlueprints");
    expect(prompt).toContain("sourceDecisions");
    expect(prompt).toContain("authorityLanes");
    expect(prompt).toContain("acceptanceCriteria");
  });

  it("documents the stable-id format for ids and authorityLanes", () => {
    // Minimal brief-only condition input — the schema summary is present in
    // every prompt regardless of evidence.
    const { prompt } = buildC2Prompt({
      brief: brief(),
      conditionInput: briefOnlyConditionInput(),
    });
    // The format rule.
    expect(prompt).toMatch(/stable IDs/i);
    expect(prompt).toMatch(/No spaces/i);
    // authorityLanes specifically called out as ID-references, not prose.
    expect(prompt).toMatch(/authorityLanes.*stable ID/i);
    expect(prompt).toMatch(/NEVER use descriptive phrase/i);
  });

  it("surfaces the provenance hash on a dedicated, unmissable line", () => {
    // Issue A (retry3): the model wrote "unknown" for provenance.conditionInputSha256
    // because the hash was buried only inside the condition-input JSON block. The
    // prompt now surfaces it on a dedicated PROVENANCE HASH line so the model
    // cannot miss it.
    const ci = briefOnlyConditionInput();
    const { prompt } = buildC2Prompt({ brief: brief(), conditionInput: ci });
    expect(prompt).toMatch(/PROVENANCE HASH/i);
    expect(prompt).toContain(ci.inputSha256);
    // The surfaced line must instruct the model to copy the exact value.
    expect(prompt).toMatch(/copy this EXACT value/i);
  });

  it("clarifies that assumptions and accessibilityAndRecovery are plain strings, not objects", () => {
    // Bug #3: the candidate schema requires `assumptions: UniqueNonEmptyStrings`
    // and `accessibilityAndRecovery: UniqueNonEmptyStrings` (arrays of plain
    // strings), but the prompt previously documented these only as `field[]`
    // with no type guidance. The model mirrored the adjacent
    // `acceptanceCriteria[]: { id, statement }` shape and produced
    // `[{id, statement}, ...]` objects, which then failed schema validation.
    // The prompt MUST clarify these two fields are plain strings, NOT objects.
    const { prompt } = buildC2Prompt({ brief: brief(), conditionInput: briefOnlyConditionInput() });
    expect(prompt).toMatch(/assumptions\[\].*plain string/i);
    expect(prompt).toMatch(/NOT object/i);
    expect(prompt).toMatch(/accessibilityAndRecovery\[\].*plain string/i);
  });
});

describe("buildC2Prompt — rejects unmatched evidence", () => {
  it("throws when evidence content is missing for a declared evidence record", () => {
    expect(() =>
      buildC2Prompt({
        brief: brief(),
        conditionInput: goldEvidenceConditionInput(),
        evidenceContent: new Map<string, string>([
          ["evidence:brief:audience-hierarchy", "Only one of two required."],
        ]),
      }),
    ).toThrow(/evidence.*content|missing evidence|unresolved/i);
  });
});
