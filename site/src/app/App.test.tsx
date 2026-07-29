import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

// The homepage derives its proof from the snapshot. These routing tests are not
// about snapshot loading, so mock the loader to a resolved empty snapshot and
// avoid firing a real fetch that settles after the test unmounts.
vi.mock("../data/load-snapshot", () => ({
  loadPublicSnapshot: vi.fn(async () => ({
    count: 0,
    generatedAt: "2026-07-18T00:00:00.000Z",
    categories: [],
    styleTags: [],
    entries: [],
  })),
}));

import { AppRoutes } from "./App";

describe("public routes", () => {
  it("renders the homepage at the application root", () => {
    render(<MemoryRouter initialEntries={["/"]}><AppRoutes /></MemoryRouter>);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/design judgment/i);
  });

  it("renders a useful not-found state", () => {
    render(<MemoryRouter initialEntries={["/missing"]}><AppRoutes /></MemoryRouter>);
    expect(screen.getByRole("heading", { name: /page not found/i })).toBeVisible();
  });

  // C3 Task 6: /playground is the create_ui_spec composer; the corpus-search
  // surface it replaced lives at /browse. Both routes must resolve — a missing
  // /browse route would 404 every shared search URL and every evidence
  // back-link.
  it("renders the C3 composer at /playground", async () => {
    render(<MemoryRouter initialEntries={["/playground"]}><AppRoutes /></MemoryRouter>);
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
        /design handoff/i,
      ),
    );
  });

  it("renders the corpus-search surface at /browse", async () => {
    render(<MemoryRouter initialEntries={["/browse"]}><AppRoutes /></MemoryRouter>);
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
        /search the critiqued corpus/i,
      ),
    );
  });
});
