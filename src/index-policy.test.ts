import { describe, expect, it } from "vitest";
import { isTextIndexEligible } from "./index-policy.js";

describe("text index eligibility", () => {
  it("indexes approved entries", () => {
    expect(isTextIndexEligible({ reviewStatus: "approved" })).toBe(true);
  });

  it("treats omitted review status as legacy approved", () => {
    expect(isTextIndexEligible({})).toBe(true);
  });

  it("excludes pending drafts from the retrieval index", () => {
    expect(isTextIndexEligible({ reviewStatus: "draft" })).toBe(false);
  });
});
