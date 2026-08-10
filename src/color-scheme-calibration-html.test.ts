import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { buildColorSchemeCalibrationHtml } from "./color-scheme-calibration-html.js";
import { buildColorSchemeCalibrationPacket } from "./color-scheme-calibration.js";
import type { ColorSchemeAuditReport } from "./color-scheme-audit.js";

const audit = {
  schemaVersion: "1.0", artifactType: "deterministic-color-scheme-audit", artifactId: "deterministic-color-scheme-audit-v1", generatedAt: null, corpusSha256: "a".repeat(64),
  detector: { source: "src/color-scheme.ts", algorithmVersion: "color-scheme-v1", maxDimension: 256, threshold: 110, margin: 12 },
  summary: { entries: 1, proposed: 1, unchanged: 0, conflicts: 0, abstained: 0, missingImages: 0, errors: 0 },
  entries: [{ entryId: "one", imagePath: "images-private/one.png", imageSha256: "b".repeat(64), existingColorScheme: null, detectedColorScheme: "light", medianLuma: 220, threshold: 110, margin: 12, status: "propose" }],
} satisfies ColorSchemeAuditReport;

describe("color scheme calibration HTML", () => {
  it("renders image evidence, decisions, DM Sans, and import/export controls", () => {
    const packet = buildColorSchemeCalibrationPacket(audit, "c".repeat(64), 1);
    const html = buildColorSchemeCalibrationHtml(packet, new Map([["one", "file:///tmp/one.png"]]));
    expect(html).toContain("file:///tmp/one.png");
    expect(html).toContain("DM Sans");
    expect(html).toContain("Import JSON");
    expect(html).toContain("Copy JSON");
    expect(html).toContain("Download JSON");
    expect(html).toContain("Abstain — ambiguous");
    const dom = new JSDOM(html, { runScripts: "dangerously", url: "http://localhost/" });
    expect(dom.window.document.querySelectorAll("article.entry")).toHaveLength(1);
    expect(dom.window.document.querySelector("img")?.getAttribute("src")).toBe("file:///tmp/one.png");
    expect(dom.window.document.querySelectorAll('input[type="radio"]')).toHaveLength(3);
    dom.window.close();
  });

  it("escapes hostile packet values before embedding them in the script", () => {
    const packet = buildColorSchemeCalibrationPacket(audit, "c".repeat(64), 1);
    const hostile = { ...packet, instructions: ["</script><img src=x>"] };
    const html = buildColorSchemeCalibrationHtml(hostile, new Map([["one", "file:///tmp/one.png"]]));
    expect(html).not.toContain("</script><img src=x>");
    expect(html).toContain("\\u003c/script>");
  });

  it("imports a matching outside submission into the reviewer state", () => {
    const packet = buildColorSchemeCalibrationPacket(audit, "c".repeat(64), 1);
    const html = buildColorSchemeCalibrationHtml(packet, new Map([["one", "file:///tmp/one.png"]]));
    const dom = new JSDOM(html, { runScripts: "dangerously", url: "http://localhost/" });
    dom.window.alert = () => {};
    const submission = {
      schemaVersion: "1.0", artifactType: "color-scheme-calibration-submission", artifactId: "submission-qa-v1", packetArtifactId: packet.artifactId,
      packetSha256: html.match(/packetSha256":"([a-f0-9]{64})"/)?.[1], reviewerId: "qa", sealedAt: "2026-08-10T10:00:00.000Z",
      labels: [{ entryId: "one", imageSha256: "b".repeat(64), value: "light" }],
    };
    expect((dom.window as unknown as { importSubmission: (value: unknown) => boolean }).importSubmission(submission)).toBe(true);
    expect(dom.window.document.querySelector("#progress")?.textContent).toBe("1 / 1 complete");
    dom.window.close();
  });

  it("never embeds the detector answer or the existing corpus value in the reviewer page", () => {
    const packet = buildColorSchemeCalibrationPacket(audit, "c".repeat(64), 1);
    const html = buildColorSchemeCalibrationHtml(packet, new Map([["one", "file:///tmp/one.png"]]));
    // The page instructs the reviewer to ignore the detector and the corpus value.
    // Shipping either one inside the page contradicts that instruction.
    expect(html).not.toContain("detectedColorScheme");
    expect(html).not.toContain("existingColorScheme");
    expect(html).not.toContain("medianLuma");
    expect(html).toContain(packet.entries[0]!.imageSha256);
  });

  it("marks a completed card and scrolls to the next incomplete entry", () => {
    const packet = buildColorSchemeCalibrationPacket(audit, "c".repeat(64), 1);
    const html = buildColorSchemeCalibrationHtml(packet, new Map([["one", "file:///tmp/one.png"]]));
    const dom = new JSDOM(html, { runScripts: "dangerously", url: "http://localhost/" });
    const doc = dom.window.document;
    let scrolled = 0;
    doc.querySelectorAll("article.entry").forEach((card) => {
      (card as unknown as { scrollIntoView: () => void }).scrollIntoView = () => { scrolled += 1; };
    });
    (doc.querySelector("#jump") as HTMLButtonElement).click();
    expect(scrolled).toBe(1);

    const radio = doc.querySelector('input[name="scheme-one"][value="light"]') as HTMLInputElement;
    radio.checked = true;
    radio.dispatchEvent(new dom.window.Event("change"));
    expect(doc.querySelector("#progress")?.textContent).toBe("1 / 1 complete");
    expect(doc.querySelectorAll("article.entry.complete")).toHaveLength(1);
    dom.window.close();
  });
});
