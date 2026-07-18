import { describe, expect, it } from "vitest";
import { parsePublicSnapshot } from "./public-entry";

describe("parsePublicSnapshot — synthetic empty state", () => {
  it("accepts the corpus-free synthetic snapshot", () => {
    expect(parsePublicSnapshot({
      count: 0,
      generatedAt: "2026-07-18T00:00:00.000Z",
      categories: [],
      styleTags: [],
      entries: [],
    }).entries).toEqual([]);
  });
});
