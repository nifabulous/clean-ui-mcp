import type { CorpusEntryT } from "../../schema.js";

/**
 * Hand-built corpus fixtures — schema-valid entries that don't depend on the
 * mutable production entries.json. Tests inject these via setCorpusForTesting()
 * so they're immune to corpus edits, restores, and bulk imports.
 *
 * Covers: dashboard, pricing, empty-state, a cautionary entry, and an
 * image-backed entry — the variety the assertions need.
 */
function entry(overrides: Partial<CorpusEntryT> & { id: string }): CorpusEntryT {
  return {
    title: `${overrides.id} sample`,
    patternType: "dashboard",
    categories: ["dashboard"],
    styleTags: ["minimal"],
    source: { productName: "Test", url: null, capturedAt: "2026-07-01", capturedBy: "self" },
    image: { visibility: "private", path: "", width: null, height: null },
    visual: { dominantColors: ["#ffffff", "#111111"], accentColor: null, typePairing: { display: null, body: null, notes: "n" }, spacingDensity: "moderate", cornerStyle: "slight-round", usesShadows: false, usesBorders: true },
    critique: "This interface uses a direct visual hierarchy to make scanning feel calm and predictable across repeated use.",
    whatToSteal: ["Use quiet grouping and consistent spacing to make dense interfaces easier to scan."],
    antiPatterns: { antiPatterns: ["Avoids heavy card shadows; uses background-color steps for depth."], whereThisFails: [], accessibilityRisks: [] },
    qualityScore: 4, qualityTier: "exceptional", addedAt: "2026-07-01",
    ...overrides,
  } as CorpusEntryT;
}

export const fixtures: CorpusEntryT[] = [
  entry({
    id: "linear-board",
    title: "Linear — Issue board, grouped-by-status",
    source: { productName: "Linear", url: "https://linear.app", capturedAt: "2026-05-10", capturedBy: "self" },
    categories: ["dashboard", "data-table"],
    styleTags: ["minimal", "dense-data"],
    qualityScore: 5,
  }),
  entry({
    id: "stripe-pricing",
    title: "Stripe — Pricing table",
    patternType: "pricing",
    categories: ["pricing"],
    styleTags: ["minimal", "dense-data"],
    source: { productName: "Stripe", url: "https://stripe.com", capturedAt: "2026-06-01", capturedBy: "self" },
    qualityScore: 5,
  }),
  entry({
    id: "origin-empty-state",
    title: "Origin — Empty state",
    patternType: "empty-state",
    categories: ["empty-state"],
    styleTags: ["minimal"],
    source: { productName: "Origin", url: "https://origin.com", capturedAt: "2026-04-15", capturedBy: "self" },
    image: { visibility: "private", path: "images-private/origin-empty.png", width: 1440, height: 900 },
    qualityScore: 4,
  }),
  entry({
    id: "bad-modal-cautionary",
    title: "Cautionary — Modal with low contrast",
    patternType: "modal",
    categories: ["settings"],
    styleTags: ["dense-data"],
    source: { productName: "Example", url: null, capturedAt: "2026-03-01", capturedBy: "self" },
    qualityScore: 2,
    qualityTier: "cautionary",
  }),
  entry({
    id: "hume-chat",
    title: "Hume — Chat interface",
    patternType: "chat-interface",
    categories: ["chat-interface"],
    styleTags: ["minimal", "playful"],
    source: { productName: "Hume", url: "https://hume.ai", capturedAt: "2026-07-01", capturedBy: "self" },
    qualityScore: 4,
  }),
];
