import { describe, expect, it } from "vitest";
import {
  RETAG_GOLD_FIELDS,
  RetagGoldSelectionSchema,
  RetagGoldSubmissionSchema,
  toGoldLabels,
  validateRetagGoldPair,
  validateRetagGoldSubmission,
  type RetagGoldSelection,
  type RetagGoldSubmission,
} from "./retag-gold.js";

const entries = [
  { entryId: "one", imageSha256: "a".repeat(64), imagePath: "images-private/one.png", cohort: "reproducible", stratum: "dashboard" },
  { entryId: "two", imageSha256: "b".repeat(64), imagePath: "images-private/two.png", cohort: "challenge", stratum: "empty-state" },
] as const;

const selection = {
  schemaVersion: "1.0",
  artifactType: "retag-gold-selection",
  artifactId: "retag-gold-selection-v1",
  selectionArtifactId: "c2-label-integrity-selection-v1",
  selectionSha256: "c".repeat(64),
  fields: [...RETAG_GOLD_FIELDS],
  entries,
} satisfies RetagGoldSelection;

function submission(overrides: Partial<RetagGoldSubmission> = {}): RetagGoldSubmission {
  return {
    schemaVersion: "1.0",
    artifactType: "retag-gold-submission",
    artifactId: "retag-gold-submission-alice-v1",
    selectionArtifactId: selection.selectionArtifactId,
    selectionSha256: selection.selectionSha256,
    submissionVersion: 1,
    actorId: "alice",
    actorKind: "human",
    reviewerRole: "gold",
    sealedAt: "2026-08-09T12:00:00.000Z",
    labels: entries.map((entry) => ({
      entryId: entry.entryId,
      imageSha256: entry.imageSha256,
      fields: {
        components: { status: "present", value: ["chart"], evidenceSource: "image" },
        domainTags: { status: "oov", oov: ["observability"], evidenceSource: "image", note: "The visible product context is not represented in the closed vocabulary." },
        colorScheme: { status: "present", value: "light", evidenceSource: "image" },
        mood: { status: "abstain", evidenceSource: "image", note: "No controlled mood vocabulary is frozen yet." },
        "visual.typePairing": { status: "abstain", evidenceSource: "image", note: "Screenshot does not identify font family." },
      },
    })),
    ...overrides,
  };
}

describe("retag gold contract", () => {
  it("accepts explicit present, abstain, and OOV labels", () => {
    const parsed = RetagGoldSubmissionSchema.parse(submission());
    expect(parsed.labels).toHaveLength(2);
    expect(parsed.labels[0]?.fields.domainTags.status).toBe("oov");
  });

  it("rejects closed-vocabulary values that are not canonical", () => {
    const candidate = submission();
    candidate.labels[0]!.fields.components = { status: "present", value: ["observability"], evidenceSource: "image" };
    expect(() => RetagGoldSubmissionSchema.parse(candidate)).toThrow(/components/);
  });

  it("requires DOM evidence for a type pairing", () => {
    const candidate = submission();
    candidate.labels[0]!.fields["visual.typePairing"] = {
      status: "present",
      value: { display: "Inter", body: "Inter", notes: "same family" },
      evidenceSource: "image",
    };
    expect(() => RetagGoldSubmissionSchema.parse(candidate)).toThrow(/DOM/);
  });

  it("requires a reason when a reviewer abstains or records OOV", () => {
    const candidate = submission();
    candidate.labels[0]!.fields.mood = { status: "abstain", evidenceSource: "image" };
    expect(() => RetagGoldSubmissionSchema.parse(candidate)).toThrow(/note/);
  });

  it("binds every submission row to the frozen selection and image hash", () => {
    expect(() => validateRetagGoldSubmission(submission(), selection)).not.toThrow();
    const stale = submission();
    stale.labels[0]!.imageSha256 = "d".repeat(64);
    expect(() => validateRetagGoldSubmission(stale, selection)).toThrow(/image hash/);
    const unknown = submission();
    unknown.labels[0]!.entryId = "not-in-selection";
    expect(() => validateRetagGoldSubmission(unknown, selection)).toThrow(/entry IDs/);
  });

  it("converts labels to the existing evaluator without losing OOV status", () => {
    const labels = toGoldLabels(submission());
    expect(labels).toHaveLength(2);
    expect(labels[0]?.fields.domainTags).toMatchObject({ status: "oov", value: ["observability"] });
  });

  it("requires two different actors with complementary reviewer roles", () => {
    const gold = submission();
    const qa = submission({ actorId: "bob", reviewerRole: "qa", artifactId: "retag-gold-submission-bob-v1" });
    expect(() => validateRetagGoldPair(gold, qa, selection)).not.toThrow();
    expect(() => validateRetagGoldPair(gold, submission({ actorId: "alice-2", reviewerRole: "gold" }), selection)).toThrow(/one gold and one qa/);
    expect(() => validateRetagGoldPair(gold, submission({ actorId: "alice", reviewerRole: "qa" }), selection)).toThrow(/independent actors/);
  });

  it("rejects a selection that omits one of the required fields", () => {
    const candidate = { ...selection, fields: ["components"] };
    expect(() => RetagGoldSelectionSchema.parse(candidate)).toThrow(/fields/);
  });
});
