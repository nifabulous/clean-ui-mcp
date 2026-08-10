import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { buildColorSchemeCalibrationHtml } from "./color-scheme-calibration-html.js";
import {
  buildColorSchemeCalibrationPacket,
  canonicalArtifactJson,
  ColorSchemeCalibrationSubmissionSchema,
  sha256,
} from "./color-scheme-calibration.js";
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

  it("shows the imported decision on the radios, not just in the progress count", () => {
    const packet = buildColorSchemeCalibrationPacket(audit, "c".repeat(64), 1);
    const html = buildColorSchemeCalibrationHtml(packet, new Map([["one", "file:///tmp/one.png"]]));
    const dom = new JSDOM(html, { runScripts: "dangerously", url: "http://localhost/" });
    dom.window.alert = () => {};
    const doc = dom.window.document;
    const win = dom.window as unknown as { importSubmission: (value: unknown) => boolean };
    expect(win.importSubmission({
      schemaVersion: "1.0", artifactType: "color-scheme-calibration-submission", artifactId: "submission-qa-v1",
      packetArtifactId: packet.artifactId, packetSha256: html.match(/packetSha256":"([a-f0-9]{64})"/)?.[1],
      reviewerId: "qa", sealedAt: "2026-08-10T10:00:00.000Z",
      labels: [{ entryId: "one", imageSha256: "b".repeat(64), value: "dark" }],
    })).toBe(true);
    // A reviewer must be able to see what they are about to submit.
    const checked = [...doc.querySelectorAll<HTMLInputElement>('input[type="radio"]')].filter((input) => input.checked);
    expect(checked.map((input) => input.value)).toEqual(["dark"]);
    expect((doc.querySelector("#reviewer") as HTMLInputElement).value).toBe("qa");
    dom.window.close();
  });

  it("keeps a reviewer's labels when they identify themselves after labeling", () => {
    const packet = buildColorSchemeCalibrationPacket(audit, "c".repeat(64), 1);
    const html = buildColorSchemeCalibrationHtml(packet, new Map([["one", "file:///tmp/one.png"]]));
    const dom = new JSDOM(html, { runScripts: "dangerously", url: "http://localhost/" });
    const doc = dom.window.document;
    const radio = doc.querySelector('input[name="scheme-one"][value="light"]') as HTMLInputElement;
    radio.checked = true;
    radio.dispatchEvent(new dom.window.Event("change"));
    expect(doc.querySelector("#progress")?.textContent).toBe("1 / 1 complete");

    // Labeling first and typing the reviewer ID afterwards is the natural order.
    // Adopting an empty draft for the newly typed ID would silently destroy the
    // reviewer's hand-entered gold labels.
    const reviewer = doc.querySelector("#reviewer") as HTMLInputElement;
    for (const prefix of ["a", "al", "ali", "alic", "alice"]) {
      reviewer.value = prefix;
      reviewer.dispatchEvent(new dom.window.Event("input"));
      expect(doc.querySelector("#progress")?.textContent).toBe("1 / 1 complete");
    }
    // Correcting a typo in the ID must not discard the work either.
    reviewer.value = "alic";
    reviewer.dispatchEvent(new dom.window.Event("input"));
    expect(doc.querySelector("#progress")?.textContent).toBe("1 / 1 complete");
    expect(radio.checked).toBe(true);

    const built = (dom.window as unknown as { buildSubmission: () => { errors: string[] } }).buildSubmission();
    expect(built.errors).toEqual([]);
    dom.window.close();
  });

  it("does not show one reviewer's stored draft to another reviewer", () => {
    const packet = buildColorSchemeCalibrationPacket(audit, "c".repeat(64), 1);
    const html = buildColorSchemeCalibrationHtml(packet, new Map([["one", "file:///tmp/one.png"]]));
    const sha = html.match(/packetSha256":"([a-f0-9]{64})"/)?.[1];
    // Alice's draft is already on disk and Bob opens the packet fresh, which is
    // how two reviewers actually share a machine.
    const dom = new JSDOM("<!doctype html><body>", { runScripts: "dangerously", url: "http://localhost/" });
    dom.window.localStorage.setItem(`color-scheme-calibration:${sha}`, JSON.stringify({
      drafts: { alice: { one: { value: "light", note: "" } } },
    }));
    dom.window.document.open();
    dom.window.document.write(html);
    dom.window.document.close();
    const doc = dom.window.document;
    const reviewer = doc.querySelector("#reviewer") as HTMLInputElement;
    const setReviewer = (id: string) => {
      reviewer.value = id;
      reviewer.dispatchEvent(new dom.window.Event("input"));
    };
    expect(doc.querySelector("#progress")?.textContent).toBe("0 / 1 complete");
    setReviewer("bob");
    expect(doc.querySelector("#progress")?.textContent).toBe("0 / 1 complete");
    expect([...doc.querySelectorAll<HTMLInputElement>('input[type="radio"]')].some((input) => input.checked)).toBe(false);
    // Alice's own draft still comes back for Alice.
    setReviewer("alice");
    expect(doc.querySelector("#progress")?.textContent).toBe("1 / 1 complete");
    dom.window.close();
  });

  it("keeps the download blob alive until after the click", () => {
    const packet = buildColorSchemeCalibrationPacket(audit, "c".repeat(64), 1);
    const html = buildColorSchemeCalibrationHtml(packet, new Map([["one", "file:///tmp/one.png"]]));
    const dom = new JSDOM(html, { runScripts: "dangerously", url: "http://localhost/" });
    const doc = dom.window.document;
    const order: string[] = [];
    (dom.window.URL as unknown as { createObjectURL: (b: unknown) => string }).createObjectURL = () => { order.push("create"); return "blob:stub"; };
    (dom.window.URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => { order.push("revoke"); };
    const reviewer = doc.querySelector("#reviewer") as HTMLInputElement;
    reviewer.value = "alice";
    reviewer.dispatchEvent(new dom.window.Event("input"));
    const radio = doc.querySelector('input[name="scheme-one"][value="light"]') as HTMLInputElement;
    radio.checked = true;
    radio.dispatchEvent(new dom.window.Event("change"));

    let clickedWhileAttached = false;
    const realClick = dom.window.HTMLAnchorElement.prototype.click;
    dom.window.HTMLAnchorElement.prototype.click = function patched(this: HTMLAnchorElement) {
      clickedWhileAttached = this.isConnected;
      order.push("click");
    };
    (doc.querySelector("#download") as HTMLButtonElement).click();
    dom.window.HTMLAnchorElement.prototype.click = realClick;

    // Revoking synchronously after click, or clicking a detached anchor, is how
    // blob downloads silently fail in real browsers.
    expect(clickedWhileAttached).toBe(true);
    expect(order.indexOf("click")).toBeGreaterThan(order.indexOf("create"));
    expect(order).not.toContain("revoke");
    dom.window.close();
  });

  it("offers a selectable textarea when the clipboard is unavailable", async () => {
    const packet = buildColorSchemeCalibrationPacket(audit, "c".repeat(64), 1);
    const html = buildColorSchemeCalibrationHtml(packet, new Map([["one", "file:///tmp/one.png"]]));
    const dom = new JSDOM(html, { runScripts: "dangerously", url: "http://localhost/" });
    dom.window.alert = () => {};
    const doc = dom.window.document;
    Object.defineProperty(dom.window.navigator, "clipboard", { value: undefined, configurable: true });
    (doc as unknown as { execCommand: () => boolean }).execCommand = () => false;
    const reviewer = doc.querySelector("#reviewer") as HTMLInputElement;
    reviewer.value = "alice";
    reviewer.dispatchEvent(new dom.window.Event("input"));
    const radio = doc.querySelector('input[name="scheme-one"][value="light"]') as HTMLInputElement;
    radio.checked = true;
    radio.dispatchEvent(new dom.window.Event("change"));
    await (dom.window as unknown as { copyJson: () => Promise<void> }).copyJson();
    // Hand-entered gold labels must always be extractable, even when both the
    // clipboard API and execCommand are blocked.
    const fallback = doc.querySelector("#manual-json") as HTMLTextAreaElement | null;
    expect(fallback).not.toBeNull();
    const payload = JSON.parse(fallback!.value) as { labels: unknown[] };
    expect(payload.labels).toHaveLength(1);
    expect(ColorSchemeCalibrationSubmissionSchema.safeParse(payload).success).toBe(true);
    dom.window.close();
  });

  it("survives a corrupt or partial stored draft instead of rendering an inert page", () => {
    const packet = buildColorSchemeCalibrationPacket(audit, "c".repeat(64), 1);
    const html = buildColorSchemeCalibrationHtml(packet, new Map([["one", "file:///tmp/one.png"]]));
    const dom = new JSDOM("<!doctype html><body>", { runScripts: "dangerously", url: "http://localhost/" });
    const sha = html.match(/packetSha256":"([a-f0-9]{64})"/)?.[1];
    dom.window.localStorage.setItem(`color-scheme-calibration:${sha}`, JSON.stringify({
      drafts: {
        alice: { "no-such-entry": { value: "light", note: "" }, one: { value: 7, note: { nested: true } } },
      },
    }));
    const errors: string[] = [];
    dom.window.addEventListener("error", (event) => errors.push(String((event as ErrorEvent).message)));
    dom.window.document.open();
    dom.window.document.write(html);
    dom.window.document.close();
    const doc = dom.window.document;
    expect(errors).toEqual([]);
    expect(doc.querySelectorAll("article.entry")).toHaveLength(1);

    const reviewer = doc.querySelector("#reviewer") as HTMLInputElement;
    reviewer.value = "alice";
    reviewer.dispatchEvent(new dom.window.Event("input"));
    // Junk values are discarded, not adopted, and the page stays usable.
    expect(errors).toEqual([]);
    expect(doc.querySelector("#progress")?.textContent).toBe("0 / 1 complete");
    const radio = doc.querySelector('input[name="scheme-one"][value="dark"]') as HTMLInputElement;
    radio.checked = true;
    radio.dispatchEvent(new dom.window.Event("change"));
    expect(doc.querySelector("#progress")?.textContent).toBe("1 / 1 complete");
    dom.window.close();
  });

  it("renders an entry ID containing quotes and other selector metacharacters", () => {
    const hostileId = `a"b'c\\d[e]:f`;
    const hostileAudit = {
      ...audit,
      entries: [{ ...audit.entries[0]!, entryId: hostileId }],
    } satisfies ColorSchemeAuditReport;
    const packet = buildColorSchemeCalibrationPacket(hostileAudit, "c".repeat(64), 1);
    const html = buildColorSchemeCalibrationHtml(packet, new Map([[hostileId, "file:///tmp/one.png"]]));
    const dom = new JSDOM(html, { runScripts: "dangerously", url: "http://localhost/" });
    const doc = dom.window.document;
    const errors: string[] = [];
    dom.window.addEventListener("error", (event) => errors.push(String((event as ErrorEvent).message)));
    expect(doc.querySelectorAll("article.entry")).toHaveLength(1);
    const radio = doc.querySelectorAll<HTMLInputElement>('input[type="radio"]')[0]!;
    radio.checked = true;
    radio.dispatchEvent(new dom.window.Event("change"));
    expect(errors).toEqual([]);
    expect(doc.querySelector("#progress")?.textContent).toBe("1 / 1 complete");
    expect(doc.querySelectorAll("article.entry.complete")).toHaveLength(1);
    dom.window.close();
  });

  it("is self-contained: no network font or stylesheet request", () => {
    const packet = buildColorSchemeCalibrationPacket(audit, "c".repeat(64), 1);
    const html = buildColorSchemeCalibrationHtml(packet, new Map([["one", "file:///tmp/one.png"]]));
    expect(html).not.toContain("fonts.googleapis.com");
    expect(html).not.toContain("@import");
    expect(html).toContain("DM Sans");
  });

  it("exports a submission that satisfies the calibration submission contract", () => {
    const packet = buildColorSchemeCalibrationPacket(audit, "c".repeat(64), 1);
    const html = buildColorSchemeCalibrationHtml(packet, new Map([["one", "file:///tmp/one.png"]]));
    const dom = new JSDOM(html, { runScripts: "dangerously", url: "http://localhost/" });
    const doc = dom.window.document;
    const reviewer = doc.querySelector("#reviewer") as HTMLInputElement;
    reviewer.value = "alice";
    reviewer.dispatchEvent(new dom.window.Event("input"));
    const radio = doc.querySelector('input[name="scheme-one"][value="dark"]') as HTMLInputElement;
    radio.checked = true;
    radio.dispatchEvent(new dom.window.Event("change"));
    const built = (dom.window as unknown as { buildSubmission: () => { errors: string[]; payload: unknown } }).buildSubmission();
    expect(built.errors).toEqual([]);
    const parsed = ColorSchemeCalibrationSubmissionSchema.safeParse(built.payload);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.success && parsed.data.packetSha256).toBe(sha256(canonicalArtifactJson(packet)));
    dom.window.close();
  });
});
