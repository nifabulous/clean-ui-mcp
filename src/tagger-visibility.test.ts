import { describe, expect, it } from "vitest";
import { assertVisibilityPathCompatible } from "./tagger.js";

describe("assertVisibilityPathCompatible", () => {
  it("allows private visibility with any path", () => {
    expect(() => assertVisibilityPathCompatible("private", "images-private/foo.png")).not.toThrow();
    expect(() => assertVisibilityPathCompatible("private", "images-public/foo.png")).not.toThrow();
  });

  it("allows public-own with an images-public/ path", () => {
    expect(() => assertVisibilityPathCompatible("public-own", "images-public/foo.png")).not.toThrow();
  });

  it("allows public-thumb with an images-public/ path", () => {
    expect(() => assertVisibilityPathCompatible("public-thumb", "images-public/foo.png")).not.toThrow();
  });

  it("rejects public-own with an images-private/ path (schema-invalid combination)", () => {
    expect(() => assertVisibilityPathCompatible("public-own", "images-private/foo.png")).toThrow(
      /imageVisibility "public-own" requires the image to live under images-public/,
    );
  });

  it("rejects public-thumb with an images-private/ path", () => {
    expect(() => assertVisibilityPathCompatible("public-thumb", "images-private/foo.png")).toThrow(
      /imageVisibility "public-thumb" requires the image to live under images-public/,
    );
  });

  it("error message names the bad visibility, the path, and both remediation options", () => {
    try {
      assertVisibilityPathCompatible("public-own", "images-private/secret.png");
      expect.fail("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("public-own");
      expect(msg).toContain("images-private/secret.png");
      expect(msg).toContain("Move the file to images-public/");
      expect(msg).toContain('use imageVisibility "private"');
    }
  });
});
