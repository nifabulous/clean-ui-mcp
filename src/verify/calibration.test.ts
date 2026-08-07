// src/verify/calibration.test.ts
import { describe, expect, it } from "vitest";
import { fixtureManifest } from "./__fixtures__/fixtures.js";
import { calibrate, assertGate, heldOutLock, heldOutHash } from "./calibration.js";
import { detectorRegistry } from "./detector-registry.js";

describe("calibration gate", () => {
  it("measures held-out accuracy and asserts every enabled certifying detector clears its floor", async () => {
    const manifest = fixtureManifest();
    const result = await calibrate(manifest, "held-out");
    const failing = assertGate(result, detectorRegistry);
    expect(failing).toEqual([]);
  });

  it("never gates on the tune set", async () => {
    const manifest = fixtureManifest();
    const tune = await calibrate(manifest, "tune");
    expect(tune.accuracy).toBeGreaterThanOrEqual(0);
    expect(tune.rows.length).toBeGreaterThan(0);
  });
});

describe("held-out integrity — the anti-circularity guards", () => {
  // These four tests are the ONLY thing standing between this gate and the
  // circularity the first draft of this plan shipped: held-out fixtures that
  // were run during tuning and then edited until the detectors passed.

  it("held-out manifest matches the lock, so the set cannot move quietly", () => {
    const locked = heldOutLock();
    expect(
      heldOutHash(fixtureManifest()),
      "HELD-OUT SET CHANGED. Do not update the lock to make this pass. Either revert "
      + "the fixture change, or (if the set genuinely needed to grow) re-run "
      + "`npm run calibrate-detectors` on real screenshots, re-declare every floor "
      + "from those numbers, and update held-out-lock.json in the SAME commit so a "
      + "reviewer sees both moved together.",
    ).toBe(locked.manifestHash);
  });

  it("the locked floors match the registry's declared floors", () => {
    const locked = heldOutLock();
    for (const [field, entry] of Object.entries(detectorRegistry)) {
      if (entry.category !== "certifying" || entry.disabled) continue;
      expect(entry.accuracyFloor, `floor for ${field} drifted from the lock`)
        .toBe(locked.floors[field]);
    }
  });

  it("every enabled certifying detector has an adequate held-out set", () => {
    const heldOut = fixtureManifest().fixtures.filter((f) => f.split === "held-out");
    for (const [field, entry] of Object.entries(detectorRegistry)) {
      if (entry.category !== "certifying" || entry.disabled) continue;
      const forField = heldOut.filter((f) => f.field === field);
      const labels = forField.map((f) => f.label);
      // An all-`pass` held-out set cannot distinguish a working detector from one
      // that returns `pass` unconditionally.
      expect(forField.length, `${field}: needs >=4 held-out fixtures, has ${forField.length}`)
        .toBeGreaterThanOrEqual(4);
      expect(labels, `${field}: held-out has no positive case`).toContain("pass");
      expect(labels, `${field}: held-out has no negative case — an all-positive set certifies nothing`)
        .toContain("contradicted");
    }
  });

  it("tune and held-out never share an image file", () => {
    const m = fixtureManifest().fixtures;
    const tuneFiles = new Set(m.filter((f) => f.split === "tune" && f.file).map((f) => f.file));
    const shared = m
      .filter((f) => f.split === "held-out" && f.file && tuneFiles.has(f.file))
      .map((f) => f.id);
    expect(shared, "a fixture image reused across splits is not held out").toEqual([]);
  });
});
