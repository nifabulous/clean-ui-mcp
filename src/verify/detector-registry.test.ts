// src/verify/detector-registry.test.ts
import { describe, expect, it } from "vitest";
import { TIER_BY_FIELD, tierForField } from "../scripts/verify-corpus.js";
import { detectorRegistry } from "./detector-registry.js";

describe("detector registry contract", () => {
  const mechanicalFields = Object.entries(TIER_BY_FIELD)
    .filter(([, tier]) => tier === "mechanical")
    .map(([field]) => field);

  it("every mechanical field has a registered certifying detector", () => {
    for (const field of mechanicalFields) {
      const det = detectorRegistry[field];
      expect(det, `no detector for mechanical field ${field}`).toBeDefined();
      if (det && !det.disabled) {
        expect(det.category, `${field} is mechanical but its detector is not certifying`).toBe("certifying");
      }
    }
  });

  it("every certifying detector's field is mechanical (disabled exempt)", () => {
    for (const [field, det] of Object.entries(detectorRegistry)) {
      if (det.disabled) continue;
      if (det.category === "certifying") {
        expect(tierForField(field), `${field} has a certifying detector but is not mechanical`).toBe("mechanical");
      } else {
        expect(tierForField(field), `${field} is contradiction-only but classified mechanical`).not.toBe("mechanical");
      }
      expect(typeof det.canAffirm, `${field} declares canAffirm`).toBe("function");
    }
  });

  it("value-dependence boundary: false shadow/border claims are never affirmable", () => {
    expect(detectorRegistry["visual.usesShadows"].canAffirm(false)).toBe(false);
    expect(detectorRegistry["visual.usesShadows"].canAffirm(true)).toBe(true);
    expect(detectorRegistry["visual.usesBorders"].canAffirm(false)).toBe(false);
    expect(detectorRegistry["visual.cornerStyle"].canAffirm("mixed")).toBe(false);
    expect(detectorRegistry["visual.cornerStyle"].canAffirm("slight-round")).toBe(true);
    expect(detectorRegistry["visual.colorRoles"].canAffirm({})).toBe(false);
  });
});
