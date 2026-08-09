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
});
