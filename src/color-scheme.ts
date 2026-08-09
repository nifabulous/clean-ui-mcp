import sharp from "sharp";

export const COLOR_SCHEME_THRESHOLD = 110;
export const COLOR_SCHEME_MARGIN = 12;
export const COLOR_SCHEME_MAX_DIMENSION = 256;

export type ColorScheme = "light" | "dark";

export type ColorSchemeDetection = {
  colorScheme: ColorScheme | null;
  medianLuma: number;
  threshold: number;
  margin: number;
};

/** Classify only clear page-level themes from production image pixels. */
export async function detectColorScheme(imagePath: string, maxDimension = COLOR_SCHEME_MAX_DIMENSION): Promise<ColorSchemeDetection> {
  const { data, info } = await sharp(imagePath)
    .resize({ width: maxDimension, height: maxDimension, fit: "inside", withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const lumas: number[] = [];
  const channels = info.channels;
  for (let offset = 0; offset + channels <= data.length; offset += channels) {
    const r = data[offset]!;
    const g = channels > 1 ? data[offset + 1]! : r;
    const b = channels > 2 ? data[offset + 2]! : g;
    lumas.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
  }
  if (lumas.length === 0) return { colorScheme: null, medianLuma: 0, threshold: COLOR_SCHEME_THRESHOLD, margin: COLOR_SCHEME_MARGIN };
  lumas.sort((a, b) => a - b);
  const middle = Math.floor(lumas.length / 2);
  const medianLuma = lumas.length % 2 === 0 ? (lumas[middle - 1]! + lumas[middle]!) / 2 : lumas[middle]!;
  const distance = Math.abs(medianLuma - COLOR_SCHEME_THRESHOLD);
  const colorScheme = distance < COLOR_SCHEME_MARGIN ? null : medianLuma < COLOR_SCHEME_THRESHOLD ? "dark" : "light";
  return { colorScheme, medianLuma, threshold: COLOR_SCHEME_THRESHOLD, margin: COLOR_SCHEME_MARGIN };
}
