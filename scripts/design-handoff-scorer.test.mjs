import { describe, expect, it } from "vitest";
import { scoreDesignHandoff } from "./design-handoff-scorer.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// OUTPUT SHAPE (the design-handoff artifact the scorer evaluates).
// This shape is the test's own coherent, deterministic design. It exercises all
// eight mutation cases below. The scorer reads these fields:
//
//   {
//     globalDirection: { tone, primaryTypography, motionApproach },
//     screenBlueprints: [
//       {
//         id,                       // stable screen id (matches label.requiredScreenStates keys)
//         name,                     // human label
//         requiredStates: [ "empty", "loading", "populated" ],  // required screen states (per label)
//         mobileRules: [ "stack-to-single-column", ... ],       // required mobile-responsive rules
//         inspectedUrls: [ "https://example.com/..." ],         // URLs claimed as directly inspected
//       },
//     ],
//     acceptanceCriteria: [ { id, statement } ],   // id matches label.requiredAcceptanceCriteria ids
//     assumptions: [ "Assume dark mode is out of scope." ],
//     authorityLanes: {
//       retain: [ { id, rationale } ],
//       adapt:  [ { id, rationale } ],
//       reject: [ { id, rationale } ],
//     },
//     sourceDecisions: [
//       { id, lane: "retain" | "adapt" | "reject", rationale, evidence: [ "src:..." ] },
//     ],
//     sourceObservations: [
//       // An observation drawn from the source material. Each MUST carry a lane
//       // so it is not mistaken for a target decision (mutation 7).
//       { id, note, lane: "retain" | "adapt" | "reject" },
//     ],
//     evidenceIds: [ "src:home:layout", ... ],   // the valid evidence set; references outside it are unresolved (mutation 6)
//   }
//
// No field may carry a private product name, entry id, or image path — the label
// declares `privateMarkers` and the scorer scans the serialized output (mutation 5).
// ─────────────────────────────────────────────────────────────────────────────

// Minimal valid output for the GOLD_LABEL. Meets every required section,
// decision, screen state, acceptance criterion, and contains no private
// identifiers, no forbidden claims, and no unresolved evidence.
function makeOutput(overrides = {}) {
  return {
    globalDirection: {
      tone: "calm and confident",
      primaryTypography: "humanist sans",
      motionApproach: "DOM-grounded micro-interactions only",
    },
    screenBlueprints: [
      {
        id: "home",
        name: "Home",
        requiredStates: ["empty", "loading", "populated"],
        mobileRules: ["stack-to-single-column", "collapse-secondary-nav"],
        inspectedUrls: ["https://example.com/home"],
      },
      {
        id: "detail",
        name: "Detail",
        requiredStates: ["empty", "loading", "populated"],
        mobileRules: ["stack-to-single-column", "sticky-primary-action"],
        inspectedUrls: ["https://example.com/detail"],
      },
    ],
    acceptanceCriteria: [
      { id: "ac-empty-state", statement: "Every list view ships an empty state." },
      { id: "ac-loading-skeleton", statement: "Async transitions show a loading skeleton." },
    ],
    assumptions: [
      "Assume dark mode is out of scope for this pass.",
      "Assume the analytics event schema is stable.",
    ],
    authorityLanes: {
      retain: [{ id: "src:home:layout", rationale: "Grid reads cleanly on desktop." }],
      adapt: [{ id: "src:detail:typography", rationale: "Promote the secondary weight for hierarchy." }],
      reject: [{ id: "src:home:color", rationale: "Sourced palette fails our 4.5:1 contrast floor." }],
    },
    sourceDecisions: [
      {
        id: "src:home:layout",
        lane: "retain",
        rationale: "Grid reads cleanly on desktop.",
        evidence: ["src:home:layout"],
      },
      {
        id: "src:detail:typography",
        lane: "adapt",
        rationale: "Promote the secondary weight for hierarchy.",
        evidence: ["src:detail:typography"],
      },
      {
        id: "src:home:color",
        lane: "reject",
        rationale: "Sourced palette fails our 4.5:1 contrast floor.",
        evidence: ["src:home:color"],
      },
    ],
    sourceObservations: [
      { id: "src:home:layout", note: "Source home uses a 12-col grid.", lane: "retain" },
    ],
    evidenceIds: [
      "src:home:layout",
      "src:detail:typography",
      "src:home:color",
    ],
    ...overrides,
  };
}

const GOLD_LABEL = {
  id: "design-handoff-fixture",
  labelVersion: 1,
  requiredSections: ["globalDirection", "screenBlueprints", "acceptanceCriteria", "assumptions", "authorityLanes", "sourceDecisions"],
  requiredDecisions: ["src:home:layout", "src:detail:typography", "src:home:color"],
  requiredScreenStates: { home: ["empty", "loading", "populated"], detail: ["empty", "loading", "populated"] },
  requiredAcceptanceCriteria: ["ac-empty-state", "ac-loading-skeleton"],
  requiredMobileRules: ["stack-to-single-column", "collapse-secondary-nav", "sticky-primary-action"],
  permittedAuthorityLanes: ["retain", "adapt", "reject"],
  forbiddenClaims: ["icon-only", "pixel-perfect"],
  privateMarkers: ["acme-corp-secret", "entry-9f3a2b", "/corpus/secret/asset.png"],
  validEvidenceIds: ["src:home:layout", "src:detail:typography", "src:home:color"],
  inaccessibleUrls: ["https://example.com/inaccessible-archive"],
  sourceCoverageExpectation: "well-supported",
  motionDomGrounded: true,
};

describe("scoreDesignHandoff", () => {
  it("scores a perfect output with complete: true and all zeroes", () => {
    expect(scoreDesignHandoff(makeOutput(), GOLD_LABEL)).toEqual({
      complete: true,
      requiredSectionCoverage: 1,
      requiredDecisionCoverage: 1,
      acceptanceCriterionCoverage: 1,
      unsupportedClaimCount: 0,
      forbiddenDisclosureCount: 0,
      unresolvedEvidenceCount: 0,
    });
  });

  // Mutation 1: missing screen state — remove a required state from one blueprint.
  it("mutation 1: a missing required screen state flips complete to false", () => {
    const output = makeOutput({
      screenBlueprints: [
        {
          ...makeOutput().screenBlueprints[0],
          requiredStates: ["empty", "loading"], // "populated" dropped
        },
        makeOutput().screenBlueprints[1],
      ],
    });
    const result = scoreDesignHandoff(output, GOLD_LABEL);
    expect(result.complete).toBe(false);
    // State coverage collapses into the section gate — section coverage drops.
    expect(result.requiredSectionCoverage).toBeLessThan(1);
  });

  // Mutation 2: missing mobile rule — omit a required mobile-responsive rule.
  it("mutation 2: a missing required mobile rule flips complete to false", () => {
    const output = makeOutput({
      screenBlueprints: [
        {
          ...makeOutput().screenBlueprints[0],
          mobileRules: ["stack-to-single-column"], // "collapse-secondary-nav" dropped
        },
        makeOutput().screenBlueprints[1],
      ],
    });
    const result = scoreDesignHandoff(output, GOLD_LABEL);
    expect(result.complete).toBe(false);
    expect(result.requiredSectionCoverage).toBeLessThan(1);
  });

  // Mutation 3: absent acceptance criterion — drop a required acceptance criterion.
  it("mutation 3: a dropped acceptance criterion flips complete to false", () => {
    const output = makeOutput({
      acceptanceCriteria: [
        { id: "ac-empty-state", statement: "Every list view ships an empty state." },
        // "ac-loading-skeleton" dropped
      ],
    });
    const result = scoreDesignHandoff(output, GOLD_LABEL);
    expect(result.complete).toBe(false);
    expect(result.acceptanceCriterionCoverage).toBeLessThan(1);
  });

  // Mutation 4: unsupported source claim — a source decision whose id is not in
  // the permitted source-evidence set (validEvidenceIds). The invented decision
  // carries an EMPTY evidence array so it trips ONLY unsupportedClaimCount,
  // leaving unresolvedEvidenceCount at 0 (M1: isolate the mutation to one count).
  it("mutation 4: an unsupported source claim flips complete to false", () => {
    const output = makeOutput({
      sourceDecisions: [
        ...makeOutput().sourceDecisions,
        {
          id: "src:home:invented-claim", // not in validEvidenceIds
          lane: "retain",
          rationale: "Made up with no source backing.",
          evidence: [],
        },
      ],
    });
    const result = scoreDesignHandoff(output, GOLD_LABEL);
    expect(result.complete).toBe(false);
    expect(result.unsupportedClaimCount).toBeGreaterThan(0);
    expect(result.unresolvedEvidenceCount).toBe(0);
  });

  // Mutation 5: private marker — inject a forbidden private identifier.
  it("mutation 5: a private marker flips complete to false", () => {
    const output = makeOutput({
      globalDirection: {
        ...makeOutput().globalDirection,
        tone: "matches the acme-corp-secret brand", // private marker
      },
    });
    const result = scoreDesignHandoff(output, GOLD_LABEL);
    expect(result.complete).toBe(false);
    expect(result.forbiddenDisclosureCount).toBeGreaterThan(0);
  });

  // Mutation 6: unresolved evidence ID — reference an evidence id outside the valid set.
  it("mutation 6: an unresolved evidence id flips complete to false", () => {
    const output = makeOutput({
      sourceDecisions: [
        {
          id: "src:home:layout",
          lane: "retain",
          rationale: "Grid reads cleanly on desktop.",
          evidence: ["src:home:layout", "src:home:ghost-evidence"], // ghost id
        },
        ...makeOutput().sourceDecisions.slice(1),
      ],
    });
    const result = scoreDesignHandoff(output, GOLD_LABEL);
    expect(result.complete).toBe(false);
    expect(result.unresolvedEvidenceCount).toBeGreaterThan(0);
  });

  // Mutation 7: source observation phrased as target authority (no lane).
  it("mutation 7: a source observation without a lane flips complete to false", () => {
    const output = makeOutput({
      sourceObservations: [
        // Presented as a target decision but carries no retain/adapt/reject lane.
        { id: "src:home:layout", note: "We will rebuild the home grid." },
      ],
    });
    const result = scoreDesignHandoff(output, GOLD_LABEL);
    expect(result.complete).toBe(false);
    expect(result.unsupportedClaimCount).toBeGreaterThan(0);
  });

  // Mutation 8: an inaccessible URL described as inspected.
  it("mutation 8: an inaccessible url claimed as inspected flips complete to false", () => {
    const output = makeOutput({
      screenBlueprints: [
        {
          ...makeOutput().screenBlueprints[0],
          inspectedUrls: ["https://example.com/home", "https://example.com/inaccessible-archive"],
        },
        makeOutput().screenBlueprints[1],
      ],
    });
    const result = scoreDesignHandoff(output, GOLD_LABEL);
    expect(result.complete).toBe(false);
    expect(result.unsupportedClaimCount).toBeGreaterThan(0);
  });

  // Regression for I1: a label that requires states for a blueprint id the
  // output never declares must fail the section gate. Previously the scorer
  // silently skipped the missing blueprint and returned success.
  it("regression I1: a required blueprint id that the output omits fails section coverage", () => {
    const output = makeOutput({
      screenBlueprints: [
        {
          id: "detail",
          name: "Detail",
          requiredStates: ["empty", "loading", "populated"],
          mobileRules: ["stack-to-single-column", "sticky-primary-action"],
          inspectedUrls: ["https://example.com/detail"],
        },
      ],
    });
    const result = scoreDesignHandoff(output, GOLD_LABEL);
    expect(result.complete).toBe(false);
    expect(result.requiredSectionCoverage).toBeLessThan(1);
  });

  // Regression for I2: a null entry inside sourceDecisions must not crash the
  // scorer; valid entries are still counted normally.
  it("regression I2: a null entry in sourceDecisions does not crash and scores normally", () => {
    const valid = makeOutput().sourceDecisions;
    const output = makeOutput({
      sourceDecisions: [null, ...valid],
    });
    const result = scoreDesignHandoff(output, GOLD_LABEL);
    expect(result.complete).toBe(true);
    expect(result.requiredDecisionCoverage).toBe(1);
    expect(result.unsupportedClaimCount).toBe(0);
    expect(result.unresolvedEvidenceCount).toBe(0);
  });
});
