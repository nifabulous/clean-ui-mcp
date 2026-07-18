import { describe, expect, it } from "vitest";
import { validSourceSnapshot } from "./contracts.test.js";
import { renderSourceDesign } from "./render.js";

describe("renderSourceDesign", () => {
  it("is byte-deterministic and distinguishes observation from prescription", () => {
    const first = renderSourceDesign(validSourceSnapshot);
    const second = renderSourceDesign(structuredClone(validSourceSnapshot));
    expect(first).toBe(second);
    expect(first).toContain("# SOURCE-DESIGN.md");
    expect(first).toContain("Observed source, not target design authority");
    expect(first).toContain("https://example.com/");
    expect(first).toContain("#ffffff");
  });
});
