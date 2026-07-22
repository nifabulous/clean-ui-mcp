import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("clean-checkout build ordering", () => {
  it("compiles dist before validators that import compiled modules", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const steps = pkg.scripts.build.split("&&").map((step) => step.trim());
    const firstCompile = steps.findIndex((step) => step === "tsc");
    const baselineValidation = steps.findIndex((step) => step === "npm run validate:c2-baseline");

    expect(firstCompile).toBeGreaterThanOrEqual(0);
    expect(baselineValidation).toBeGreaterThan(firstCompile);
  });
});
