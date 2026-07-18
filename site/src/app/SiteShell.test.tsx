import { render, screen, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes, Link } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SiteShell } from "./SiteShell";

function renderShell(initialPath = "/"): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route
          path="*"
          element={
            <SiteShell>
              <section>
                <h1>Page body</h1>
            </section>
            </SiteShell>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("SiteShell — skip link", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());

  it("renders a skip link that targets the main landmark", () => {
    renderShell();
    const skip = screen.getByRole("link", { name: /skip to content/i });
    expect(skip).toHaveAttribute("href", "#main-content");
  });

  it("points the main landmark at id=main-content", () => {
    renderShell();
    const main = screen.getByRole("main");
    expect(main).toHaveAttribute("id", "main-content");
  });
});

describe("SiteShell — landmarks and navigation", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());

  it("renders header, navigation, main, and footer landmarks", () => {
    renderShell();
    expect(screen.getByRole("banner")).toBeInTheDocument(); // <header>
    expect(screen.getByRole("navigation")).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toBeInTheDocument(); // <footer>
  });

  it("includes the spec §6.1 navigation entries by name", async () => {
    const user = userEvent.setup();
    renderShell();
    // On mobile (jsdom's default — no media query matches) the disclosure is
    // collapsed, so open it to expose the nav entries to the accessibility tree.
    await user.click(screen.getByRole("button", { name: /menu/i }));
    const nav = screen.getByRole("navigation");
    // Product, Playground, Docs, Changelog, GitHub are anchor links.
    expect(within(nav).getByRole("link", { name: /product/i })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: /playground/i })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: /docs/i })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: /changelog/i })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: /github/i })).toBeInTheDocument();
    // Theme control is a toggle button inside the nav.
    expect(within(nav).getByRole("button", { name: /theme|switch to|light|dark/i })).toBeInTheDocument();
  });
});

describe("SiteShell — mobile disclosure menu", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());

  it("exposes a menu trigger that reflects aria-expanded", async () => {
    const user = userEvent.setup();
    renderShell();
    const trigger = screen.getByRole("button", { name: /menu/i });
    // Starts collapsed.
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("closes the menu when Escape is pressed", async () => {
    const user = userEvent.setup();
    renderShell();
    const trigger = screen.getByRole("button", { name: /menu/i });
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("returns focus to the menu trigger after closing via Escape", async () => {
    const user = userEvent.setup();
    renderShell();
    const trigger = screen.getByRole("button", { name: /menu/i });
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(trigger);
  });

  it("closes the menu when navigation moves to a new route", async () => {
    const user = userEvent.setup();
    function ShellWithRoutes(): ReactElement {
      return (
        <MemoryRouter initialEntries={["/alpha"]}>
          <Routes>
            <Route
              path="/alpha"
              element={
                <SiteShell>
                  <h1>Alpha</h1>
                  <p>
                    <Link to="/beta">Go to beta</Link>
                  </p>
                </SiteShell>
              }
            />
            <Route
              path="/beta"
              element={
                <SiteShell>
                  <h1>Beta</h1>
                </SiteShell>
              }
            />
          </Routes>
        </MemoryRouter>
      );
    }
    render(<ShellWithRoutes />);
    const trigger = screen.getByRole("button", { name: /menu/i });
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    // Navigate to a new route via an in-app link.
    await user.click(screen.getByRole("link", { name: /go to beta/i }));

    // The trigger must collapse on route change.
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("marks the active in-app route with aria-current", async () => {
    function ShellWithRoutes(): ReactElement {
      return (
        <MemoryRouter initialEntries={["/playground"]}>
          <Routes>
            <Route
              path="/playground"
              element={
                <SiteShell>
                  <h1>Playground</h1>
                </SiteShell>
              }
            />
          </Routes>
        </MemoryRouter>
      );
    }
    render(<ShellWithRoutes />);
    // Open the disclosure so the nav links join the accessibility tree (mobile
    // default in jsdom collapses them).
    await userEvent.setup().click(screen.getByRole("button", { name: /menu/i }));
    const nav = screen.getByRole("navigation");
    const playgroundLink = within(nav).getByRole("link", { name: /playground/i });
    expect(playgroundLink).toHaveAttribute("aria-current", "page");
  });
});
