// src/verify/detectors/accessibility-risks.test.ts
import { describe, expect, it } from "vitest";
import { detect } from "./accessibility-risks.js";
import type { CorpusEntryT } from "../../schema.js";

// Mirrors the REAL AccessibilityRisk shape (schema.ts:227-233): `wcag` is a
// required canonical-ID array, and `evidence`/`confidence` are required too.
// The detector reads `wcag` and `element`, never the prose.
type TestRisk = { element: string; risk: string; evidence: string; confidence: "visible" | "inferred" | "dom-grounded"; wcag: string[] };
const RISK_ROLES = { canvas: "#ffffff", surface: "#ffffff", ink: "#111111", muted: "#9ca3af", accent: "#0000ff" };
function entry(risks: TestRisk[], roles: Record<string, string | null> = RISK_ROLES): CorpusEntryT {
  return {
    id: "t", title: "t", patternType: "dashboard", colorScheme: "light",
    categories: ["dashboard"], styleTags: ["minimal"], components: [],
    layout: { form: "single-column", regions: [] },
    visual: {
      dominantColors: [], accentColor: null,
      typePairing: { display: null, body: null },
      spacingDensity: "moderate", cornerStyle: "sharp",
      usesShadows: false, usesBorders: false,
      colorRoles: roles,
    },
    antiPatterns: { antiPatterns: [], whereThisFails: null, accessibilityRisks: risks },
    critique: "", whatToSteal: [], voice: null, mood: null,
    platform: "web", qualityScore: 1, qualityTier: "exceptional",
  } as CorpusEntryT;
}

describe("accessibilityRisks detector (contradiction-only)", () => {
  const risk = (element: string, wcag: string[]): TestRisk =>
    ({ element, risk: `${element} contrast is insufficient for readers`, evidence: "visual inspection", confidence: "visible", wcag });

  it("contradicts a 1.4.3 claim on ink/canvas that actually measures ~19:1", async () => {
    // ink #111111 on canvas #ffffff. The criterion comes from wcag[], the colours
    // from colorRoles — neither is parsed out of the prose, which carries neither.
    const r = await detect(entry([risk("body text", ["1.4.3"])]), null as never);
    expect(r.verdict).toBe("contradicted");
    expect((r.measured as { ratio: number }).ratio).toBeGreaterThan(5);
  });

  it("abstains on a genuine low-contrast muted/canvas pair (not disproven)", async () => {
    // muted #9ca3af on #ffffff is ~2.5:1 — the recorded risk is plausible, so the
    // detector must NOT contradict it.
    const r = await detect(entry([risk("muted label", ["1.4.3"])]), null as never);
    expect(r.verdict).toBe("abstain");
  });

  it("contradicts a false 1.4.11 non-text claim on accent/canvas", async () => {
    const r = await detect(entry([risk("button", ["1.4.11"])]), null as never);
    expect(r.verdict).toBe("contradicted");
  });

  it("abstains on a hit-target risk — no contrast criterion in wcag[]", async () => {
    const r = await detect(entry([risk("button", ["2.5.8"])]), null as never);
    expect(r.verdict).toBe("abstain");
  });

  it("abstains when the element does not resolve to a role pair", async () => {
    const r = await detect(entry([risk("decorative divider", ["1.4.3"])]), null as never);
    expect(r.verdict).toBe("abstain");
  });

  it("abstains when colorRoles cannot supply the pair (muted is nullable)", async () => {
    const r = await detect(
      entry([risk("muted label", ["1.4.3"])], { ...RISK_ROLES, muted: null }),
      null as never,
    );
    expect(r.verdict).toBe("abstain");
  });

  it("NEVER contradicts by reading the prose — a criterion only in the text is ignored", async () => {
    // Guards the regression this task fixes: 0 of 11 real risks name a criterion
    // in the prose, so a prose-reading detector abstains on the whole corpus while
    // passing synthetic-string tests.
    const proseOnly: TestRisk = {
      element: "body text", risk: "text #111111 on #ffffff fails WCAG 1.4.3",
      evidence: "visual inspection", confidence: "visible", wcag: ["2.5.8"],
    };
    const r = await detect(entry([proseOnly]), null as never);
    expect(r.verdict).toBe("abstain");
  });

  it("abstains when no risks are recorded", async () => {
    const r = await detect(entry([]), null as never);
    expect(r.verdict).toBe("abstain");
  });
});
