import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { detectColorScheme } from "./color-scheme.js";

describe("deterministic color scheme", () => {
  it("classifies clear light and dark images", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clean-ui-colors-"));
    try {
      const light = join(dir, "light.png");
      const dark = join(dir, "dark.png");
      await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 245, g: 245, b: 245 } } }).png().toFile(light);
      await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 20, g: 20, b: 20 } } }).png().toFile(dark);
      expect((await detectColorScheme(light)).colorScheme).toBe("light");
      expect((await detectColorScheme(dark)).colorScheme).toBe("dark");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("abstains near the calibration threshold", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clean-ui-colors-"));
    try {
      const image = join(dir, "ambiguous.png");
      await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 115, g: 115, b: 115 } } }).png().toFile(image);
      expect((await detectColorScheme(image)).colorScheme).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the explicit downsample dimension and the bounded default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clean-ui-colors-"));
    try {
      const image = join(dir, "downsample.png");
      const pixels = Buffer.from([
        100, 100, 100,
        100, 100, 100,
        255, 255, 255,
      ]);
      await sharp(pixels, { raw: { width: 3, height: 1, channels: 3 } }).png().toFile(image);
      expect((await detectColorScheme(image, 3)).colorScheme).toBeNull();
      expect((await detectColorScheme(image, 1)).colorScheme).toBe("light");
      expect((await detectColorScheme(image)).colorScheme).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an invalid sampling dimension before reading the image", async () => {
    await expect(detectColorScheme("not-an-image.png", 0)).rejects.toThrow(/positive integer/);
  });
});
