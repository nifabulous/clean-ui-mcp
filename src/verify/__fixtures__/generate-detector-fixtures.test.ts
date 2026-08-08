// src/verify/__fixtures__/generate-detector-fixtures.test.ts
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFixtures } from "./generate-detector-fixtures.js";

const EXPECTED_IDS = [
  "borders-stroke-true", "borders-stroke-false", "borders-flat-true", "borders-flat-false", "borders-solid",
  "borders-hstroke-true", "borders-hflat-false",
  "shadows-card-true", "shadows-card-false", "shadows-flat-true", "shadows-solid",
  "shadows-card-h25-true", "shadows-card-h50-true",
  "accent-primary-true", "accent-primary-absent", "accent-primary-speck", "accent-primary-secondary",
  "accent-bg-equal", "accent-h20-true",
  "corner-sharp-true", "corner-slight-true", "corner-slight-h6-true", "corner-slight-h18-true",
  "corner-pill-true", "corner-mixed", "corner-band",
  "spacing-compact-true", "spacing-moderate-true", "spacing-spacious-true", "spacing-single",
  "spacing-hmoderate-true", "roles-card", "platform-hd-web", "platform-hd-mobile", "dominant-hbw-pass",
];

describe("detector fixtures", () => {
  it("generates every expected fixture with images on disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "detector-fixtures-"));
    try {
      const manifest = await generateFixtures(dir);
      expect(manifest.version).toBe(1);
      expect(manifest.fixtures.length).toBeGreaterThanOrEqual(EXPECTED_IDS.length);
      for (const id of EXPECTED_IDS) {
        const entries = manifest.fixtures.filter((f) => f.id === id);
        expect(entries.length).toBeGreaterThan(0, `missing fixture ${id}`);
        for (const e of entries) {
          if (!e.file) continue; // entry-only fixtures (platform) have no image
          expect(existsSync(join(dir, "images", e.file))).toBe(true, `missing image for ${id}`);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("splits tune and held-out into disjoint parameter ranges", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
    ) as { fixtures: Array<{ id: string; split: string }> };
    const heldOut = manifest.fixtures.filter((f) => f.split === "held-out").map((f) => f.id);
    expect(heldOut).toContain("shadows-card-h25-true");
    expect(heldOut).toContain("shadows-card-h50-true");
    expect(heldOut).toContain("corner-slight-h6-true");
    expect(heldOut).toContain("corner-slight-h18-true");
    expect(heldOut).toContain("accent-h20-true");
    expect(heldOut).toContain("borders-hstroke-true");
    expect(heldOut).toContain("spacing-hmoderate-true");
    expect(heldOut).toContain("platform-hd-web");
    expect(heldOut).toContain("dominant-hbw-pass");
  });
});
