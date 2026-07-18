/* eslint-disable @typescript-eslint/no-explicit-any */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../data/load-snapshot", () => ({
  loadPublicSnapshot: vi.fn(),
}));

import { loadPublicSnapshot } from "../data/load-snapshot";
import type { PublicSnapshot } from "../data/public-entry";
import { EvidencePage } from "./EvidencePage";

function entry(): Record<string, unknown> {
  return {
    id: "pricing-a",
    title: "Pricing page",
    patternType: "pricing",
    categories: ["pricing"],
    styleTags: ["minimal", "editorial"],
    qualityTier: "exceptional",
    qualityScore: 3,
    critique:
      "The pricing tier cards use a single accent for the recommended plan. ZZZ_FULL_CRITIQUE_BODY_ZZZ is the secret marker that proves the full critique renders here.",
    critiqueExcerpt: "Short excerpt for the pricing page.",
    whatToSteal: ["Place a 12px icon above each tier label.", "Use a single accent for the recommended plan."],
    antiPatterns: ["Avoid stacking two competing accent colors across tiers."],
    dominantColors: ["#384c67", "#2ba0f5"],
    colorRoles: { canvas: "#f3f6fb", surface: "#ffffff", ink: "#0b2348" },
    accent: "#2ba0f5",
    imagePath: "pricing-a.png",
    source: {
      productName: "Acme",
      url: "https://acme.example.com/pricing",
    },
  };
}

function fixtureSnapshot(): PublicSnapshot {
  return {
    count: 1,
    generatedAt: "2026-07-18T00:00:00.000Z",
    categories: ["pricing"],
    styleTags: ["minimal", "editorial"],
    entries: [entry() as unknown as PublicSnapshot["entries"][number]],
  };
}

function renderEvidence(path = "/evidence/pricing-a"): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/evidence/:entryId" element={<EvidencePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Install a controllable `navigator.clipboard` for the copy-action test. */
function installClipboard(value: unknown): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    writable: true,
    value,
  });
}

describe("EvidencePage — contract", () => {
  beforeEach(() => {
    vi.mocked(loadPublicSnapshot).mockResolvedValue(fixtureSnapshot());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    installClipboard(undefined);
  });

  it("renders the structured sections (Decision, Evidence, Steal, Avoid, Accessibility, Provenance)", async () => {
    renderEvidence();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /pricing page/i })).toBeInTheDocument(),
    );

    for (const name of [
      /^decision$/i,
      /^evidence$/i,
      /^steal$/i,
      /^avoid$/i,
      /^accessibility$/i,
      /^provenance$/i,
    ]) {
      expect(screen.getByRole("heading", { name })).toBeInTheDocument();
    }

    // The full critique body renders here (it's the "evidence"/decision content).
    expect(screen.getByText(/ZZZ_FULL_CRITIQUE_BODY_ZZZ/)).toBeInTheDocument();
  });

  it("renders a not-found state for an unknown entry id", async () => {
    renderEvidence("/evidence/does-not-exist");
    expect(
      await screen.findByRole("heading", { name: /evidence not found/i }),
    ).toBeInTheDocument();
  });

  it("renders a wireframe fallback (not a broken-image icon) when the image errors", async () => {
    const { container } = renderEvidence();
    const img = await screen.findByRole("img", { name: /pricing page/i });
    // Simulate the image failing to load (jsdom never actually loads images).
    fireEvent.error(img);

    // The fallback is a structured wireframe placeholder (data-testid); the
    // broken <img> element must be removed entirely so the browser never shows
    // a broken-image icon.
    expect(await screen.findByTestId("image-wireframe")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });

  it("renders a copyable agent-ready prompt with the correct content", async () => {
    // Install a working Clipboard API so CopyAction reaches its success state.
    installClipboard({ writeText: vi.fn(async () => undefined) });

    renderEvidence();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /^decision$/i })).toBeInTheDocument(),
    );

    const copyButton = screen.getByRole("button", { name: /copy agent prompt/i });
    // The value to copy lives in a region we can read for the assertion.
    const promptRegion = screen.getByTestId("agent-prompt");
    const promptText = promptRegion.textContent ?? "";
    expect(promptText).toContain("pricing");
    expect(promptText).toContain("Pricing page");

    // The button has the value wired through CopyAction.
    fireEvent.click(copyButton);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /copied/i })).toBeInTheDocument(),
    );
  });

  it("offers a back-to-results link that preserves the originating search params", async () => {
    renderEvidence("/evidence/pricing-a?q=pricing&platform=web");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /pricing page/i })).toBeInTheDocument(),
    );

    // The back-to-results link appears at the top and the foot of the page; both
    // must carry the preserved search params.
    const backLinks = screen.getAllByRole("link", { name: /back to results/i });
    expect(backLinks.length).toBeGreaterThanOrEqual(1);
    for (const back of backLinks) {
      const href = back.getAttribute("href") ?? "";
      expect(href).toContain("/playground");
      expect(href).toContain("q=pricing");
      expect(href).toContain("platform=web");
    }
  });

  it("renders provenance with the source product name and URL", async () => {
    renderEvidence();
    const provenance = await screen.findByRole("heading", { name: /^provenance$/i });
    const section = provenance.parentElement!;
    expect(section.textContent ?? "").toContain("Acme");
    const sourceLink = within(section).getByRole("link", { name: /acme\.example\.com/i });
    expect(sourceLink.getAttribute("href")).toBe("https://acme.example.com/pricing");
  });
});
