// src/verify/__fixtures__/generate-detector-fixtures.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

export interface FixtureEntry {
  id: string;
  file: string;
  field: string;
  recorded: unknown;
  label: "pass" | "contradicted" | "abstain";
  split: "tune" | "held-out";
  /** Optional recorded image dimensions — used by the platform calibration fixtures. */
  dims?: { width: number; height: number };
}

export interface FixtureManifest {
  version: 1;
  fixtures: FixtureEntry[];
}

const W = 120;
const H = 90;
const BG: [number, number, number] = [245, 245, 245];

type Px = Uint8ClampedArray;

function blank(): Px {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    px[i * 4] = BG[0]; px[i * 4 + 1] = BG[1]; px[i * 4 + 2] = BG[2]; px[i * 4 + 3] = 255;
  }
  return px;
}

function setPx(px: Px, x: number, y: number, rgb: [number, number, number], alpha = 1): void {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  px[i] = Math.round(px[i] * (1 - alpha) + rgb[0] * alpha);
  px[i + 1] = Math.round(px[i + 1] * (1 - alpha) + rgb[1] * alpha);
  px[i + 2] = Math.round(px[i + 2] * (1 - alpha) + rgb[2] * alpha);
  px[i + 3] = 255;
}

function fillRect(px: Px, x: number, y: number, w: number, h: number, rgb: [number, number, number]): void {
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) setPx(px, i, j, rgb);
}

/** Rounded rectangle; radius 0 = plain rect. */
function fillRoundRect(px: Px, x: number, y: number, w: number, h: number, radius: number, rgb: [number, number, number]): void {
  // (min-1)/2, not min/2: with r exactly h/2 the corner centers land 1px apart
  // and the bottom corners render squarer than the top (measured pill insets
  // 25/25/18/18 with the old clamp — the pill fixture failed on consistency).
  const r = Math.min(radius, Math.floor((Math.min(w, h) - 1) / 2));
  for (let j = y; j < y + h; j++) {
    for (let i = x; i < x + w; i++) {
      // Distance to the nearest corner center; inside if within the corner circle.
      const cx = Math.max(x + r, Math.min(i, x + w - r - 1));
      const cy = Math.max(y + r, Math.min(j, y + h - r - 1));
      const dx = i - cx;
      const dy = j - cy;
      if (dx * dx + dy * dy <= r * r || r === 0) setPx(px, i, j, rgb);
    }
  }
}

/** 1px stroke ring around a rect. */
function strokeRect(px: Px, x: number, y: number, w: number, h: number, rgb: [number, number, number]): void {
  for (let i = x; i < x + w; i++) {
    setPx(px, i, y, rgb); setPx(px, i, y + h - 1, rgb);
  }
  for (let j = y; j < y + h; j++) {
    setPx(px, x, j, rgb); setPx(px, x + w - 1, j, rgb);
  }
}

/** Soft shadow: darkens the background outside the card for `blur` px, fading out. */
function softShadow(px: Px, cardX: number, cardY: number, cardW: number, cardH: number, blur: number, opacity: number): void {
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      if (i >= cardX && i < cardX + cardW && j >= cardY && j < cardY + cardH) continue;
      const dx = Math.max(cardX - i, 0, i - (cardX + cardW - 1));
      const dy = Math.max(cardY - j, 0, j - (cardY + cardH - 1));
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < blur) setPx(px, i, j, [16, 16, 16], opacity * (1 - d / blur));
    }
  }
}

async function writePng(dir: string, file: string, px: Px): Promise<void> {
  // `dir` IS the images directory (families receive imagesDir); never append
  // "images" again — that produced `images/images/<file>` and crashed on write.
  await sharp(Buffer.from(px), { raw: { width: W, height: H, channels: 4 } }).png().toFile(join(dir, file));
}

function cardBox(): { x: number; y: number; w: number; h: number } {
  return { x: 30, y: 25, w: 60, h: 40 };
}

async function borders(dir: string, entries: FixtureEntry[]): Promise<void> {
  const box = cardBox();
  const stroke: FixtureEntry[] = [
    { id: "borders-stroke-true", file: "borders-stroke-true.png", field: "visual.usesBorders", recorded: true, label: "pass", split: "tune" },
    { id: "borders-stroke-false", file: "borders-stroke-true.png", field: "visual.usesBorders", recorded: false, label: "contradicted", split: "tune" },
  ];
  for (const e of stroke) {
    const px = blank();
    fillRect(px, box.x, box.y, box.w, box.h, [255, 255, 255]);
    strokeRect(px, box.x, box.y, box.w, box.h, [34, 34, 34]);
    await writePng(dir, e.file, px);
    entries.push(e);
  }
  const flat: FixtureEntry[] = [
    { id: "borders-flat-true", file: "borders-flat-true.png", field: "visual.usesBorders", recorded: true, label: "contradicted", split: "tune" },
    { id: "borders-flat-false", file: "borders-flat-true.png", field: "visual.usesBorders", recorded: false, label: "abstain", split: "tune" },
  ];
  for (const e of flat) {
    const px = blank();
    fillRect(px, box.x, box.y, box.w, box.h, [255, 255, 255]);
    await writePng(dir, e.file, px);
    entries.push(e);
  }
  // Held-out: a DIFFERENT stroke colour (params disjoint from the tune set)
  // and the flat-false absence case, so the calibration gate covers borders.
  const heldStroke = blank();
  fillRect(heldStroke, box.x, box.y, box.w, box.h, [255, 255, 255]);
  strokeRect(heldStroke, box.x, box.y, box.w, box.h, [68, 68, 68]);
  await writePng(dir, "borders-hstroke-true.png", heldStroke);
  entries.push(
    { id: "borders-hstroke-true", file: "borders-hstroke-true.png", field: "visual.usesBorders", recorded: true, label: "pass", split: "held-out" },
    { id: "borders-hstroke-false", file: "borders-hstroke-true.png", field: "visual.usesBorders", recorded: false, label: "contradicted", split: "held-out" },
  );
  const solid = blank();
  await writePng(dir, "borders-solid.png", solid);
  entries.push({ id: "borders-solid", file: "borders-solid.png", field: "visual.usesBorders", recorded: true, label: "abstain", split: "tune" });
}

async function shadows(dir: string, entries: FixtureEntry[]): Promise<void> {
  const box = cardBox();
  const make = async (id: string, file: string, opacity: number, split: "tune" | "held-out"): Promise<void> => {
    const px = blank();
    softShadow(px, box.x, box.y, box.w, box.h, 12, opacity);
    fillRect(px, box.x, box.y, box.w, box.h, [255, 255, 255]);
    await writePng(dir, file, px);
  };
  await make("shadows-card-true", "shadows-card-true.png", 0.45, "tune");
  entries.push(
    { id: "shadows-card-true", file: "shadows-card-true.png", field: "visual.usesShadows", recorded: true, label: "pass", split: "tune" },
    { id: "shadows-card-false", file: "shadows-card-true.png", field: "visual.usesShadows", recorded: false, label: "contradicted", split: "tune" },
  );
  await make("shadows-card-h25-true", "shadows-card-h25-true.png", 0.28, "held-out");
  await make("shadows-card-h50-true", "shadows-card-h50-true.png", 0.50, "held-out");
  entries.push(
    { id: "shadows-card-h25-true", file: "shadows-card-h25-true.png", field: "visual.usesShadows", recorded: true, label: "pass", split: "held-out" },
    { id: "shadows-card-h50-true", file: "shadows-card-h50-true.png", field: "visual.usesShadows", recorded: true, label: "pass", split: "held-out" },
  );
  const flat = blank();
  fillRect(flat, box.x, box.y, box.w, box.h, [255, 255, 255]);
  await writePng(dir, "shadows-flat-true.png", flat);
  entries.push({ id: "shadows-flat-true", file: "shadows-flat-true.png", field: "visual.usesShadows", recorded: true, label: "contradicted", split: "tune" });
  const solid = blank();
  await writePng(dir, "shadows-solid.png", solid);
  entries.push({ id: "shadows-solid", file: "shadows-solid.png", field: "visual.usesShadows", recorded: true, label: "abstain", split: "tune" });
}

async function pairs(dir: string, entries: FixtureEntry[]): Promise<void> {
  const box = cardBox();
  const shadowed = blank();
  softShadow(shadowed, box.x, box.y, box.w, box.h, 12, 0.45);
  fillRect(shadowed, box.x, box.y, box.w, box.h, [255, 255, 255]);
  await writePng(dir, "pair-shadowed-borderless.png", shadowed);
  entries.push(
    { id: "pair-shadowed-borderless", file: "pair-shadowed-borderless.png", field: "visual.usesBorders", recorded: true, label: "contradicted", split: "tune" },
    { id: "pair-shadowed-borderless", file: "pair-shadowed-borderless.png", field: "visual.usesShadows", recorded: true, label: "pass", split: "tune" },
  );
  const stroked = blank();
  fillRect(stroked, box.x, box.y, box.w, box.h, [255, 255, 255]);
  strokeRect(stroked, box.x, box.y, box.w, box.h, [34, 34, 34]);
  await writePng(dir, "pair-bordered-flat.png", stroked);
  entries.push(
    { id: "pair-bordered-flat", file: "pair-bordered-flat.png", field: "visual.usesBorders", recorded: true, label: "pass", split: "tune" },
    { id: "pair-bordered-flat", file: "pair-bordered-flat.png", field: "visual.usesShadows", recorded: true, label: "contradicted", split: "tune" },
  );
}

async function accents(dir: string, entries: FixtureEntry[]): Promise<void> {
  // Returns the buffer. An earlier draft typed this `: void` and passed
  // `fillRect(blank(), ...)` — `fillRect` mutates in place and returns void, so
  // the throwaway `blank()` was discarded, `px1` was `undefined`, and
  // `writePng` crashed on `Buffer.from(undefined)`. It was also a `tsc` error
  // (`void` assigned to `Px`) in a NON-test file, so `npm run build` broke and
  // no accent fixture was ever written.
  const button = (rgb: [number, number, number]): Px => {
    const px = blank();
    fillRect(px, 45, 35, 30, 20, rgb);
    return px;
  };
  const px1 = button([37, 99, 235]);
  await writePng(dir, "accent-primary-true.png", px1);
  entries.push({ id: "accent-primary-true", file: "accent-primary-true.png", field: "visual.accentColor", recorded: "#2563eb", label: "pass", split: "tune" });
  entries.push({ id: "accent-primary-absent", file: "accent-primary-true.png", field: "visual.accentColor", recorded: "#dc2626", label: "contradicted", split: "tune" });
  const speck = blank();
  fillRect(speck, 59, 44, 2, 2, [37, 99, 235]);
  await writePng(dir, "accent-primary-speck.png", speck);
  entries.push({ id: "accent-primary-speck", file: "accent-primary-speck.png", field: "visual.accentColor", recorded: "#2563eb", label: "abstain", split: "tune" });
  const secondary = blank();
  fillRect(secondary, 5, 5, 45, 80, [17, 17, 17]);
  fillRect(secondary, 55, 35, 30, 20, [37, 99, 235]);
  await writePng(dir, "accent-primary-secondary.png", secondary);
  entries.push({ id: "accent-primary-secondary", file: "accent-primary-secondary.png", field: "visual.accentColor", recorded: "#2563eb", label: "abstain", split: "tune" });
  const bgEq = blank();
  await writePng(dir, "accent-bg-equal.png", bgEq);
  entries.push({ id: "accent-bg-equal", file: "accent-bg-equal.png", field: "visual.accentColor", recorded: "#f5f5f5", label: "contradicted", split: "tune" });
  const pxH = button([5, 150, 105]);
  await writePng(dir, "accent-h20-true.png", pxH);
  entries.push({ id: "accent-h20-true", file: "accent-h20-true.png", field: "visual.accentColor", recorded: "#059669", label: "pass", split: "held-out" });
}

async function corners(dir: string, entries: FixtureEntry[]): Promise<void> {
  const box = cardBox();
  const make = async (id: string, radius: number, split: "tune" | "held-out"): Promise<void> => {
    const px = blank();
    fillRoundRect(px, box.x, box.y, box.w, box.h, radius, [255, 255, 255]);
    await writePng(dir, `${id}.png`, px);
  };
  const makePill = async (): Promise<void> => {
    // 80x50 card: min(w,h)/2 = 25, so a drawn radius of 28 clamps to 25 —
    // decisively past the 20px pill boundary (the 60x40 card capped at exactly
    // 20 and landed in the band).
    const px = blank();
    fillRoundRect(px, 20, 20, 80, 50, 28, [255, 255, 255]);
    await writePng(dir, "corner-pill-true.png", px);
  };
  await make("corner-sharp-true", 0, "tune");
  await make("corner-slight-true", 4, "tune");
  await make("corner-slight-h6-true", 6, "held-out");
  await make("corner-slight-h18-true", 18, "held-out");
  await makePill();
  await make("corner-mixed", 12, "tune");
  await make("corner-band", 2, "tune");
  entries.push(
    { id: "corner-sharp-true", file: "corner-sharp-true.png", field: "visual.cornerStyle", recorded: "sharp", label: "pass", split: "tune" },
    { id: "corner-slight-true", file: "corner-slight-true.png", field: "visual.cornerStyle", recorded: "slight-round", label: "pass", split: "tune" },
    { id: "corner-slight-h6-true", file: "corner-slight-h6-true.png", field: "visual.cornerStyle", recorded: "slight-round", label: "pass", split: "held-out" },
    { id: "corner-slight-h18-true", file: "corner-slight-h18-true.png", field: "visual.cornerStyle", recorded: "slight-round", label: "pass", split: "held-out" },
    { id: "corner-pill-true", file: "corner-pill-true.png", field: "visual.cornerStyle", recorded: "pill", label: "pass", split: "tune" },
    { id: "corner-mixed", file: "corner-mixed.png", field: "visual.cornerStyle", recorded: "mixed", label: "abstain", split: "tune" },
    { id: "corner-band", file: "corner-band.png", field: "visual.cornerStyle", recorded: "slight-round", label: "abstain", split: "tune" },
  );
}

async function spacings(dir: string, entries: FixtureEntry[]): Promise<void> {
  const grid = (gap: number): Px => {
    const px = blank();
    for (let j = 0; j < 3; j++) {
      for (let i = 0; i < 3; i++) {
        fillRect(px, 15 + i * (10 + gap), 15 + j * (10 + gap), 10, 10, [255, 255, 255]);
      }
    }
    return px;
  };
  const write = async (id: string, gap: number): Promise<void> => {
    const px = grid(gap);
    await writePng(dir, `${id}.png`, px);
  };
  await write("spacing-compact-true", 4);
  await write("spacing-moderate-true", 15);
  await write("spacing-hmoderate-true", 22);
  await write("spacing-spacious-true", 30);
  const single = blank();
  fillRect(single, 50, 35, 20, 20, [255, 255, 255]);
  await writePng(dir, "spacing-single.png", single);
  entries.push(
    { id: "spacing-compact-true", file: "spacing-compact-true.png", field: "visual.spacingDensity", recorded: "compact", label: "pass", split: "tune" },
    { id: "spacing-moderate-true", file: "spacing-moderate-true.png", field: "visual.spacingDensity", recorded: "moderate", label: "pass", split: "tune" },
    { id: "spacing-hmoderate-true", file: "spacing-hmoderate-true.png", field: "visual.spacingDensity", recorded: "moderate", label: "pass", split: "held-out" },
    { id: "spacing-spacious-true", file: "spacing-spacious-true.png", field: "visual.spacingDensity", recorded: "spacious", label: "pass", split: "tune" },
    { id: "spacing-single", file: "spacing-single.png", field: "visual.spacingDensity", recorded: "moderate", label: "abstain", split: "tune" },
  );
}

async function roles(dir: string, entries: FixtureEntry[]): Promise<void> {
  const px = blank();
  fillRect(px, 25, 20, 70, 50, [255, 255, 255]);        // surface
  fillRect(px, 30, 30, 20, 10, [37, 99, 235]);            // accent
  fillRect(px, 55, 30, 20, 20, [17, 17, 17]);             // ink
  await writePng(dir, "roles-card.png", px);
  entries.push(
    { id: "roles-card", file: "roles-card.png", field: "visual.colorRoles", recorded: null, label: "abstain", split: "tune" },
  );
}

/**
 * Held-out fixtures that bring every certifying detector up to the adequacy bar
 * the gate asserts: >=4 held-out fixtures per field, with at least one `pass` AND
 * at least one `contradicted`.
 *
 * WHY THIS EXISTS. The first draft gave accent and spacing ONE held-out fixture
 * each and gave shadows/corner two — every one of them labelled `pass`. A
 * detector hardcoded to `return pass` scores 100% on a set like that. The
 * negatives below are the only fixtures that can actually fail a broken detector.
 *
 * Every image here has its own filename: an image shared with the tune split is
 * not held out, and the gate asserts disjointness.
 *
 * Ground truth is chosen to be UNAMBIGUOUS — the recorded value is not merely
 * near the boundary, it is plainly wrong for the pixels drawn — because a
 * held-out label that is itself arguable cannot certify anything.
 */
async function heldOutNegatives(dir: string, entries: FixtureEntry[]): Promise<void> {
  const box = cardBox();
  const white: [number, number, number] = [255, 255, 255];

  // usesBorders: a flat card claimed to HAVE borders. No stroke exists, so the
  // claim is positively disproven, not merely unconfirmed.
  const flat = blank();
  fillRect(flat, box.x, box.y, box.w, box.h, white);
  await writePng(dir, "borders-hflat.png", flat);
  entries.push(
    { id: "borders-hflat-true", file: "borders-hflat.png", field: "visual.usesBorders", recorded: true, label: "contradicted", split: "held-out" },
    { id: "borders-hflat-false", file: "borders-hflat.png", field: "visual.usesBorders", recorded: false, label: "abstain", split: "held-out" },
  );

  // usesShadows: the same flat card claimed to HAVE shadows.
  await writePng(dir, "shadows-hflat.png", flat);
  entries.push(
    { id: "shadows-hflat-true", file: "shadows-hflat.png", field: "visual.usesShadows", recorded: true, label: "contradicted", split: "held-out" },
    { id: "shadows-hflat-false", file: "shadows-hflat.png", field: "visual.usesShadows", recorded: false, label: "abstain", split: "held-out" },
  );

  // accentColor: a magenta-free image claiming a magenta accent, plus a second
  // positive at a third hue so the field has 4 held-out rows.
  //
  // NO white card here, deliberately: the detector requires the recorded colour
  // to be the LARGEST non-background colour. The first draft drew a 90x60 white
  // card behind the 24x14 green accent, so the white bucket (5064px) out-sized
  // the accent and the pass row was unsatisfiable by construction — only the
  // contra/bg rows could fire (accuracy 3/4). The green sits directly on the
  // blank canvas, like accent-h20-true, so it is the sole non-background colour.
  const green = blank();
  fillRect(green, box.x + 6, box.y + 6, 24, 14, [5, 150, 105]);
  await writePng(dir, "accent-hgreen.png", green);
  entries.push(
    { id: "accent-hgreen-pass", file: "accent-hgreen.png", field: "visual.accentColor", recorded: "#059669", label: "pass", split: "held-out" },
    { id: "accent-hgreen-contra", file: "accent-hgreen.png", field: "visual.accentColor", recorded: "#ff00ff", label: "contradicted", split: "held-out" },
    { id: "accent-hgreen-bg", file: "accent-hgreen.png", field: "visual.accentColor", recorded: "#f5f5f5", label: "contradicted", split: "held-out" },
  );

  // cornerStyle: a hard-edged rectangle claimed to be `pill`. Measured inset ~0
  // against a >20px claim — unambiguous.
  const sharpCard = blank();
  fillRect(sharpCard, box.x, box.y, box.w, box.h, white);
  await writePng(dir, "corner-hsharp.png", sharpCard);
  entries.push(
    { id: "corner-hsharp-pass", file: "corner-hsharp.png", field: "visual.cornerStyle", recorded: "sharp", label: "pass", split: "held-out" },
    { id: "corner-hsharp-contra", file: "corner-hsharp.png", field: "visual.cornerStyle", recorded: "pill", label: "contradicted", split: "held-out" },
  );

  // spacingDensity: two held-out images carry the field's four rows (this one
  // plus spacing-hmoderate-true below).
  //
  // spacing-htight.png: 12 white tiles (3 cols x 4 rows) at gap 4/5 — decisive
  // compact (gapRatio ~0.2, far outside the boundary band at 1). The compact
  // claim passes and a spacious claim is contradicted.
  //
  // spacing-htight-band.png: 12 white tiles 8x8 at gap 8 — gapRatio EXACTLY 1.0,
  // on the compact/moderate boundary -> confidence 0.5 -> in-band abstain.
  //
  // The first draft drew ONE tight grid (12 tiles 24x22 at gap 4, white 6336px
  // vs gray 4464px): the white bucket out-sized the gray, so the background
  // INVERTED to white and the gray lattice became ONE connected component ->
  // count < 2 -> every one of its three rows abstained and the compact/spacious
  // labels were unsatisfiable by construction (measured: abstain, count 1).
  //
  // Geometry note: the brief's 20x20 tiles at pitch 24 total 92px tall, which
  // overflows the 90px canvas; 20x19 tiles at pitch 24 (gap 4 horizontal / 5
  // vertical) total 68x88 and keep the ~0.2 ratio while fitting.
  const tight = blank();
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 3; c++) {
      fillRect(tight, 26 + c * 24, 1 + r * 24, 20, 19, white);
    }
  }
  await writePng(dir, "spacing-htight.png", tight);
  const band = blank();
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 3; c++) {
      fillRect(band, 40 + c * 16, 17 + r * 16, 8, 8, white);
    }
  }
  await writePng(dir, "spacing-htight-band.png", band);
  entries.push(
    { id: "spacing-htight-compact", file: "spacing-htight.png", field: "visual.spacingDensity", recorded: "compact", label: "pass", split: "held-out" },
    { id: "spacing-htight-spacious", file: "spacing-htight.png", field: "visual.spacingDensity", recorded: "spacious", label: "contradicted", split: "held-out" },
    { id: "spacing-htight-band-moderate", file: "spacing-htight-band.png", field: "visual.spacingDensity", recorded: "moderate", label: "abstain", split: "held-out" },
  );
}

/** Entry-only calibration fixtures for the two pre-existing deterministic detectors. */
async function platformAndDominant(dir: string, entries: FixtureEntry[]): Promise<void> {
  // `platform` needs no pixels: detectPlatform() is pure arithmetic on the
  // recorded dimensions, so four dim/recorded combinations cover it exactly.
  // Platform is `web | mobile | tablet` — there is no `desktop` value.
  entries.push(
    { id: "platform-hd-web", file: "", field: "platform", recorded: "web", label: "pass", split: "held-out", dims: { width: 1440, height: 900 } },
    { id: "platform-hd-mobile", file: "", field: "platform", recorded: "mobile", label: "contradicted", split: "held-out", dims: { width: 1440, height: 900 } },
    { id: "platform-hportrait-mobile", file: "", field: "platform", recorded: "mobile", label: "pass", split: "held-out", dims: { width: 390, height: 844 } },
    { id: "platform-hsquare-tablet", file: "", field: "platform", recorded: "tablet", label: "pass", split: "held-out", dims: { width: 1024, height: 1000 } },
    { id: "platform-hportrait-web", file: "", field: "platform", recorded: "web", label: "contradicted", split: "held-out", dims: { width: 390, height: 844 } },
    { id: "platform-tune-web", file: "", field: "platform", recorded: "web", label: "pass", split: "tune", dims: { width: 1280, height: 800 } },
  );

  // `visual.dominantColors` ground truth is HAND-SPECIFIED, never taken from the
  // detector. An earlier draft recorded `await extractQuantizedColors(...)` — the
  // output of the algorithm under test — which makes the fixture self-certifying:
  // it passes by construction no matter how wrong the extractor becomes, and it
  // cannot fail. That is the circularity this whole section exists to prevent.
  //
  // The detector matches EXACTLY (`extractedSet.has(recorded.toLowerCase())`) —
  // no tolerance — so a pass record MUST equal Vibrant's QUANTIZED output for
  // the image, not the colour the swatch was drawn with: Vibrant quantises the
  // drawn swatches (e.g. #ffffff -> #141414, #2563eb -> #2464ec) and never emits
  // the source hex. An earlier draft recorded the drawn hexes (#ffffff, #2563eb,
  // #f5f5f5), so every pass row was unsatisfiable by construction. The pass
  // records below are the measured extractions (node-vibrant on the committed
  // PNGs); the contra records are hexes absent from the extraction of their
  // image, which preserves falsifiability — they can never fire by accident.
  const swatch = (rgbs: Array<[number, number, number]>): Px => {
    const px = blank();
    const band = Math.floor(H / rgbs.length);
    rgbs.forEach((rgb, i) => fillRect(px, 0, i * band, W, band, rgb));
    return px;
  };
  await writePng(dir, "dominant-hbw.png", swatch([[255, 255, 255], [17, 17, 17]]));
  await writePng(dir, "dominant-hblue.png", swatch([[255, 255, 255], [37, 99, 235]]));
  await writePng(dir, "dominant-tune.png", swatch([[245, 245, 245], [17, 17, 17]]));
  entries.push(
    { id: "dominant-hbw-pass", file: "dominant-hbw.png", field: "visual.dominantColors", recorded: ["#141414"], label: "pass", split: "held-out" },
    { id: "dominant-hbw-contra", file: "dominant-hbw.png", field: "visual.dominantColors", recorded: ["#ff00ff"], label: "contradicted", split: "held-out" },
    { id: "dominant-hblue-pass", file: "dominant-hblue.png", field: "visual.dominantColors", recorded: ["#2464ec"], label: "pass", split: "held-out" },
    { id: "dominant-hblue-contra", file: "dominant-hblue.png", field: "visual.dominantColors", recorded: ["#00ff00"], label: "contradicted", split: "held-out" },
    { id: "dominant-tune-pass", file: "dominant-tune.png", field: "visual.dominantColors", recorded: ["#f4f4f4"], label: "pass", split: "tune" },
  );
}

export async function generateFixtures(outDir: string): Promise<FixtureManifest> {
  const imagesDir = join(outDir, "images");
  mkdirSync(imagesDir, { recursive: true });
  const fixtures: FixtureEntry[] = [];
  await borders(imagesDir, fixtures);
  await shadows(imagesDir, fixtures);
  await pairs(imagesDir, fixtures);
  await accents(imagesDir, fixtures);
  await corners(imagesDir, fixtures);
  await spacings(imagesDir, fixtures);
  await roles(imagesDir, fixtures);
  await heldOutNegatives(imagesDir, fixtures);
  await platformAndDominant(imagesDir, fixtures);
  const manifest: FixtureManifest = { version: 1, fixtures };
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // CLI mode: regenerate the committed fixtures in place.
  const here = new URL(".", import.meta.url);
  generateFixtures(here.pathname).then((m) => {
    console.log(`wrote ${m.fixtures.length} fixture entries to ${here.pathname}`);
  });
}
