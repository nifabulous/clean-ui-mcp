import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRetagGoldPacket, RETAG_GOLD_FIELDS } from "../retag-gold.js";
import { buildGoldSelection, validateSubmissionFile } from "./retag-gold.js";

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "retag-gold-"));
  const corpusRoot = join(root, "corpus");
  mkdirSync(join(corpusRoot, "images-private"), { recursive: true });
  const image = Buffer.from("fixture-image");
  writeFileSync(join(corpusRoot, "images-private", "one.png"), image);
  writeFileSync(join(corpusRoot, "entries.json"), JSON.stringify({ entries: [{ id: "one", image: { path: "images-private/one.png" } }] }));
  const c2 = {
    artifactId: "c2-label-integrity-selection-v1",
    entries: [{ entryId: "one", imageSha256: hash(image), cohort: "reproducible", stratum: "dashboard", selectionReason: "fixture" }],
  } as never;
  const bytes = Buffer.from("frozen-selection");
  return { corpusPath: join(corpusRoot, "entries.json"), c2, bytes };
}

describe("retag-gold CLI helpers", () => {
  it("builds a packet only after current image hashes match", () => {
    const { corpusPath, c2, bytes } = fixture();
    const selection = buildGoldSelection(c2, bytes, corpusPath);
    const packet = buildRetagGoldPacket(selection);
    expect(packet.entries[0]?.imagePath).toBe("images-private/one.png");
    expect(packet.fields).toEqual([...RETAG_GOLD_FIELDS]);
    expect(packet.entries[0]?.fields.components).toBeNull();
  });

  it("rejects a submission when the image changed after packet creation", () => {
    const { corpusPath, c2, bytes } = fixture();
    const selection = buildGoldSelection(c2, bytes, corpusPath);
    const submission = {
      schemaVersion: "1.0",
      artifactType: "retag-gold-submission",
      artifactId: "submission-one",
      selectionArtifactId: selection.selectionArtifactId,
      selectionSha256: selection.selectionSha256,
      submissionVersion: 1,
      actorId: "alice",
      actorKind: "human",
      reviewerRole: "gold",
      sealedAt: "2026-08-09T12:00:00.000Z",
      labels: [{
        entryId: "one",
        imageSha256: selection.entries[0]!.imageSha256,
        fields: {
          components: { status: "none", evidenceSource: "image" },
          domainTags: { status: "none", evidenceSource: "image" },
          colorScheme: { status: "present", value: "light", evidenceSource: "image" },
          mood: { status: "abstain", evidenceSource: "image", note: "not enough evidence" },
          "visual.typePairing": { status: "abstain", evidenceSource: "image", note: "no DOM" },
        },
      }],
    };
    writeFileSync(join(corpusPath, "../images-private/one.png"), "changed");
    expect(() => validateSubmissionFile(submission, selection, corpusPath)).toThrow(/current image hash mismatch/);
  });
});
