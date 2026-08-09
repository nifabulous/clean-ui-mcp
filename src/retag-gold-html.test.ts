import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { buildRetagGoldHtml } from "./retag-gold-html.js";
import type { RetagGoldPacket } from "./retag-gold.js";

const packet: RetagGoldPacket = {
  schemaVersion: "1.0",
  artifactType: "retag-gold-packet",
  artifactId: "retag-gold-selection-v1-packet",
  selectionArtifactId: "c2-label-integrity-selection-v1",
  selectionSha256: "a".repeat(64),
  fields: ["components", "domainTags", "colorScheme", "mood", "visual.typePairing"],
  instructions: ["review from evidence"],
  entries: [{
    entryId: "one",
    imageSha256: "b".repeat(64),
    imagePath: "images-private/one.png",
    cohort: "reproducible",
    stratum: "dashboard",
    fields: {
      components: null,
      domainTags: null,
      colorScheme: null,
      mood: null,
      "visual.typePairing": null,
    },
  }],
};

describe("retag gold HTML packet", () => {
  it("embeds the image and all gold controls in a standalone page", () => {
    const html = buildRetagGoldHtml(packet, new Map([["one", "file:///tmp/one.png"]]))
    expect(html).toContain("file:///tmp/one.png");
    expect(html).toContain("Copy JSON");
    expect(html).toContain("components");
    expect(html).toContain("domainTags");
    expect(html).toContain("visual.typePairing");
    expect(html).toContain("navigator.clipboard");
  });

  it("does not allow packet values to break the embedded script", () => {
    const hostile = { ...packet, instructions: ["</script><img src=x>"] };
    const html = buildRetagGoldHtml(hostile, new Map([["one", "file:///tmp/one.png"]]));
    expect(html).not.toContain("</script><img src=x>");
    expect(html).toContain("\\u003c/script>");
  });

  it("runs locally and renders the screenshot card and five field controls", () => {
    const html = buildRetagGoldHtml(packet, new Map([["one", "file:///tmp/one.png"]]));
    const dom = new JSDOM(html, { runScripts: "dangerously", url: "http://localhost/" });
    expect(dom.window.document.querySelectorAll("article.entry")).toHaveLength(1);
    expect(dom.window.document.querySelectorAll(".field")).toHaveLength(5);
    expect(dom.window.document.querySelector("img")?.getAttribute("src")).toBe("file:///tmp/one.png");
    dom.window.close();
  });

  it("imports an outside QA submission only when it matches this packet", () => {
    const html = buildRetagGoldHtml(packet, new Map([['one', 'file:///tmp/one.png']]));
    const dom = new JSDOM(html, { runScripts: "dangerously", url: "http://localhost/" });
    dom.window.alert = () => {};
    const submission = {
      artifactType: "retag-gold-submission",
      selectionArtifactId: packet.selectionArtifactId,
      selectionSha256: packet.selectionSha256,
      actorId: "qa-two",
      reviewerRole: "qa",
      labels: [{
        entryId: "one",
        imageSha256: packet.entries[0]!.imageSha256,
        fields: {
          components: { status: "present", evidenceSource: "image", value: ["icon-button"], oov: ["voice-card"], note: "The visible voice card is not in the current list." },
          domainTags: { status: "none", evidenceSource: "image" },
          colorScheme: { status: "present", evidenceSource: "image", value: "light" },
          mood: { status: "present", evidenceSource: "image", value: "calm" },
          "visual.typePairing": { status: "abstain", evidenceSource: "image", note: "No DOM sidecar is available." },
        },
      }],
    };
    expect((dom.window as unknown as { importSubmission: (value: unknown) => boolean }).importSubmission(submission)).toBe(true);
    expect(dom.window.document.querySelector<HTMLInputElement>("#actor")?.value).toBe("qa-two");
    expect(dom.window.document.querySelector("#progress")?.textContent).toBe("1 / 1 entries complete");
    dom.window.close();
  });

  it("explains field-specific decisions instead of exposing cryptic statuses", () => {
    const html = buildRetagGoldHtml(packet, new Map([["one", "file:///tmp/one.png"]]));
    expect(html).toContain("Select known components");
    expect(html).toContain("None from current vocabulary");
    expect(html).toContain("Not sure / insufficient evidence");
    expect(html).toContain("New or missing vocabulary item");
    expect(html).toContain("Choose every visible component");
    expect(html).toContain("Add missing component(s), optional");
    expect(html).toContain("Only assign a domain when the screenshot exposes evidence");
    expect(html).toContain("Import JSON");
    expect(html).toContain("DOM is the captured page structure");
    expect(html).toContain("calm");
    expect(html).toContain("DM Sans");
  });
});
