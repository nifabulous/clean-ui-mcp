/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Mock the snapshot loader BEFORE importing the page. The Browse page derives
// its result count and filter options from the snapshot fixture, so the fixture
// must drive every rendered number (no hard-coded literals in the component).
vi.mock("../data/load-snapshot", () => ({
  loadPublicSnapshot: vi.fn(),
}));

import { loadPublicSnapshot } from "../data/load-snapshot";
import type { PublicSnapshot } from "../data/public-entry";
import { BrowsePage } from "./BrowsePage";

// The Browse page's internal debounce window. Kept in sync with the component
// constant so the debounce test can wait exactly long enough without slowing
// the rest of the suite.
const DEBOUNCE_MS = 300;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface EntryOpts {
  readonly title: string;
  readonly patternType: string;
  readonly categories: readonly string[];
  readonly styles: readonly string[];
  readonly tier?: string;
  readonly score?: number;
  readonly product?: string;
  readonly url?: string;
  readonly platform?: string;
  readonly excerpt?: string;
}

function entry(id: string, opts: EntryOpts): Record<string, unknown> {
  return {
    id,
    title: opts.title,
    patternType: opts.patternType,
    categories: [...opts.categories],
    styleTags: [...opts.styles],
    qualityTier: opts.tier ?? "exceptional",
    qualityScore: opts.score ?? 3,
    // Deliberately long — the scan view must NOT render this paragraph.
    critique: `Full critique paragraph for ${opts.title}. It runs for several sentences and contains a secret marker ZZZ_FULL_CRITIQUE_BODY_ZZZ that must never appear in the scan view, only on the evidence detail page.`,
    critiqueExcerpt: opts.excerpt ?? `Short excerpt for ${opts.title}.`,
    whatToSteal: [`Steal technique from ${opts.title}.`],
    antiPatterns: [`Avoid anti-pattern in ${opts.title}.`],
    dominantColors: ["#384c67", "#2ba0f5"],
    imagePath: `${id}.png`,
    source: {
      productName: opts.product ?? opts.title,
      url: opts.url ?? `https://${(opts.product ?? id).toLowerCase()}.example.com`,
    },
    ...(opts.platform ? { platform: opts.platform } : {}),
  };
}

function fixtureSnapshot(): PublicSnapshot {
  const entries = [
    entry("pricing-a", {
      title: "Pricing page",
      patternType: "pricing",
      categories: ["pricing"],
      styles: ["minimal"],
      product: "Acme",
      platform: "web",
    }),
    entry("dashboard-b", {
      title: "Analytics dashboard",
      patternType: "dashboard",
      categories: ["dashboard"],
      styles: ["dense-data"],
      product: "Globex",
      platform: "web",
    }),
    entry("onboarding-c", {
      title: "Onboarding flow",
      patternType: "onboarding",
      categories: ["onboarding"],
      styles: ["editorial"],
      product: "Initech",
      platform: "ios",
    }),
    entry("pricing-d", {
      title: "Tiered pricing",
      patternType: "pricing",
      categories: ["pricing"],
      styles: ["editorial"],
      product: "Hooli",
      platform: "web",
    }),
    entry("settings-e", {
      title: "Settings panel",
      patternType: "settings",
      categories: ["settings"],
      styles: ["minimal"],
      product: "Umbrella",
      platform: "ios",
    }),
  ];
  return {
    count: entries.length, // 5
    generatedAt: "2026-07-18T00:00:00.000Z",
    categories: ["pricing", "dashboard", "onboarding", "settings"],
    styleTags: ["minimal", "dense-data", "editorial"],
    entries: entries as unknown as PublicSnapshot["entries"],
  };
}

// ---------------------------------------------------------------------------
// Location probe — exposes the router's current pathname + search string so
// tests can assert canonical URL replacement under MemoryRouter.
// ---------------------------------------------------------------------------

let lastSearch = "";
let lastPathname = "";
function LocationProbe(): null {
  const location = useLocation();
  lastSearch = location.search;
  lastPathname = location.pathname;
  return null;
}

function renderBrowse(initialEntry = "/browse"): ReturnType<typeof render> {
  lastSearch = "";
  lastPathname = "";
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <LocationProbe />
      <BrowsePage />
    </MemoryRouter>,
  );
}

/** Wait for the results region to mount (snapshot has resolved). */
async function ready(): Promise<void> {
  await waitFor(() =>
    expect(screen.getByRole("region", { name: /browse results/i })).toBeInTheDocument(),
  );
}

describe("BrowsePage — contract", () => {
  beforeEach(() => {
    vi.mocked(loadPublicSnapshot).mockResolvedValue(fixtureSnapshot());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    lastSearch = "";
    lastPathname = "";
  });

  it("renders initial results and announces the count via a live region", async () => {
    renderBrowse();
    await ready();

    const live = screen.getByRole("status");
    // Fixture has 5 entries; initial unfiltered result count must be 5.
    expect(live.textContent ?? "").toMatch(/5/);

    // Cards render with the scan-view contract: title + pattern + excerpt.
    expect(screen.getByRole("heading", { name: /pricing page/i })).toBeInTheDocument();
    // The full critique body must NOT render in the scan view.
    expect(screen.queryByText(/ZZZ_FULL_CRITIQUE_BODY_ZZZ/)).toBeNull();
  });

  it("debounces the query so results do not update on every keystroke", async () => {
    renderBrowse();
    await ready();

    const input = screen.getByLabelText(/ask the corpus/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "p" } });
    fireEvent.change(input, { target: { value: "pr" } });
    fireEvent.change(input, { target: { value: "pricing" } });

    // Before the debounce fires, the count region still reflects the full corpus.
    expect(screen.getByRole("status").textContent ?? "").toMatch(/5/);

    // After the debounce window the query applies: only pricing entries remain
    // (pricing-a + pricing-d = 2).
    await waitFor(
      () => {
        expect(screen.getByRole("status").textContent ?? "").toMatch(/2/);
      },
      { timeout: DEBOUNCE_MS + 500 },
    );
  });

  it("narrows results by combined category and platform filters", async () => {
    renderBrowse();
    await ready();

    const categorySelect = screen.getByLabelText(/category/i) as HTMLSelectElement;
    fireEvent.change(categorySelect, { target: { value: "pricing" } });

    // Two pricing entries, both on the web.
    await waitFor(() =>
      expect(screen.getByRole("status").textContent ?? "").toMatch(/2/),
    );

    const platformSelect = screen.getByLabelText(/platform/i) as HTMLSelectElement;
    fireEvent.change(platformSelect, { target: { value: "ios" } });

    // No pricing entry is iOS -> empty state.
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /no results/i })).toBeInTheDocument(),
    );
  });

  it("empty state lists active filters with remove buttons and three deterministic suggestions", async () => {
    renderBrowse();
    await ready();

    // Pick an iOS + pricing combination that matches nothing.
    fireEvent.change(screen.getByLabelText(/category/i), { target: { value: "pricing" } });
    fireEvent.change(screen.getByLabelText(/platform/i), { target: { value: "ios" } });

    const empty = await screen.findByRole("heading", { name: /no results/i });
    const container = empty.parentElement!;

    // Active filters are listed with remove buttons.
    const filterList = within(container).getByRole("list", {
      name: /active filters/i,
    });
    const removeButtons = within(filterList).getAllByRole("button", { name: /remove/i });
    expect(removeButtons.length).toBe(2);

    // Three deterministic related-query suggestions are offered.
    const suggestions = within(container).getByRole("list", {
      name: /related queries/i,
    });
    expect(within(suggestions).getAllByRole("button").length).toBe(3);

    // Removing all active filters returns results.
    fireEvent.click(removeButtons[0]);
    fireEvent.click(within(filterList).getAllByRole("button", { name: /remove/i })[0]);
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: /no results/i })).toBeNull(),
    );
  });

  it("restores state from the canonical URL on load", async () => {
    renderBrowse("/browse?q=pricing&platform=web");
    await ready();

    const input = screen.getByLabelText(/ask the corpus/i) as HTMLInputElement;
    expect(input.value).toBe("pricing");

    // Two pricing entries are on the web.
    await waitFor(() =>
      expect(screen.getByRole("status").textContent ?? "").toMatch(/2/),
    );
  });

  it("updates the canonical URL when the query changes", async () => {
    renderBrowse();
    await ready();

    fireEvent.change(screen.getByLabelText(/ask the corpus/i), {
      target: { value: "dashboard" },
    });
    await waitFor(() => expect(lastSearch).toContain("q=dashboard"), {
      timeout: DEBOUNCE_MS + 500,
    });
  });

  // Migration guard (C3 Task 6): the search surface moved from /playground to
  // /browse. Every canonical URL this page writes must stay on /browse — a
  // leftover "/playground" target would silently navigate the operator into the
  // C3 composer and drop the whole search state.
  it("keeps the canonical route on /browse when state changes", async () => {
    renderBrowse();
    await ready();

    // A filter change commits immediately.
    fireEvent.change(screen.getByLabelText(/category/i), { target: { value: "pricing" } });
    await waitFor(() => expect(lastSearch).toContain("category=pricing"));
    expect(lastPathname).toBe("/browse");

    // A debounced query change commits too.
    fireEvent.change(screen.getByLabelText(/ask the corpus/i), {
      target: { value: "dashboard" },
    });
    await waitFor(() => expect(lastSearch).toContain("q=dashboard"), {
      timeout: DEBOUNCE_MS + 500,
    });
    expect(lastPathname).toBe("/browse");
  });

  // Migration guard: clearing every parameter must land on the bare /browse
  // path, not the bare /playground path.
  it("returns to the bare /browse path when a suggestion clears all filters", async () => {
    renderBrowse("/browse?q=nothing-matches-this-query&category=pricing");
    await ready();

    const suggestions = await screen.findByRole("list", { name: /related queries/i });
    fireEvent.click(within(suggestions).getAllByRole("button")[0]);

    await waitFor(() => expect(lastPathname).toBe("/browse"));
    expect(lastSearch).not.toContain("category=");
  });

  it("preserves the search state on the evidence-detail link", async () => {
    renderBrowse("/browse?q=pricing&platform=web");
    await ready();

    const evidenceLinks = await screen.findAllByRole("link", { name: /view evidence/i });
    expect(evidenceLinks.length).toBeGreaterThan(0);
    for (const link of evidenceLinks) {
      const href = link.getAttribute("href") ?? "";
      expect(href).toContain("q=pricing");
      expect(href).toContain("platform=web");
      // The link points at an evidence route.
      expect(href).toMatch(/\/evidence\//);
    }
  });

  it("offers retry when the snapshot fails to load", async () => {
    vi.mocked(loadPublicSnapshot).mockReset();
    // First load fails; the retry succeeds.
    vi.mocked(loadPublicSnapshot)
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(fixtureSnapshot());
    renderBrowse();

    const retry = await screen.findByRole("button", { name: /retry/i });
    expect(retry).toBeInTheDocument();

    fireEvent.click(retry);
    await waitFor(() =>
      expect(vi.mocked(loadPublicSnapshot)).toHaveBeenCalledTimes(2),
    );
    // The retry resolves and results render.
    await ready();
  });

  it("exposes the install action so a visitor can leave to install", async () => {
    renderBrowse();
    await ready();
    const install = screen.getByRole("link", { name: /install/i });
    expect(install.getAttribute("href") ?? "").toMatch(/\/install/);
  });
});

// Silence the unused-import warning for `act` — it is re-exported for parity
// with the rest of the suite but not currently invoked directly.
void act;
