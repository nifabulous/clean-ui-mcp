// src/verify/detectors/pixels.ts
import type { RawBuffer } from "../ctx.js";

/** Luma (0-255) per pixel. */
export function luma(raw: RawBuffer): Float32Array {
  const { data, width, height } = raw;
  const out = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    out[i] = data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114;
  }
  return out;
}

export interface EdgeStats {
  edgeCoverage: number;
  thinRatio: number;
  rampRatio: number;
}

export const DEGENERATE_COVERAGE = 0.001;
const EDGE_MAGNITUDE = 7;
const STROKE_CONTRAST = 40;

/**
 * Edge classification (validated empirically: 0/32 fixture mismatches).
 * thinRatio = DILATED stroke evidence / all edge pixels; rampRatio = monotonic
 * 4-20px ramps / (ramps + non-stroke thin + wide) — the shadow ring's own tail
 * pixels are thin and would dilute a plain ramp/edges ratio. A degenerate
 * image (no edges) yields edgeCoverage 0 and both ratios 0 — callers abstain.
 */
export function edgeStats(raw: RawBuffer): EdgeStats {
  const { width, height } = raw;
  const L = luma(raw);
  const n = width * height;
  const mag = new Float32Array(n);
  let edgePixels = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const gx = L[i + 1] - L[i - 1];
      const gy = L[i + width] - L[i - width];
      const m = Math.sqrt(gx * gx + gy * gy);
      mag[i] = m;
      if (m > EDGE_MAGNITUDE) edgePixels++;
    }
  }
  if (edgePixels === 0) return { edgeCoverage: 0, thinRatio: 0, rampRatio: 0 };

  const strokeLikeArr = new Uint8Array(n);
  let ramp = 0;
  let otherThin = 0;
  let wide = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (mag[i] <= EDGE_MAGNITUDE) continue;
      const gx = L[i + 1] - L[i - 1];
      const gy = L[i + width] - L[i - width];
      const horiz = Math.abs(gx) >= Math.abs(gy);
      const step = horiz ? 1 : width;
      const dir = (horiz ? gx : gy) >= 0 ? 1 : -1;
      const peak = mag[i];
      // TWO-WAY width: the edge extends in both directions along the gradient.
      // A one-way walk misclassified the shadow's outer ring as thin (the
      // inward half of the ramp was never counted).
      let back = 0;
      for (let k = 1; k <= 24; k++) {
        const j = i - dir * step * k;
        if (j < 0 || j >= n) break;
        if (mag[j] < peak / 2) break;
        back = k;
      }
      let fwd = 0;
      for (let k = 1; k <= 24; k++) {
        const j = i + dir * step * k;
        if (j < 0 || j >= n) break;
        if (mag[j] < peak / 2) break;
        fwd = k;
      }
      const widthPx = 1 + back + fwd;
      const before = i - dir * step;
      const after = i + dir * step;
      const inBounds = before >= 0 && after >= 0 && before < n && after < n;
      // Border stroke: the edge pixel contrasts strongly with BOTH neighbours
      // (a thin line on a surface). Card boundaries and shadow flanks have one
      // quiet side and are NOT stroke-like.
      const strokeLike = inBounds
        && Math.abs(L[i] - L[before]) >= STROKE_CONTRAST
        && Math.abs(L[i] - L[after]) >= STROKE_CONTRAST;
      if (strokeLike) strokeLikeArr[i] = 1;
      if (widthPx <= 3 && !strokeLike) {
        otherThin++;
      } else if (widthPx > 20) {
        wide++;
      } else if (widthPx > 3) {
        // A shadow is a MONOTONIC ramp (luma changes in one direction as it
        // fades); a photo edge usually is not. Check ±2 steps for sign
        // consistency — a shadow is never a stroke, so no strokeLike test here.
        const d1 = L[i] - L[i - dir * step];
        const d2 = L[i + dir * step] - L[i];
        const d3 = i - 2 * dir * step >= 0 && i - 2 * dir * step < n
          ? L[i - dir * step] - L[i - 2 * dir * step]
          : d1;
        const d4 = i + 2 * dir * step >= 0 && i + 2 * dir * step < n
          ? L[i + 2 * dir * step] - L[i + dir * step]
          : d2;
        if (d1 * d2 >= 0 && d2 * d3 >= 0 && d2 * d4 >= 0) ramp++;
      }
    }
  }
  // Dilate stroke evidence: the flanks of a 1px stroke are edge pixels with one
  // quiet neighbour — they count as border evidence when adjacent to a
  // stroke-like pixel, so a stroked card measures ~0.99, not ~0.31.
  let thin = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (mag[i] <= EDGE_MAGNITUDE) continue;
      const gx = L[i + 1] - L[i - 1];
      const gy = L[i + width] - L[i - width];
      const horiz = Math.abs(gx) >= Math.abs(gy);
      const step = horiz ? 1 : width;
      if (strokeLikeArr[i] || strokeLikeArr[i - step] || strokeLikeArr[i + step]
        || strokeLikeArr[i - width] || strokeLikeArr[i + width]) thin++;
    }
  }
  return {
    edgeCoverage: edgePixels / n,
    thinRatio: thin / edgePixels,
    // Ramp share of NON-STROKE edges: boundary edges are the honest
    // counterfactual for "is this edge content shadow-like".
    rampRatio: ramp / Math.max(ramp + otherThin + wide, 1),
  };
}

/**
 * Maps a measurement vs a decision threshold to 0..1 where 0.5 = exactly on the
 * threshold (maximally ambiguous) and 0 / 1 = decisively on one side.
 */
export function boundaryConfidence(value: number, threshold: number): number {
  const span = 2 * Math.max(threshold, 1 - threshold);
  return Math.min(1, Math.max(0, 0.5 + (value - threshold) / span));
}

// culori ships no type declarations (TS7016); usage is typed at the call site.
// @ts-expect-error — no bundled or @types declaration exists for culori.
import { differenceCiede2000 } from "culori";

const CIEDE = differenceCiede2000();

/** Parses `#rrggbb`; throws on anything else. */
export function parseHex(hex: string): [number, number, number] {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) throw new Error(`malformed hex ${hex}`);
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function rgbToHex(rgb: [number, number, number]): string {
  return `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
}

/** CIEDE2000 distance between two RGB colours (culori). */
export function deltaE2000(a: [number, number, number], b: [number, number, number]): number {
  return CIEDE(rgbToHex(a), rgbToHex(b));
}

export interface ColorStats {
  total: number;
  matchCount: number;
  background: [number, number, number];
  backgroundCount: number;
  largestNonBg: { rgb: [number, number, number]; count: number } | null;
}

// 8-bit channel >> 3 keeps the top 5 bits: 32 levels per channel. The packing
// shifts MUST therefore be 10/5/0 — one full 5-bit field each. An earlier draft
// shifted 6/3/0, which overlaps the red field (bits 6-10) with the green field
// (bits 3-7): rgb(8,0,0) and rgb(0,64,0) both key to 64, so unrelated dark reds
// and greens merge into one bucket whose AVERAGE matches neither. That silently
// corrupts `background`, `largestNonBg`, `matchCount`, `largestComponent` and
// `componentsOf` — every consumer below. It is invisible on the synthetic
// fixtures (greys plus two well-separated hexes), so no test would catch it.
//
// 32 levels is also the granularity the detectors need: at 8 levels per channel
// (>> 5) #f5f5f5 and #ffffff both bucket to 7 and the colorRoles canvas check
// could never distinguish a near-white surface from white.
const BUCKET_BITS = 3;
const BUCKET_SHIFT_R = 10;
const BUCKET_SHIFT_G = 5;

/** The single bucket-key definition. Every consumer uses THIS — see the note above. */
export function bucketKey(r: number, g: number, b: number): number {
  return ((r >> BUCKET_BITS) << BUCKET_SHIFT_R)
    | ((g >> BUCKET_BITS) << BUCKET_SHIFT_G)
    | (b >> BUCKET_BITS);
}

/**
 * Colour statistics via coarse buckets (fast: one pass, no per-pixel ΔE).
 * `matchCount` = pixels within `tolerance` ΔE of `target`; `background` = the
 * largest bucket; `largestNonBg` = the largest bucket clearly distinct from it.
 */
export function colorStats(raw: RawBuffer, target: [number, number, number], tolerance: number): ColorStats {
  const { data, width, height } = raw;
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const key = bucketKey(r, g, b);
    const bk = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    bk.count++;
    bk.r += r;
    bk.g += g;
    bk.b += b;
    buckets.set(key, bk);
  }
  let bgKey = -1;
  let bgCount = 0;
  for (const [key, bk] of buckets) {
    if (bk.count > bgCount) { bgCount = bk.count; bgKey = key; }
  }
  const bg = buckets.get(bgKey)!;
  const background: [number, number, number] = [
    Math.round(bg.r / bg.count),
    Math.round(bg.g / bg.count),
    Math.round(bg.b / bg.count),
  ];
  let matchCount = 0;
  let largestNonBg: ColorStats["largestNonBg"] = null;
  for (const [key, bk] of buckets) {
    const rgb: [number, number, number] = [
      Math.round(bk.r / bk.count),
      Math.round(bk.g / bk.count),
      Math.round(bk.b / bk.count),
    ];
    if (deltaE2000(rgb, target) <= tolerance) matchCount += bk.count;
    if (key === bgKey) continue;
    if (deltaE2000(rgb, background) > tolerance * 2 && (!largestNonBg || bk.count > largestNonBg.count)) {
      largestNonBg = { rgb, count: bk.count };
    }
  }
  return { total: width * height, matchCount, background, backgroundCount: bgCount, largestNonBg };
}

export interface ComponentBox {
  x: number;
  y: number;
  width: number;
  height: number;
  area: number;
}

// `bucketKey` is defined ONCE, in the Task 7 block above (exported). Do NOT
// redeclare it here: an earlier draft had two copies with different shifts, and
// the second one silently corrupted every component/background consumer in this
// task and Task 9. It is already in scope in this file.

/** The most common colour bucket — treated as the image background. */
export function backgroundBucketKey(raw: RawBuffer): number {
  const { data, width, height } = raw;
  const counts = new Map<number, number>();
  for (let i = 0; i < width * height; i++) {
    const key = bucketKey(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let bestKey = -1;
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) { bestCount = count; bestKey = key; }
  }
  return bestKey;
}

/** The largest connected region of non-background pixels (4-connectivity BFS). */
export function largestComponent(raw: RawBuffer): ComponentBox | null {
  const { data, width, height } = raw;
  const n = width * height;
  const bgKey = backgroundBucketKey(raw);
  const visited = new Uint8Array(n);
  let best: ComponentBox | null = null;
  for (let start = 0; start < n; start++) {
    if (visited[start]) continue;
    const startKey = bucketKey(data[start * 4], data[start * 4 + 1], data[start * 4 + 2]);
    if (startKey === bgKey) { visited[start] = 1; continue; }
    let area = 0;
    let minX = width, minY = height, maxX = -1, maxY = -1;
    const queue = [start];
    visited[start] = 1;
    while (queue.length > 0) {
      const i = queue.pop()!;
      area++;
      const x = i % width;
      const y = (i / width) | 0;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      for (const j of [i - 1, i + 1, i - width, i + width]) {
        if (j < 0 || j >= n || visited[j]) continue;
        if (bucketKey(data[j * 4], data[j * 4 + 1], data[j * 4 + 2]) === bgKey) {
          visited[j] = 1;
          continue;
        }
        visited[j] = 1;
        queue.push(j);
      }
    }
    if (!best || area > best.area) {
      best = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, area };
    }
  }
  return best;
}

export interface CornerMeasure {
  radius: number;
  consistency: number;
}

/**
 * Corner radius estimate via EDGE INSET. From each bounding-box corner, walk
 * inward along each of the two box edges, counting background pixels until the
 * first foreground pixel. For a rounded corner radius r the inset is r (±1px);
 * for a sharp corner it is 0. Mean over all 8 edge samples = radius.
 *
 * The previous diagonal walk was a bug: it walked `(cx+k, cy+k)` UNIFORMLY, so
 * for the top-right and bottom-left corners it headed OUTWARD, hit the image
 * edge at k=32, and every rounded fixture abstained on "corners disagree".
 */
export function cornerMeasure(raw: RawBuffer, box: ComponentBox): CornerMeasure {
  const { data, width, height } = raw;
  const bgKey = backgroundBucketKey(raw);
  const isBg = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= width || y >= height) return true;
    const i = (y * width + x) * 4;
    return bucketKey(data[i], data[i + 1], data[i + 2]) === bgKey;
  };
  const right = box.x + box.width - 1;
  const bottom = box.y + box.height - 1;
  const corners: Array<{ x: number; y: number; dx: number; dy: number }> = [
    { x: box.x, y: box.y, dx: 1, dy: 1 },     // top-left: inward is +x, +y
    { x: right, y: box.y, dx: -1, dy: 1 },    // top-right: inward is -x, +y
    { x: box.x, y: bottom, dx: 1, dy: -1 },   // bottom-left: inward is +x, -y
    { x: right, y: bottom, dx: -1, dy: -1 },  // bottom-right: inward is -x, -y
  ];
  const insets: number[] = [];
  for (const c of corners) {
    let kx = 0;
    while (kx < 32 && isBg(c.x + c.dx * kx, c.y)) kx++;
    insets.push(kx);
    let ky = 0;
    while (ky < 32 && isBg(c.x, c.y + c.dy * ky)) ky++;
    insets.push(ky);
  }
  const avg = insets.reduce((a, b) => a + b, 0) / insets.length;
  const radius = avg; // edge inset IS the radius (±1px) — no diagonal factor
  const spread = Math.max(...insets) - Math.min(...insets);
  const consistency = Math.max(0, 1 - spread / Math.max(avg, 1));
  return { radius, consistency };
}
