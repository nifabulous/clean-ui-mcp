import { describe, expect, it, vi } from "vitest";

vi.mock("../tagger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tagger.js")>();
  return {
    ...actual,
    tagImage: vi.fn(async () => ({
      critique: "critique",
      whatToSteal: ["steal"],
      antiPatterns: { antiPatterns: ["pattern"], whereThisFails: null, accessibilityRisks: [] },
      voice: { tone: "tone", examples: [], avoid: [] },
    })),
  };
});

import { makeReproduceDependency } from "./verify-corpus.js";
import { tagImage } from "../tagger.js";
import type { CorpusEntryT } from "../schema.js";

describe("re-produce sampling pin", () => {
  it("threads the pinned sampling into tagImage", async () => {
    const reproduce = makeReproduceDependency();
    const entry = {
      id: "t", title: "t", patternType: "dashboard", colorScheme: "light",
      categories: ["dashboard"], styleTags: [], components: [],
      layout: { form: "single-column", regions: [] },
      visual: {
        dominantColors: [], accentColor: null,
        typePairing: { display: null, body: null },
        spacingDensity: "moderate", cornerStyle: "sharp",
        usesShadows: false, usesBorders: false,
      },
      antiPatterns: { antiPatterns: [], whereThisFails: null, accessibilityRisks: [] },
      critique: "a", whatToSteal: [], voice: null, mood: null,
      platform: "web", qualityScore: 1, qualityTier: "exceptional",
      image: { visibility: "private", path: "images-private/x.png", width: 100, height: 80 },
    } as CorpusEntryT;
    await reproduce(entry, "images-private/x.png");
    expect(tagImage).toHaveBeenCalledTimes(1);
    expect((tagImage as ReturnType<typeof vi.fn>).mock.calls[0][0].sampling).toEqual({ temperature: 0 });
  });
});
