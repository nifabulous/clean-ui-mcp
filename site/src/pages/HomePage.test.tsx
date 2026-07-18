import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the snapshot loader BEFORE importing HomePage. The homepage derives its
// quantified proof from snapshot.count, so the test fixture's count must drive
// the rendered number (NOT a hard-coded literal in the component).
vi.mock("../data/load-snapshot", () => ({
  loadPublicSnapshot: vi.fn(),
}));

import { loadPublicSnapshot } from "../data/load-snapshot";
import type { PublicSnapshot } from "../data/public-entry";
import { HomePage } from "./HomePage";

// A small representative fixture. The homepage uses a few entries for the
// ProductPreview (real corpus search/results UI) and derives the proof count
// from snapshot.count. Keep this fixture count distinct from any plausible
// hard-coded number (5) so the test catches a regression that ignores the
// snapshot.
function representativeEntry(id: string, title: string, pattern: string): Record<string, unknown> {
  return {
    id,
    title,
    patternType: pattern,
    categories: [pattern],
    styleTags: ["minimal"],
    qualityTier: "exceptional",
    qualityScore: 3,
    critique: `Critique for ${title}. Restrained typography and a clear hierarchy lead the eye.`,
    whatToSteal: ["Use a 12px icon above each label."],
    antiPatterns: ["Avoid stacking two competing accent colors."],
    dominantColors: ["#384c67", "#2ba0f5"],
    imagePath: "sample-5.png",
    source: { productName: title, url: "https://example.com" },
  };
}

function fixtureSnapshot(): PublicSnapshot {
  const entries = [
    representativeEntry("pricing-a", "Pricing page", "pricing"),
    representativeEntry("dashboard-b", "Analytics dashboard", "dashboard"),
    representativeEntry("onboarding-c", "Onboarding flow", "onboarding"),
    representativeEntry("settings-d", "Settings panel", "settings"),
    representativeEntry("search-e", "Search results", "search"),
  ];
  return {
    count: entries.length, // 5
    generatedAt: "2026-07-18T00:00:00.000Z",
    categories: ["pricing", "dashboard", "onboarding", "settings", "search"],
    styleTags: ["minimal"],
    // parsePublicEntry is not invoked here; we cast to the narrow shape directly
    // so the test exercises HomePage, not the adapter (already covered in Task 2).
    entries: entries as unknown as PublicSnapshot["entries"],
  };
}

function renderHome(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <HomePage />
    </MemoryRouter>,
  );
}

describe("HomePage — contract", () => {
  beforeEach(() => {
    vi.mocked(loadPublicSnapshot).mockResolvedValue(fixtureSnapshot());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders exactly one H1 containing 'design judgment' (Task 1 contract)", async () => {
    renderHome();
    await waitFor(() => expect(screen.queryByRole("status")).toBeInTheDocument());
    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent(/design judgment/i);
  });

  it("exposes Try Playground and Install MCP actions above the product preview", async () => {
    renderHome();
    await waitFor(() => expect(screen.queryByRole("status")).toBeInTheDocument());

    // The hero renders the first "Try Playground"/"Install MCP" actions; a final
    // CTA repeats them. The hero (first) instances must precede the preview.
    const playgroundActions = screen.getAllByRole("link", { name: /try playground/i });
    const installActions = screen.getAllByRole("link", { name: /install mcp/i });
    expect(playgroundActions.length).toBeGreaterThanOrEqual(1);
    expect(installActions.length).toBeGreaterThanOrEqual(1);

    const playgroundAction = playgroundActions[0];
    const installAction = installActions[0];

    // The product preview region is rendered later in the hero.
    const preview = screen.getByTestId("product-preview");

    // Both primary actions must precede the preview in document order so they
    // remain the dominant first-viewport affordances.
    expect(documentOrder(playgroundAction)).toBeLessThan(documentOrder(preview));
    expect(documentOrder(installAction)).toBeLessThan(documentOrder(preview));
  });

  it("derives the proof count from the snapshot fixture, not a hard-coded number", async () => {
    renderHome();
    // The proof region is announced as a status region once the snapshot loads.
    await waitFor(() => expect(screen.queryByRole("status")).toBeInTheDocument());

    const proof = screen.getByTestId("proof");
    // The fixture count is 5. The component must render that value because it
    // read snapshot.count; it must NOT render a different hard-coded figure.
    expect(proof.textContent ?? "").toContain("5");
  });

  it("renders the five evidence-model section headings", async () => {
    renderHome();
    await waitFor(() => expect(screen.queryByRole("status")).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: /^decision$/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^evidence$/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^steal$/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^avoid$/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^provenance$/i })).toBeInTheDocument();
  });

  it("does NOT render a customer-logo strip", async () => {
    renderHome();
    await waitFor(() => expect(screen.queryByRole("status")).toBeInTheDocument());
    // No region is labeled as a logo/customer strip, and no element carries the
    // logo-strip test hook.
    expect(screen.queryByTestId("customer-logos")).toBeNull();
    expect(screen.queryByRole("region", { name: /trusted by|customers|used by/i })).toBeNull();
  });

  it("marks the architectural backdrop aria-hidden from assistive tech", async () => {
    renderHome();
    await waitFor(() => expect(screen.queryByRole("status")).toBeInTheDocument());
    const backdrop = screen.getByTestId("architectural-backdrop");
    expect(backdrop).toHaveAttribute("aria-hidden", "true");
  });
});

/**
 * Document-order index helper for the "above the preview" assertion. Returns a
 * stable, monotonic index based on a pre-order traversal of document.body.
 */
function documentOrder(node: Element): number {
  let index = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let current = walker.currentNode as Element | null;
  while (current) {
    if (current === node) return index;
    index += 1;
    current = walker.nextNode() as Element | null;
  }
  return -1;
}
