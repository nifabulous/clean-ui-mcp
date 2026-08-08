import sharp from "sharp";

/** Decoded raw RGBA pixels shared by the pixel detectors. */
export interface RawBuffer {
  data: Buffer;
  width: number;
  height: number;
  channels: 4;
}

/**
 * The per-entry verification context. Not a bare buffer: `visual.dominantColors`
 * needs the path (Vibrant takes a path, tagger.ts:283), `platform` needs only
 * dimensions, and the pixel detectors share ONE lazily-decoded buffer.
 */
export interface VerifyCtx {
  imagePath: string;
  width: number;
  height: number;
  raw?: RawBuffer;
}

/** Reads dimensions without decoding pixels. */
export async function createVerifyCtx(imagePath: string): Promise<VerifyCtx> {
  const meta = await sharp(imagePath).metadata();
  if (meta.width === undefined || meta.height === undefined) {
    throw new Error(`cannot read dimensions from ${imagePath}`);
  }
  return { imagePath, width: meta.width, height: meta.height };
}

/** Decodes RGBA pixels once per entry; later calls reuse the buffer. */
export async function ensureRaw(ctx: VerifyCtx): Promise<RawBuffer> {
  if (ctx.raw) return ctx.raw;
  const { data, info } = await sharp(ctx.imagePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  ctx.raw = { data, width: info.width, height: info.height, channels: 4 };
  return ctx.raw;
}
