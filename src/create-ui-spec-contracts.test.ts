/**
 * create-ui-spec-contracts.test.ts — TDD for the strict C3 artifact contracts.
 *
 * Task 1 of the C3 create-ui-spec first slice. These contracts are the
 * fail-closed boundary between untrusted producer input (the candidate, the
 * retrieval evidence) and the trusted design artifact envelope. The envelope
 * parser re-renders and re-hashes every rendering before accepting it; no
 * stored bytes are trusted blindly.
 */
import { describe, expect, it } from "vitest";
import {
  ArtifactMetadataSchema,
  CANONICAL_WEB_TARGET_PROFILES,
  CreateUiSpecCandidateSchema,
  CreateUiSpecErrorSchema,
  CreateUiSpecRequestSchema,
  DesignArtifactEnvelopeSchema,
  RECIPE_SHA256,
  SanitizedEvidenceSchema,
  buildArtifactIdentityInput,
  buildSemanticSpecInput,
  parseCreateUiSpecCandidate,
  parseDesignArtifactEnvelope,
  sha256Canonical,
} from "./create-ui-spec-contracts.js";
import { DesignSystemIdentitySchema } from "./tool-contracts.js";
import { canonicalJsonStringify, sha256Hex } from "./readiness/contracts.js";
import {
  renderDesignHandoffMarkdown,
  renderDesignHandoffJson,
  parseDesignHandoff,
} from "./design-handoff.js";
import { UiSpec } from "./tool-contracts.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal valid UiSpec 1.0 object (mirrors the canonical fixture). */
function validUiSpec(): Record<string, unknown> {
  return {
    specVersion: "1.0",
    context: { productContext: "A fintech dashboard" },
    designDirection: "Calm layout",
    rejectedDefaults: [],
    layoutRegions: [],
    responsiveBehavior: [],
    componentInventory: [],
    colorTokens: { primary: "#3b82f6", surface: "#fff", ink: "#1e293b", muted: "#64748b", accent: "#3b82f6" },
    colorTokenAuthority: "corpus-evidence",
    typographyTokens: { heading: "Inter", body: "Inter", mono: "JetBrains Mono" },
    typographyTokenAuthority: "corpus-evidence",
    interactions: [],
    motionGuidance: { notes: [], evidenceUnavailable: true },
    accessibilityConstraints: [],
    techniques: [],
    antiPatterns: [],
    unavailableDecisions: [{ field: "motion", reason: "no DOM evidence" }],
    acceptanceCriteria: [{
      id: "ac1", subject: "contrast", assertion: "meets-contrast",
      expectedOutcome: "4.5:1", verifier: "axe", priority: "must", evidenceIds: [],
    }],
    citedReferences: [],
    citedDecisions: [],
    authorityLanes: { corpusEvidence: [], machineRules: [], editorialGuidance: [] },
    provenance: { generatedAt: "2026-07-15T00:00:00Z", toolVersion: "0.2.0", sourceReferences: [], evidenceIds: ["evidence-1"] },
  };
}

function validRequest(): Record<string, unknown> {
  return {
    productContext: "A calm analytics dashboard for a fintech",
    referenceIds: [],
    constraints: [],
    motionIntents: [],
  };
}

/** A valid corpus-observation evidence entry (response-scoped id). */
function validCorpusEvidence(): Record<string, unknown> {
  return {
    id: "evidence-1",
    kind: "corpus-observation",
    basis: "visible",
    summary: "Sidebar groups issues by status with counts.",
    structuredFacts: { pattern: "dashboard", regionCount: 3 },
  };
}

/** A valid public-reference evidence entry (explicit user/public input). */
function validPublicReferenceEvidence(): Record<string, unknown> {
  return {
    id: "evidence-2",
    kind: "public-reference",
    basis: "user-supplied",
    summary: "User-supplied public design system link.",
    publicReference: "https://example.com/design-system",
    structuredFacts: {},
  };
}

// ---------------------------------------------------------------------------
// CreateUiSpecRequestSchema
// ---------------------------------------------------------------------------

describe("CreateUiSpecRequestSchema", () => {
  it("parses a minimal valid request", () => {
    expect(CreateUiSpecRequestSchema.safeParse(validRequest()).success).toBe(true);
  });

  it("rejects unknown extra field (strict)", () => {
    const r = validRequest();
    (r as Record<string, unknown>).extra = "nope";
    expect(CreateUiSpecRequestSchema.safeParse(r).success).toBe(false);
  });

  it("rejects a productContext shorter than 8 chars", () => {
    const r = validRequest();
    r.productContext = "short";
    expect(CreateUiSpecRequestSchema.safeParse(r).success).toBe(false);
  });

  it("rejects duplicate referenceIds", () => {
    const r = validRequest();
    r.referenceIds = ["a", "a"];
    expect(CreateUiSpecRequestSchema.safeParse(r).success).toBe(false);
  });

  it("rejects more than 5 referenceIds", () => {
    const r = validRequest();
    r.referenceIds = ["a", "b", "c", "d", "e", "f"];
    expect(CreateUiSpecRequestSchema.safeParse(r).success).toBe(false);
  });

  it("does NOT accept outputFormat (adapters own presentation)", () => {
    const r = validRequest();
    (r as Record<string, unknown>).outputFormat = "brief";
    expect(CreateUiSpecRequestSchema.safeParse(r).success).toBe(false);
  });

  it("designSystem accepts the same values as DesignSystemIdentitySchema (none)", () => {
    const ds = { status: "none" };
    expect(CreateUiSpecRequestSchema.safeParse({ ...validRequest(), designSystem: ds }).success).toBe(true);
    expect(DesignSystemIdentitySchema.safeParse(ds).success).toBe(true);
  });

  it("designSystem accepts the same values as DesignSystemIdentitySchema (identified)", () => {
    const ds = { status: "identified", registry: "acme-ds" };
    const viaCore = CreateUiSpecRequestSchema.safeParse({ ...validRequest(), designSystem: ds });
    const viaMcp = DesignSystemIdentitySchema.safeParse(ds);
    expect(viaCore.success).toBe(true);
    expect(viaMcp.success).toBe(true);
  });

  it("designSystem rejects the same values as DesignSystemIdentitySchema (none with registry)", () => {
    const ds = { status: "none", registry: "acme-ds" };
    expect(CreateUiSpecRequestSchema.safeParse({ ...validRequest(), designSystem: ds }).success).toBe(false);
    expect(DesignSystemIdentitySchema.safeParse(ds).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SanitizedEvidenceSchema
// ---------------------------------------------------------------------------

describe("SanitizedEvidenceSchema", () => {
  it("parses a valid corpus observation", () => {
    expect(SanitizedEvidenceSchema.safeParse(validCorpusEvidence()).success).toBe(true);
  });

  it("parses a valid public reference", () => {
    expect(SanitizedEvidenceSchema.safeParse(validPublicReferenceEvidence()).success).toBe(true);
  });

  it("parses a valid recipe-system evidence (editorial grounding for the deterministic fallback)", () => {
    // The recipe/system evidence grounds the echo-product-context designDirection
    // under editorial authority. It is operator content (the c3-fallback-v1
    // recipe), NOT a user/public reference and NOT a corpus observation.
    const e = {
      id: "evidence-1",
      kind: "recipe-system",
      basis: "aggregate",
      summary: "Deterministic c3-fallback-v1 recipe",
      structuredFacts: {},
    };
    expect(SanitizedEvidenceSchema.safeParse(e).success).toBe(true);
  });

  it("rejects a recipe-system evidence with a publicReference (the recipe is NOT a public citation)", () => {
    const e = {
      id: "evidence-1",
      kind: "recipe-system",
      basis: "aggregate",
      summary: "Deterministic c3-fallback-v1 recipe",
      structuredFacts: {},
      publicReference: "c3-fallback-v1",
    };
    expect(SanitizedEvidenceSchema.safeParse(e).success).toBe(false);
  });

  it("rejects a recipe-system evidence with a user-supplied basis (the requester supplied nothing)", () => {
    const e = {
      id: "evidence-1",
      kind: "recipe-system",
      basis: "user-supplied",
      summary: "Deterministic c3-fallback-v1 recipe",
      structuredFacts: {},
    };
    expect(SanitizedEvidenceSchema.safeParse(e).success).toBe(false);
  });

  it("accepts an evidence id matching the response-scoped regex", () => {
    const e = validCorpusEvidence();
    e.id = "evidence-42";
    expect(SanitizedEvidenceSchema.safeParse(e).success).toBe(true);
  });

  it("rejects an evidence id not matching ^evidence-[0-9]+$", () => {
    const e = validCorpusEvidence();
    e.id = "ev-1";
    expect(SanitizedEvidenceSchema.safeParse(e).success).toBe(false);
  });

  it("rejects a non-numeric evidence id", () => {
    const e = validCorpusEvidence();
    e.id = "evidence-abc";
    expect(SanitizedEvidenceSchema.safeParse(e).success).toBe(false);
  });

  it("rejects a privateCorpusId field", () => {
    const e = validCorpusEvidence();
    (e as Record<string, unknown>).privateCorpusId = "secret";
    expect(SanitizedEvidenceSchema.safeParse(e).success).toBe(false);
  });

  it("rejects a sourceUrl field", () => {
    const e = validCorpusEvidence();
    (e as Record<string, unknown>).sourceUrl = "https://private/x";
    expect(SanitizedEvidenceSchema.safeParse(e).success).toBe(false);
  });

  it("rejects a screenshot field", () => {
    const e = validCorpusEvidence();
    (e as Record<string, unknown>).screenshot = "bytes";
    expect(SanitizedEvidenceSchema.safeParse(e).success).toBe(false);
  });

  it("rejects a corpusId field", () => {
    const e = validCorpusEvidence();
    (e as Record<string, unknown>).corpusId = "c-123";
    expect(SanitizedEvidenceSchema.safeParse(e).success).toBe(false);
  });

  it("rejects publicReference on a corpus-observation", () => {
    const e = validCorpusEvidence();
    (e as Record<string, unknown>).publicReference = "https://x";
    expect(SanitizedEvidenceSchema.safeParse(e).success).toBe(false);
  });

  it("rejects unknown extra field (strict)", () => {
    const e = validCorpusEvidence();
    (e as Record<string, unknown>).extra = "nope";
    expect(SanitizedEvidenceSchema.safeParse(e).success).toBe(false);
  });

  it("rejects a free-form prose field outside structuredFacts (strict object)", () => {
    const e = validCorpusEvidence();
    (e as Record<string, unknown>).notes = "free prose";
    expect(SanitizedEvidenceSchema.safeParse(e).success).toBe(false);
  });

  it("rejects a structured pattern outside the closed corpus vocabulary", () => {
    const e = validCorpusEvidence();
    e.structuredFacts = { pattern: "private-corpus-pattern" };
    expect(SanitizedEvidenceSchema.safeParse(e).success).toBe(false);
  });

  // --- summary content screen -----------------------------------------------
  //
  // `summary` is the ONE free-text value a transport adapter PUBLISHES from a
  // sanitized row (`evidence[].summary`). It travels BESIDE the envelope, so the
  // envelope's containsPrivateMarker sweep never sees it, and the create_ui_spec
  // leaf gate classifies that position as free text (returns immediately). The
  // screen therefore has to live here, at construction — otherwise a poisoned
  // summary is published verbatim.

  it("rejects a summary carrying a private corpus id marker", () => {
    const e = validCorpusEvidence();
    e.summary = "dashboard reference private-corpus-id-7";
    expect(SanitizedEvidenceSchema.safeParse(e).success).toBe(false);
  });

  it("rejects a summary carrying a private image path", () => {
    const e = validCorpusEvidence();
    e.summary = "dashboard reference images-private/secret.png";
    expect(SanitizedEvidenceSchema.safeParse(e).success).toBe(false);
  });

  it("rejects a summary carrying a source URL", () => {
    const e = validCorpusEvidence();
    e.summary = "dashboard reference https://private.example.com/secret";
    expect(SanitizedEvidenceSchema.safeParse(e).success).toBe(false);
  });

  it("rejects a summary carrying a filesystem path or a corpus-prefixed identifier", () => {
    for (const summary of [
      "dashboard reference /corpus/private/entry.json",
      "dashboard reference corpus-entry-4711",
    ]) {
      const e = validCorpusEvidence();
      e.summary = summary;
      expect(SanitizedEvidenceSchema.safeParse(e).success, summary).toBe(false);
    }
  });

  it("rejects a summary carrying a RELATIVE path (no leading slash, no marker word)", () => {
    // Pins PATH_OR_URL_PATTERN's PATH role independently of its corpus-marker
    // role. Round-2 review of Task 2 found that PATH_OR_URL_PATTERN now serves
    // two concerns, and that dropping its `[/\\]` character class left all the
    // other summary cases green: every one of them is caught first by
    // containsPrivateMarker ("images-private/"), by `://`, by the literal
    // "private" alternative, or by "corpus-". Only `corpus-entry-4711` pinned a
    // single alternative, and nothing pinned `[/\\]`. These two values contain a
    // path separator and NOTHING else the pattern or the marker list matches, so
    // they fail if and only if the character class is present.
    for (const summary of [
      "dashboard reference assets/hero.png",
      "dashboard reference //cdn.example.com/x.png",
    ]) {
      const e = validCorpusEvidence();
      e.summary = summary;
      expect(SanitizedEvidenceSchema.safeParse(e).success, summary).toBe(false);
    }
  });

  it("the summary rejection message never echoes the offending value", () => {
    const e = validCorpusEvidence();
    e.summary = "dashboard reference images-private/secret.png";
    const parsed = SanitizedEvidenceSchema.safeParse(e);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    for (const issue of parsed.error.issues) {
      expect(issue.message).not.toContain("images-private/secret.png");
      expect(issue.message).not.toContain("secret.png");
    }
  });

  it("still accepts every summary the production templates emit", () => {
    // The three real producer templates (safe-aggregator.buildCorpusObservationSummary,
    // the frozen recipe row, and the fixed explicit-reference string). The screen
    // must not narrow the production path.
    for (const summary of [
      "dashboard reference with 3 regions",
      "landing-page reference",
      "Corpus observation reference",
      "Deterministic c3-fallback-v1 recipe",
      "User-supplied public reference.",
    ]) {
      const e = validCorpusEvidence();
      e.summary = summary;
      expect(SanitizedEvidenceSchema.safeParse(e).success, summary).toBe(true);
    }
  });

  it("rejects a publicReference carrying a private corpus marker", () => {
    // A private marker is never a legitimate public reference value, whatever
    // shape the field takes. (A public URL IS legitimate at this layer — see the
    // "parses a valid public reference" case above; the PUBLISHED channel is
    // narrowed to `ref-<sha256>` by projectSanitizedEvidenceToMcpEvidence.)
    const e = validPublicReferenceEvidence();
    e.publicReference = "corpus/images-private/secret.png";
    expect(SanitizedEvidenceSchema.safeParse(e).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CreateUiSpecCandidateSchema — 15-variant discriminated union
// ---------------------------------------------------------------------------

describe("CreateUiSpecCandidateSchema", () => {
  it("parses an empty candidate (no decisions)", () => {
    expect(
      CreateUiSpecCandidateSchema.safeParse({
        candidateVersion: "1.0",
        decisions: [],
      }).success,
    ).toBe(true);
  });

  it("rejects unknown extra field (strict) at the candidate level", () => {
    expect(
      CreateUiSpecCandidateSchema.safeParse({
        candidateVersion: "1.0",
        decisions: [],
        extra: "nope",
      }).success,
    ).toBe(false);
  });

  // Each of the 15 variants parses a valid payload.
  const variantFixtures: Array<{ field: string; value: unknown }> = [
    { field: "designDirection", value: "Clear hierarchy with calm spacing." },
    { field: "rejectedDefaults", value: "Avoid generic three-column card grids." },
    { field: "layoutRegions", value: [{ name: "header", type: "banner", components: [], responsive: [] }] },
    { field: "responsiveBehavior", value: ["stack-below-720", "sidebar-collapses"] },
    { field: "componentInventory", value: [{ name: "Card", pattern: "card" }] },
    { field: "colorTokens", value: [{ name: "primary", value: "#3b82f6", rationale: "Brand accent." }] },
    { field: "typographyTokens", value: [{ name: "heading", value: "Inter", rationale: "Readable." }] },
    { field: "interactions", value: [{ category: "hover", statement: "Cards lift on hover." }] },
    { field: "motionGuidance", value: [{ category: "transition", statement: "Fade sidebar on toggle." }] },
    { field: "accessibilityConstraints", value: [{ category: "contrast", statement: "Meet 4.5:1 contrast." }] },
    { field: "contentVoiceGuidance", value: "Direct, calm, technical." },
    { field: "techniques", value: [{ text: "Sticky sidebar with counts." }] },
    { field: "antiPatterns", value: [{ text: "Avoid icon-only claims." }] },
    { field: "frameworkNotes", value: "Use vanilla CSS, no framework." },
    { field: "acceptanceCriteria", value: ["Contrast meets 4.5:1"] },
  ];

  for (const { field, value } of variantFixtures) {
    it(`parses a valid ${field} decision`, () => {
      const result = CreateUiSpecCandidateSchema.safeParse({
        candidateVersion: "1.0",
        decisions: [{
          field,
          id: `${field}-1`,
          value,
          rationale: "Supported by the visible evidence.",
          evidenceIds: ["evidence-1"],
        }],
      });
      expect(result.success).toBe(true);
    });
  }

  // Each variant rejects a malformed / out-of-limit value.
  it("rejects designDirection value over 2000 chars", () => {
    const result = CreateUiSpecCandidateSchema.safeParse({
      candidateVersion: "1.0",
      decisions: [{
        field: "designDirection", id: "d-1", rationale: "r.", evidenceIds: [],
        value: "x".repeat(2001),
      }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects layoutRegions with more than 12 rows", () => {
    const rows = Array.from({ length: 13 }, (_, i) => ({
      name: `r${i}`, type: "banner", components: [], responsive: [],
    }));
    const result = CreateUiSpecCandidateSchema.safeParse({
      candidateVersion: "1.0",
      decisions: [{
        field: "layoutRegions", id: "d-1", rationale: "r.", evidenceIds: [],
        value: rows,
      }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects colorTokens row with a scalar over 120 chars", () => {
    const result = CreateUiSpecCandidateSchema.safeParse({
      candidateVersion: "1.0",
      decisions: [{
        field: "colorTokens", id: "d-1", rationale: "r.", evidenceIds: [],
        value: [{ name: "primary", value: "x".repeat(121), rationale: "r." }],
      }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects interactions row missing the required category", () => {
    const result = CreateUiSpecCandidateSchema.safeParse({
      candidateVersion: "1.0",
      decisions: [{
        field: "interactions", id: "d-1", rationale: "r.", evidenceIds: [],
        value: [{ statement: "Cards lift." }],
      }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a decision with an empty id", () => {
    const result = CreateUiSpecCandidateSchema.safeParse({
      candidateVersion: "1.0",
      decisions: [{
        field: "designDirection", id: "", value: "x", rationale: "r.", evidenceIds: [],
      }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a decision with more than 8 evidenceIds", () => {
    const result = CreateUiSpecCandidateSchema.safeParse({
      candidateVersion: "1.0",
      decisions: [{
        field: "designDirection", id: "d-1", value: "x", rationale: "r.",
        evidenceIds: Array.from({ length: 9 }, (_, i) => `evidence-${i + 1}`),
      }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a candidate with more than 32 decisions", () => {
    const decisions = Array.from({ length: 33 }, (_, i) => ({
      field: "designDirection", id: `d-${i}`, value: "x", rationale: "r.", evidenceIds: [],
    }));
    const result = CreateUiSpecCandidateSchema.safeParse({
      candidateVersion: "1.0",
      decisions,
    });
    expect(result.success).toBe(false);
  });

  // Boundary-inclusive: the max() limits are ACCEPTED at the exact boundary.
  // Mirrors the rejection tests above (which assert the exclusive side).
  it("accepts exactly 32 decisions (boundary-inclusive)", () => {
    const decisions = Array.from({ length: 32 }, (_, i) => ({
      field: "designDirection", id: `d-${i}`, value: "x", rationale: "r.", evidenceIds: [],
    }));
    const result = CreateUiSpecCandidateSchema.safeParse({
      candidateVersion: "1.0",
      decisions,
    });
    expect(result.success).toBe(true);
  });

  it("accepts exactly 8 evidenceIds on a decision (boundary-inclusive)", () => {
    const result = CreateUiSpecCandidateSchema.safeParse({
      candidateVersion: "1.0",
      decisions: [{
        field: "designDirection", id: "d-1", value: "x", rationale: "r.",
        evidenceIds: Array.from({ length: 8 }, (_, i) => `evidence-${i + 1}`),
      }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts exactly 2000-char value on a bounded-text variant (boundary-inclusive)", () => {
    // BoundedTextValue is the value shape for designDirection (max 2_000).
    const result = CreateUiSpecCandidateSchema.safeParse({
      candidateVersion: "1.0",
      decisions: [{
        field: "designDirection", id: "d-1", rationale: "r.", evidenceIds: [],
        value: "x".repeat(2_000),
      }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts exactly 1000-char rationale (boundary-inclusive)", () => {
    // DecisionRationale is shared by every variant (max 1_000).
    const result = CreateUiSpecCandidateSchema.safeParse({
      candidateVersion: "1.0",
      decisions: [{
        field: "designDirection", id: "d-1", value: "x", evidenceIds: [],
        rationale: "r".repeat(1_000),
      }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects duplicate decision ids (candidate-level superRefine)", () => {
    const result = CreateUiSpecCandidateSchema.safeParse({
      candidateVersion: "1.0",
      decisions: [
        { field: "designDirection", id: "dup", value: "x", rationale: "r.", evidenceIds: [] },
        { field: "rejectedDefaults", id: "dup", value: "y", rationale: "r.", evidenceIds: [] },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects structural Markdown in a value", () => {
    const result = CreateUiSpecCandidateSchema.safeParse({
      candidateVersion: "1.0",
      decisions: [{
        field: "designDirection", id: "d-1", rationale: "r.", evidenceIds: [],
        value: "## Heading\n\nBody",
      }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a private-path marker in a value", () => {
    const result = CreateUiSpecCandidateSchema.safeParse({
      candidateVersion: "1.0",
      decisions: [{
        field: "frameworkNotes", id: "d-1", rationale: "r.", evidenceIds: [],
        value: "see .c2-private/x for details",
      }],
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseCreateUiSpecCandidate — evidence-aware parser
// ---------------------------------------------------------------------------

describe("parseCreateUiSpecCandidate", () => {
  it("rejects a candidate with an unbound evidence ID", () => {
    // Per the Task 1 plan, CreateUiSpecCandidateSchema is STRUCTURAL — it does
    // not know about evidence membership. Membership is enforced by the
    // evidence-aware parser parseCreateUiSpecCandidate. This verbatim test case
    // (name + payload preserved from the plan) therefore exercises the PARSER,
    // which throws on the unbound `evidence-99`. Structurally the candidate is
    // valid, so CreateUiSpecCandidateSchema.safeParse returns true (asserted
    // first), and only the parser rejects it.
    const candidate = {
      candidateVersion: "1.0",
      decisions: [{
        field: "designDirection",
        id: "direction-1",
        value: "Clear hierarchy",
        rationale: "Supported by the visible evidence.",
        evidenceIds: ["evidence-99"],
      }],
    };
    expect(CreateUiSpecCandidateSchema.safeParse(candidate).success).toBe(true);
    expect(() => parseCreateUiSpecCandidate(candidate, new Set())).toThrow();
  });

  it("throws when a decision references an evidenceId not in the allowed set", () => {
    const raw = {
      candidateVersion: "1.0",
      decisions: [{
        field: "designDirection",
        id: "direction-1",
        value: "Clear hierarchy",
        rationale: "Supported by the visible evidence.",
        evidenceIds: ["evidence-99"],
      }],
    };
    // Structurally this candidate is valid (evidence ids are unconstrained at
    // the schema level), so safeParse passes. The evidence-aware parser must
    // reject it.
    expect(CreateUiSpecCandidateSchema.safeParse(raw).success).toBe(true);
    expect(() =>
      parseCreateUiSpecCandidate(raw, new Set(["evidence-1"])),
    ).toThrow();
  });

  it("accepts a candidate whose evidence ids are all in the allowed set", () => {
    const raw = {
      candidateVersion: "1.0",
      decisions: [{
        field: "designDirection",
        id: "direction-1",
        value: "Clear hierarchy",
        rationale: "Supported by the visible evidence.",
        evidenceIds: ["evidence-1", "evidence-2"],
      }],
    };
    const parsed = parseCreateUiSpecCandidate(raw, new Set(["evidence-1", "evidence-2"]));
    expect(parsed.candidateVersion).toBe("1.0");
    expect(parsed.decisions).toHaveLength(1);
  });

  it("throws a bounded safe error for a structurally invalid candidate", () => {
    const raw = {
      candidateVersion: "2.0", // wrong version
      decisions: [],
    };
    expect(() => parseCreateUiSpecCandidate(raw, new Set())).toThrow();
  });

  it("throws a bounded safe error for duplicate decision ids", () => {
    const raw = {
      candidateVersion: "1.0",
      decisions: [
        { field: "designDirection", id: "dup", value: "x", rationale: "r.", evidenceIds: [] },
        { field: "rejectedDefaults", id: "dup", value: "y", rationale: "r.", evidenceIds: [] },
      ],
    };
    expect(() => parseCreateUiSpecCandidate(raw, new Set())).toThrow();
  });
});

// ---------------------------------------------------------------------------
// CreateUiSpecErrorSchema — discriminated union with code↔retryable binding
// ---------------------------------------------------------------------------

describe("CreateUiSpecErrorSchema", () => {
  it("parses a valid INVALID_INPUT error (retryable false)", () => {
    const result = CreateUiSpecErrorSchema.safeParse({
      code: "INVALID_INPUT",
      message: "The request was malformed.",
      retryable: false,
    });
    expect(result.success).toBe(true);
  });

  it("parses a valid RETRIEVAL_UNAVAILABLE error (retryable true)", () => {
    const result = CreateUiSpecErrorSchema.safeParse({
      code: "RETRIEVAL_UNAVAILABLE",
      message: "The retrieval index is temporarily unavailable.",
      retryable: true,
    });
    expect(result.success).toBe(true);
  });

  it("rejects INVALID_INPUT with retryable true (literal binding)", () => {
    expect(CreateUiSpecErrorSchema.safeParse({
      code: "INVALID_INPUT",
      message: "malformed.",
      retryable: true,
    }).success).toBe(false);
  });

  it("rejects RETRIEVAL_UNAVAILABLE with retryable false (literal binding)", () => {
    expect(CreateUiSpecErrorSchema.safeParse({
      code: "RETRIEVAL_UNAVAILABLE",
      message: "unavailable.",
      retryable: false,
    }).success).toBe(false);
  });

  it("rejects a SafeErrorMessage containing a url-like pattern", () => {
    expect(CreateUiSpecErrorSchema.safeParse({
      code: "INVALID_INPUT",
      message: "see https://example.com for details",
      retryable: false,
    }).success).toBe(false);
  });

  it("rejects a SafeErrorMessage containing a path-like pattern", () => {
    expect(CreateUiSpecErrorSchema.safeParse({
      code: "INVALID_INPUT",
      message: "see src/server.ts line 42",
      retryable: false,
    }).success).toBe(false);
  });

  it("rejects a SafeErrorMessage over 500 chars", () => {
    expect(CreateUiSpecErrorSchema.safeParse({
      code: "INVALID_INPUT",
      message: "x".repeat(501),
      retryable: false,
    }).success).toBe(false);
  });

  it("rejects an unknown error code", () => {
    expect(CreateUiSpecErrorSchema.safeParse({
      code: "NOT_FOUND",
      message: "missing.",
      retryable: false,
    }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sha256Canonical + buildSemanticSpecInput + buildArtifactIdentityInput
// ---------------------------------------------------------------------------

describe("sha256Canonical", () => {
  it("hashes canonical JSON of a value (key order independent)", () => {
    const a = sha256Canonical({ b: 1, a: 2 });
    const b = sha256Canonical({ a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches the composition of the two existing helpers", () => {
    const value = { x: [1, 2], y: "z" };
    const expected = sha256Hex(Buffer.from(canonicalJsonStringify(value), "utf-8"));
    expect(sha256Canonical(value)).toBe(expected);
  });
});

describe("buildSemanticSpecInput", () => {
  it("replaces provenance.generatedAt with the sentinel and leaves everything else equal", () => {
    const spec = UiSpec.parse(validUiSpec()) as import("./tool-contracts.js").UiSpecT;
    const semantic = buildSemanticSpecInput(spec);
    expect(semantic.provenance.generatedAt).toBe("1970-01-01T00:00:00.000Z");
    // All other fields are deep-equal to the source spec.
    const { generatedAt: _ignored, ...restSource } = spec.provenance;
    void _ignored;
    const { generatedAt: _ignored2, ...restSemantic } = semantic.provenance;
    void _ignored2;
    expect(restSemantic).toEqual(restSource);
  });

  it("is stable across repeated calls and ignores the original timestamp", () => {
    const specA = UiSpec.parse(validUiSpec()) as import("./tool-contracts.js").UiSpecT;
    const specB = UiSpec.parse({
      ...validUiSpec(),
      provenance: {
        ...((validUiSpec().provenance as Record<string, unknown>)),
        generatedAt: "2030-01-01T00:00:00.000Z",
      },
    }) as import("./tool-contracts.js").UiSpecT;
    expect(canonicalJsonStringify(buildSemanticSpecInput(specA)))
      .toBe(canonicalJsonStringify(buildSemanticSpecInput(specB)));
  });

  it("does not mutate the input spec", () => {
    const spec = UiSpec.parse(validUiSpec()) as import("./tool-contracts.js").UiSpecT;
    const original = spec.provenance.generatedAt;
    buildSemanticSpecInput(spec);
    expect(spec.provenance.generatedAt).toBe(original);
  });
});

describe("buildArtifactIdentityInput", () => {
  it("returns exactly the canonical identity object shape", () => {
    const identity = buildArtifactIdentityInput({
      producerVersion: "1.2.3",
      assemblyRulesSha256: "a".repeat(64),
      semanticSpecSha256: "b".repeat(64),
      target: "neutral-web",
      motionIntents: [],
    });
    expect(identity).toEqual({
      artifactVersion: "1.0",
      producerVersion: "1.2.3",
      assemblyRulesSha256: "a".repeat(64),
      semanticSpecSha256: "b".repeat(64),
      handoffInputs: { target: "neutral-web", motionIntents: [] },
      renderingFormatVersion: "web-1.0",
    });
  });

  it("rejects a caller passing extra fields at the type level (exact-type param)", () => {
    // This is a compile-time contract. If the param were a wide Record, the
    // caller could smuggle in a generatedAt/diagnostic. The @ts-expect-error
    // below asserts the helper's param is exact.
    //
    // @ts-expect-error — generatedAt is not part of the identity input.
    buildArtifactIdentityInput({
      producerVersion: "1.2.3",
      assemblyRulesSha256: "a".repeat(64),
      semanticSpecSha256: "b".repeat(64),
      target: "neutral-web",
      motionIntents: [],
      generatedAt: "2030-01-01T00:00:00.000Z",
    });
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ArtifactMetadataSchema + DesignArtifactEnvelopeSchema
// ---------------------------------------------------------------------------

describe("ArtifactMetadataSchema", () => {
  it("parses a valid metadata block", () => {
    const result = ArtifactMetadataSchema.safeParse({
      producerVersion: "1.2.3",
      assemblyRulesSha256: "a".repeat(64),
      specSha256: "b".repeat(64),
      semanticSpecSha256: "c".repeat(64),
      designMarkdownSha256: "d".repeat(64),
      designJsonSha256: "e".repeat(64),
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid sha256", () => {
    const result = ArtifactMetadataSchema.safeParse({
      producerVersion: "1.2.3",
      assemblyRulesSha256: "not-a-hash",
      specSha256: "b".repeat(64),
      semanticSpecSha256: "c".repeat(64),
      designMarkdownSha256: "d".repeat(64),
      designJsonSha256: "e".repeat(64),
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown extra field (strict)", () => {
    const result = ArtifactMetadataSchema.safeParse({
      producerVersion: "1.2.3",
      assemblyRulesSha256: "a".repeat(64),
      specSha256: "b".repeat(64),
      semanticSpecSha256: "c".repeat(64),
      designMarkdownSha256: "d".repeat(64),
      designJsonSha256: "e".repeat(64),
      extra: "nope",
    });
    expect(result.success).toBe(false);
  });
});

/**
 * Build a fully valid envelope (renderings + hashes + the REAL artifactId
 * computed from the canonical identity object, exactly as the producer does).
 * The target id resolves the canonical profile from the shared
 * CANONICAL_WEB_TARGET_PROFILES registry (the same registry the producer and
 * parseDesignArtifactEnvelope consult), defaulting to neutral-web.
 *
 * `assemblyRulesSha256` uses the shared {@link RECIPE_SHA256} constant (the
 * single source the parser verifies against), and `artifactId` is recomputed
 * via `buildArtifactIdentityInput` + `sha256Canonical` — so this fixture is a
 * known-good state the tamper tests can mutate from.
 */
function buildValidEnvelope(targetId: keyof typeof CANONICAL_WEB_TARGET_PROFILES = "neutral-web"): Record<string, unknown> {
  const spec = UiSpec.parse(validUiSpec()) as import("./tool-contracts.js").UiSpecT;
  const target = CANONICAL_WEB_TARGET_PROFILES[targetId];
  const handoff = parseDesignHandoff({
    spec,
    target,
    motionIntents: [],
    generatedAt: "2026-07-15T00:00:00Z",
  });
  const designMarkdown = renderDesignHandoffMarkdown(handoff);
  const designJson = renderDesignHandoffJson(handoff);
  const semantic = buildSemanticSpecInput(spec);
  const specSha = sha256Hex(Buffer.from(canonicalJsonStringify(spec), "utf-8"));
  const semanticSha = sha256Canonical(semantic);
  const motionIntents: never[] = [];
  // Recompute the canonical identity the EXACT way the producer does
  // (create-ui-spec.ts buildEnvelope). The stored artifactId MUST match this.
  const artifactId = `uispec-${sha256Canonical(
    buildArtifactIdentityInput({
      producerVersion: "1.2.3",
      assemblyRulesSha256: RECIPE_SHA256,
      semanticSpecSha256: semanticSha,
      target: targetId,
      motionIntents,
    }),
  )}`;
  return {
    artifactVersion: "1.0",
    artifactId,
    generatedAt: "2026-07-15T00:00:00Z",
    producerVersion: "1.2.3",
    assemblyRulesSha256: RECIPE_SHA256,
    spec,
    handoff: { target: targetId, motionIntents },
    designMarkdown,
    designJson,
    specSha256: specSha,
    designMarkdownSha256: sha256Hex(Buffer.from(designMarkdown, "utf-8")),
    designJsonSha256: sha256Hex(Buffer.from(designJson, "utf-8")),
    semanticSpecSha256: semanticSha,
    publicEvidenceIds: ["evidence-1"],
    retrieval: {
      mode: "structured-fallback",
      modality: "metadata",
      resultCount: 0,
      fallbackUsed: true,
      attemptedCount: 1,
      fallbackReason: "missing-index",
      attemptedModes: ["keyword"],
    },
    warnings: [{ code: "sparseCoverage", message: "Sparse evidence; fallback used." }],
  };
}

describe("DesignArtifactEnvelopeSchema", () => {
  it("parses a valid envelope", () => {
    expect(DesignArtifactEnvelopeSchema.safeParse(buildValidEnvelope()).success).toBe(true);
  });

  it("rejects unknown extra field (strict)", () => {
    const env = buildValidEnvelope();
    (env as Record<string, unknown>).extra = "nope";
    expect(DesignArtifactEnvelopeSchema.safeParse(env).success).toBe(false);
  });

  it("rejects an envelope with no publicEvidenceIds (min 1)", () => {
    const env = buildValidEnvelope();
    env.publicEvidenceIds = [];
    expect(DesignArtifactEnvelopeSchema.safeParse(env).success).toBe(false);
  });

  it("rejects a private marker anywhere in the serialized envelope", () => {
    const env = buildValidEnvelope();
    env.designMarkdown = "private-corpus-id leak";
    // Even if we re-hash to match, the private-marker check must fire.
    env.designMarkdownSha256 = sha256Hex(Buffer.from(env.designMarkdown as string, "utf-8"));
    expect(DesignArtifactEnvelopeSchema.safeParse(env).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseDesignArtifactEnvelope — re-render verification
// ---------------------------------------------------------------------------

describe("parseDesignArtifactEnvelope", () => {
  it("parses a valid envelope and returns it", () => {
    const env = buildValidEnvelope();
    const parsed = parseDesignArtifactEnvelope(env);
    // The parser now VERIFIES artifactId (recomputed from the canonical identity)
    // and assemblyRulesSha256 (must equal the frozen RECIPE_SHA256). The fixture
    // carries the real recomputed id, so it round-trips unchanged.
    expect(parsed.artifactId).toBe(env.artifactId);
    expect(parsed.artifactId.startsWith("uispec-")).toBe(true);
    expect(parsed.assemblyRulesSha256).toBe(RECIPE_SHA256);
    expect(parsed.spec.specVersion).toBe("1.0");
  });

  it("rejects a tampered artifactId", () => {
    // Start from a known-good envelope (real artifactId + RECIPE_SHA256), then
    // swap in a bogus artifactId while leaving every stored hash + the stored
    // assemblyRulesSha256 correct. Previously this self-consistent forgery
    // passed the parser; the parser now recomputes the canonical identity and
    // demands equality.
    const env = buildValidEnvelope();
    env.artifactId = `uispec-${"d".repeat(64)}`;
    expect(() => parseDesignArtifactEnvelope(env)).toThrow();
  });

  it("rejects public evidence ids that are not the spec provenance ids", () => {
    const env = buildValidEnvelope();
    env.publicEvidenceIds = ["evidence-2"];
    expect(DesignArtifactEnvelopeSchema.safeParse(env).success).toBe(false);
  });

  it("rejects a tampered assemblyRulesSha256", () => {
    // Start from a known-good envelope, then swap in a different 64-hex
    // assemblyRulesSha256 (and recompute nothing). The parser now demands the
    // frozen RECIPE_SHA256 — this also implicitly catches a stale recipe drift
    // (the artifact claims an assembly-rules hash the frozen recipe no longer
    // matches).
    const env = buildValidEnvelope();
    env.assemblyRulesSha256 = "b".repeat(64);
    expect(() => parseDesignArtifactEnvelope(env)).toThrow();
  });

  it("re-renders + re-verifies an astro-react envelope end-to-end (no throw)", () => {
    // The envelope stores only handoff.target === "astro-react"; the parser must
    // reconstruct the canonical astro-react profile from the shared registry and
    // byte-reproduce the renderings. Previously this threw (Task 1 limitation).
    const env = buildValidEnvelope("astro-react");
    const parsed = parseDesignArtifactEnvelope(env);
    expect(parsed.handoff.target).toBe("astro-react");
    expect(parsed.spec.specVersion).toBe("1.0");
  });

  it("re-renders + re-verifies an astro-vue envelope end-to-end (no throw)", () => {
    const env = buildValidEnvelope("astro-vue");
    const parsed = parseDesignArtifactEnvelope(env);
    expect(parsed.handoff.target).toBe("astro-vue");
    expect(parsed.spec.specVersion).toBe("1.0");
  });

  it("rejects a tampered designMarkdown even when its stored hash matches the tampered bytes", () => {
    const env = buildValidEnvelope();
    env.designMarkdown = "# TAMPERED\n\nDifferent content entirely.";
    env.designMarkdownSha256 = sha256Hex(Buffer.from(env.designMarkdown as string, "utf-8"));
    expect(() => parseDesignArtifactEnvelope(env)).toThrow();
  });

  it("rejects a tampered designJson", () => {
    const env = buildValidEnvelope();
    env.designJson = '{"tampered":true}\n';
    env.designJsonSha256 = sha256Hex(Buffer.from(env.designJson as string, "utf-8"));
    expect(() => parseDesignArtifactEnvelope(env)).toThrow();
  });

  it("a timestamp-only rerun does NOT change semantic identity", () => {
    const envA = buildValidEnvelope();
    const envB = buildValidEnvelope();
    // Re-render B with a different generatedAt timestamp and recompute the
    // affected hashes. The semanticSpecSha256 must remain identical.
    const spec = UiSpec.parse(validUiSpec()) as import("./tool-contracts.js").UiSpecT;
    const handoff = parseDesignHandoff({
      spec,
      target: {
        id: "neutral-web", platform: "web", siteFramework: "none", runtime: "none",
        styling: "vanilla-css", componentSource: "native-html", motion: "css",
        islandStrategy: null,
      },
      motionIntents: [],
      generatedAt: "2030-12-31T00:00:00.000Z",
    });
    const md = renderDesignHandoffMarkdown(handoff);
    const js = renderDesignHandoffJson(handoff);
    envB.generatedAt = "2030-12-31T00:00:00.000Z";
    envB.designMarkdown = md;
    envB.designJson = js;
    envB.designMarkdownSha256 = sha256Hex(Buffer.from(md, "utf-8"));
    envB.designJsonSha256 = sha256Hex(Buffer.from(js, "utf-8"));
    expect(envB.semanticSpecSha256).toBe(envA.semanticSpecSha256);
    expect(() => parseDesignArtifactEnvelope(envB)).not.toThrow();
  });

  it("moves the DESIGN.json and spec hashes with generation time, but NOT the DESIGN.md hash", () => {
    // The three byte digests are NOT interchangeable, and the difference is
    // user-facing: the playground renders all three side by side, so its copy
    // has to say which of them an operator can compare across two runs.
    // `renderDesignHandoffMarkdown` writes no timestamp; `renderDesignHandoffJson`
    // does; and `specSha256` covers `spec.provenance.generatedAt`. Without this
    // test the only statement of that fact is prose in a React component, and a
    // renderer change could silently make that prose false.
    const spec = UiSpec.parse(validUiSpec()) as import("./tool-contracts.js").UiSpecT;
    const target = {
      id: "neutral-web", platform: "web", siteFramework: "none", runtime: "none",
      styling: "vanilla-css", componentSource: "native-html", motion: "css",
      islandStrategy: null,
    } as const;
    const renderAt = (generatedAt: string) => {
      const handoff = parseDesignHandoff({ spec, target, motionIntents: [], generatedAt });
      return {
        markdown: sha256Hex(Buffer.from(renderDesignHandoffMarkdown(handoff), "utf-8")),
        json: sha256Hex(Buffer.from(renderDesignHandoffJson(handoff), "utf-8")),
      };
    };
    const early = renderAt("2026-08-01T00:00:00.000Z");
    const late = renderAt("2030-12-31T23:59:59.000Z");

    // Stable: comparable across runs, which is what makes it worth showing.
    expect(late.markdown).toBe(early.markdown);
    // Volatile: carries the timestamp, so a mismatch across runs proves nothing.
    expect(late.json).not.toBe(early.json);

    // NOTE: `specSha256` is deliberately NOT asserted here. Hashing a locally
    // reconstructed spec with a timestamp this test injected itself would prove
    // only that sha256 is a function — if the producer ever stopped putting
    // `generatedAt` in `spec`, such an assertion would still pass while the UI
    // copy became false. The spec digest is covered end-to-end from two real
    // producer envelopes in create-ui-spec.test.ts.
  });

  it("rejects a private marker in the serialized envelope", () => {
    const env = buildValidEnvelope();
    env.producerVersion = "private-corpus-id-1.2.3";
    expect(() => parseDesignArtifactEnvelope(env)).toThrow();
  });
});
