import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildColorSchemeAuditInputs } from "./color-scheme-audit.js";

describe("color scheme audit CLI inputs", () => {
  it("keeps safe corpus-relative paths and loads the exact image bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "clean-ui-color-audit-"));
    const imageDir = join(root, "images-private");
    mkdirSync(imageDir, { recursive: true });
    const bytes = Buffer.from("fixture-image");
    writeFileSync(join(imageDir, "one.png"), bytes);
    const inputs = buildColorSchemeAuditInputs([
      { id: "one", image: { path: "images-private/one.png" }, colorScheme: "light" },
      { id: "two", image: {}, colorScheme: null },
    ], root);
    expect(inputs[0]).toMatchObject({ entryId: "one", imagePath: "images-private/one.png", imageSha256: null, existingColorScheme: "light" });
    expect(inputs[0]?.loadImage?.()).toEqual(bytes);
    expect(inputs[1]).toMatchObject({ entryId: "two", imagePath: null, imageSha256: null, existingColorScheme: null });
  });

  it("allows double dots inside a filename while rejecting traversal segments", () => {
    const root = mkdtempSync(join(tmpdir(), "clean-ui-color-audit-"));
    const imageDir = join(root, "images-private");
    mkdirSync(imageDir, { recursive: true });
    writeFileSync(join(imageDir, "foo..bar.png"), "fixture-image");
    expect(() => buildColorSchemeAuditInputs([{ id: "double-dot", image: { path: "images-private/foo..bar.png" } }], root)).not.toThrow();
    expect(() => buildColorSchemeAuditInputs([{ id: "dot-segment", image: { path: "images-private/./foo.png" } }], root)).toThrow(/safe corpus image path/);
  });

  it("rejects traversal, absolute, and symlink-escaping paths", () => {
    const root = mkdtempSync(join(tmpdir(), "clean-ui-color-audit-"));
    mkdirSync(join(root, "images-private"), { recursive: true });
    expect(() => buildColorSchemeAuditInputs([{ id: "escape", image: { path: "../secret.png" } }], root)).toThrow(/safe corpus image path/);
    expect(() => buildColorSchemeAuditInputs([{ id: "absolute", image: { path: "/tmp/secret.png" } }], root)).toThrow(/safe corpus image path/);
    const outside = join(mkdtempSync(join(tmpdir(), "clean-ui-color-audit-outside-")), "outside");
    writeFileSync(outside, "outside");
    symlinkSync(outside, join(root, "images-private", "link.png"));
    expect(() => buildColorSchemeAuditInputs([{ id: "symlink", image: { path: "images-private/link.png" } }], root)).toThrow(/escapes corpus root/);
  });

  it("rejects missing and duplicate entry IDs", () => {
    const root = mkdtempSync(join(tmpdir(), "clean-ui-color-audit-"));
    expect(() => buildColorSchemeAuditInputs([{ image: { path: null } }], root)).toThrow(/missing entry ID/);
    expect(() => buildColorSchemeAuditInputs([{ id: "same" }, { id: "same" }], root)).toThrow(/duplicate entry ID/);
  });
});
