import { describe, expect, it } from "vitest";
import { buildColorSchemeAuditInputs } from "./color-scheme-audit.js";

describe("color scheme audit CLI inputs", () => {
  it("keeps corpus-relative image paths and binds existing image hashes", () => {
    const inputs = buildColorSchemeAuditInputs([
      { id: "one", image: { path: "images/one.png" }, colorScheme: "light" },
      { id: "two", image: {}, colorScheme: null },
    ], "/tmp/does-not-exist-corpus");
    expect(inputs).toEqual([
      { entryId: "one", imagePath: "images/one.png", imageSha256: null, existingColorScheme: "light" },
      { entryId: "two", imagePath: null, imageSha256: null, existingColorScheme: null },
    ]);
  });
});
