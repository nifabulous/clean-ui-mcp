import { describe, expect, it } from "vitest";
import { listFromAllowedWithRejects } from "./taxonomy-candidates.js";

describe("listFromAllowedWithRejects", () => {
  it("keeps allowed values and reports unknown values instead of dropping them", () => {
    expect(listFromAllowedWithRejects(
      [" dashboard ", "activity-feed", "dashboard"],
      ["dashboard", "settings"],
      4,
    )).toEqual({
      values: ["dashboard"],
      rejected: ["activity-feed"],
    });
  });

  it("reports every distinct unknown string even when accepted values hit the cap", () => {
    expect(listFromAllowedWithRejects(
      ["dashboard", "unknown-a", "unknown-b", "unknown-a", "settings"],
      ["dashboard", "settings"],
      1,
    )).toEqual({
      values: ["dashboard"],
      rejected: ["unknown-a", "unknown-b"],
    });
  });

  it("does not turn a missing or malformed model field into a taxonomy claim", () => {
    expect(listFromAllowedWithRejects(undefined, ["dashboard"], 4)).toEqual({ values: [], rejected: [] });
    expect(listFromAllowedWithRejects("dashboard", ["dashboard"], 4)).toEqual({ values: [], rejected: [] });
    expect(listFromAllowedWithRejects([null, 42, ""], ["dashboard"], 4)).toEqual({ values: [], rejected: [] });
  });
});
