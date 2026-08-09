import { describe, expect, it } from "vitest";
import { entryToDocument, entryToTrustedDocument } from "./embeddings.js";

describe("entryToDocument", () => {
  it("includes visible component tags as structural retrieval signal", () => {
    const doc = entryToDocument({
      title: "Newsroom Dashboard",
      patternType: "dashboard",
      categories: ["dashboard", "navigation"],
      styleTags: ["dense-data"],
      components: ["sidebar-nav", "kpi-card", "donut-chart", "line-chart", "report-list"],
      domainTags: ["integrations"],
      critique: "This dashboard organizes editorial metrics and reports into scan-friendly regions with clear hierarchy.",
      whatToSteal: ["Use KPI cards above charts so operators can read totals before trend detail."],
      antiPatterns: { antiPatterns: ["Avoids hiding operational reports behind a single analytics drawer."] },
      source: { productName: "Newsroom", url: null },
      visual: {
        dominantColors: ["#ffffff", "#111111"],
        accentColor: "#0055cc",
        typePairing: { display: "Inter", body: "Inter", notes: "Compact but readable." },
        spacingDensity: "compact",
        cornerStyle: "slight-round",
        usesShadows: false,
        usesBorders: true,
      },
    });

    expect(doc).toContain("Components: sidebar-nav, kpi-card, donut-chart, line-chart, report-list.");
    expect(doc).toContain("Domain: integrations.");
  });
});

describe("entryToTrustedDocument", () => {
  it("embeds only fields with field-level verification", () => {
    const entry = {
      title: "Unverified title",
      patternType: "dashboard",
      categories: ["dashboard"],
      styleTags: ["minimal"],
      components: ["kpi-card"],
      domainTags: ["billing"],
      colorScheme: "dark",
      industryVertical: "fintech",
      mood: "calm",
      critique: "Verified critique prose.",
      whatToSteal: ["Verified technique."],
      antiPatterns: { antiPatterns: ["Unverified anti-pattern."] },
      source: { productName: "Unverified product", url: null },
      visual: {
        dominantColors: ["#ffffff"], accentColor: null,
        typePairing: { display: null, body: null, notes: "" },
        spacingDensity: "moderate", cornerStyle: "slight-round",
        usesShadows: null, usesBorders: null,
      },
      provenance: {
        taggedBy: "auto",
        verification: {
          categories: { method: "measured" },
          critique: { method: "image-confirmed", imageSha256: "a".repeat(64) },
        },
      },
    } as never;

    const doc = entryToTrustedDocument(entry);
    expect(doc).toContain("Categories: dashboard.");
    expect(doc).toContain("Verified critique prose.");
    expect(doc).not.toContain("Style: minimal.");
    expect(doc).not.toContain("Unverified anti-pattern.");
    expect(doc).not.toContain("Unverified product");
  });
});
