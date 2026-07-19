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

  // P1 #3: the schema requires `crawl.sameOrigin: true` but previously did not
  // verify that startingUrls, coverage URLs, and evidence routes actually share
  // `source.origin`. A snapshot could declare same-origin while carrying
  // observations from unrelated origins. The superRefine now recomputes the
  // origin tuple and rejects any off-origin URL.
  it("rejects an off-origin starting URL despite sameOrigin: true (P1 #3)", () => {
    const off = structuredClone(validSourceSnapshot);
    off.source.startingUrls = ["https://other-origin.test/"];
    expect(() => DesignSourceSnapshotSchema.parse(off)).toThrow(/not same-origin/);
  });

  it("rejects an off-origin coverage URL (P1 #3)", () => {
    const off = structuredClone(validSourceSnapshot);
    off.coverage = [{ ...off.coverage[0], url: "https://other-origin.test/page" }];
    expect(() => DesignSourceSnapshotSchema.parse(off)).toThrow(/not same-origin/);
  });

  it("rejects an off-origin evidence route (P1 #3)", () => {
    const off = structuredClone(validSourceSnapshot);
    off.evidence = [{ ...off.evidence[0], route: "https://other-origin.test/obs" }];
    expect(() => DesignSourceSnapshotSchema.parse(off)).toThrow(/not same-origin/);
  });

  // P1 #3 (companion): duplicate evidence IDs collapse into a single Set entry,
  // so a finding's evidenceIds reference could point ambiguously at two records.
  it("rejects duplicate evidence IDs (P1 #3)", () => {
    const dup = structuredClone(validSourceSnapshot);
    dup.evidence = [
      { id: "dom:home:color:0", kind: "dom-signal", route: "https://example.com/", summary: "first", basis: "dom-grounded" },
      { id: "dom:home:color:0", kind: "css-declaration", route: "https://example.com/", summary: "second", basis: "declared" },
    ];
    expect(() => DesignSourceSnapshotSchema.parse(dup)).toThrow(/duplicate evidence ID/);
  });
});
