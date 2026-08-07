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
