import { describe, expect, it } from "vitest";
import { entryToDocument } from "./embeddings.js";

describe("entryToDocument", () => {
  it("includes visible component tags as structural retrieval signal", () => {
    const doc = entryToDocument({
      title: "Newsroom Dashboard",
      patternType: "dashboard",
      categories: ["dashboard", "navigation"],
      styleTags: ["dense-data"],
      components: ["sidebar-nav", "kpi-card", "donut-chart", "line-chart", "report-list"],
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
  });
});
