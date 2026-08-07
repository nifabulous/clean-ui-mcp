import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { createVerifyCtx, ensureRaw } from "./ctx.js";

async function makePng(path: string, width = 4, height = 3): Promise<void> {
  const px = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    px[i * 4] = 0x25; px[i * 4 + 1] = 0x63; px[i * 4 + 2] = 0xeb; px[i * 4 + 3] = 0xff;
  }
  await sharp(px, { raw: { width, height, channels: 4 } }).png().toFile(path);
}

describe("verify ctx", () => {
  it("reads dimensions without decoding pixels", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-ctx-"));
    try {
      const png = join(dir, "card.png");
      await makePng(png);
      const ctx = await createVerifyCtx(png);
      expect(ctx.width).toBe(4);
      expect(ctx.height).toBe(3);
      expect(ctx.raw).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("decodes RGBA once and reuses the buffer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-ctx-"));
    try {
      const png = join(dir, "card.png");
      await makePng(png);
      const ctx = await createVerifyCtx(png);
      const a = await ensureRaw(ctx);
      const b = await ensureRaw(ctx);
      expect(a.width).toBe(4);
      expect(a.height).toBe(3);
      expect(a.channels).toBe(4);
      expect(a.data.length).toBe(4 * 3 * 4);
      expect(b).toBe(a);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
