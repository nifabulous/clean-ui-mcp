import { describe, expect, it } from "vitest";
import { DesignSourceSnapshotSchema } from "./contracts.js";

export const validSourceSnapshot = {
  schemaVersion: "1.0",
  artifactType: "design-source-snapshot",
  artifactId: "source_acme_001",
  projectId: "project_001",
  source: { kind: "user-supplied-public-reference", origin: "https://example.com", startingUrls: ["https://example.com/"] },
  capturedAt: "2026-07-18T00:00:00.000Z",
  crawl: { maxRoutes: 25, sameOrigin: true, authenticated: false, mutationAllowed: false },
  coverage: [{ url: "https://example.com/", status: "inspected", reason: "user-supplied", archetype: "landing-page", viewports: ["desktop", "mobile"] }],
  foundations: {
    colors: [{ id: "color.canvas", value: "#ffffff", role: "canvas", confidence: "high", evidenceIds: ["dom:home:color:0"] }],
    typography: [], spacing: [], radii: [], shadows: [], layout: [],
  },
  components: [],
  responsiveFindings: [],
  accessibility: [],
  motion: [],
  voice: [],
  evidence: [{ id: "dom:home:color:0", kind: "dom-signal", route: "https://example.com/", summary: "Computed body background", basis: "dom-grounded" }],
  limitations: [],
};

describe("DesignSourceSnapshotSchema", () => {
  it("accepts a provenance-complete public source snapshot", () => {
    expect(DesignSourceSnapshotSchema.parse(validSourceSnapshot)).toEqual(validSourceSnapshot);
  });

  it("rejects authenticated or mutating initial captures", () => {
    expect(() => DesignSourceSnapshotSchema.parse({ ...validSourceSnapshot, crawl: { ...validSourceSnapshot.crawl, authenticated: true } })).toThrow();
    expect(() => DesignSourceSnapshotSchema.parse({ ...validSourceSnapshot, crawl: { ...validSourceSnapshot.crawl, mutationAllowed: true } })).toThrow();
  });

  it("rejects findings whose evidence IDs do not resolve", () => {
    const broken = structuredClone(validSourceSnapshot);
    broken.foundations.colors[0].evidenceIds = ["missing"];
    expect(() => DesignSourceSnapshotSchema.parse(broken)).toThrow(/evidence/i);
  });
});
