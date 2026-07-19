import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveTheme,
  setTheme,
  getTheme,
  initThemeSync,
  disposeThemeSync,
  THEME_STORAGE_KEY,
} from "./theme";

const STORAGE_KEY = THEME_STORAGE_KEY;

describe("resolveTheme — pure resolution", () => {
  it("defaults to light when nothing is saved and OS prefers light", () => {
    expect(resolveTheme(null, false)).toBe("light");
  });

  it("defaults to dark when nothing is saved and OS prefers dark", () => {
    expect(resolveTheme(null, true)).toBe("dark");
  });

  it("honors an explicit dark choice even when OS prefers light", () => {
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("honors an explicit light choice even when OS prefers dark", () => {
    expect(resolveTheme("light", true)).toBe("light");
  });

  it("falls back to the system preference for an invalid saved value (light)", () => {
    expect(resolveTheme("purple", false)).toBe("light");
  });

  it("falls back to the system preference for an invalid saved value (dark)", () => {
    expect(resolveTheme("purple", true)).toBe("dark");
  });

  it("treats undefined saved values the same as null", () => {
    expect(resolveTheme(undefined, true)).toBe("dark");
    expect(resolveTheme(undefined, false)).toBe("light");
  });
});

describe("setTheme / getTheme — localStorage round trip", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("persists the chosen theme under the documented storage key", () => {
    setTheme("dark");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("dark");
    expect(getTheme()).toBe("dark");
  });

  it("round-trips light through setTheme and getTheme", () => {
    setTheme("light");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("light");
    expect(getTheme()).toBe("light");
  });

  it("applies the resolved theme to document.documentElement.dataset.theme", () => {
    setTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    setTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("falls back to the resolved system theme when no explicit value is stored", () => {
    // Pretend the OS prefers dark.
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const stub = vi
      .spyOn(mql, "matches", "get")
      .mockReturnValue(true);
    try {
      // No explicit choice in storage.
      expect(getTheme()).toBe("dark");
    } finally {
      stub.mockRestore();
    }
  });
});

describe("OS preference subscription", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  afterEach(() => {
    disposeThemeSync();
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("applies the OS preference while no explicit choice is stored", () => {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const matchesSpy = vi.spyOn(mql, "matches", "get").mockReturnValue(false);
    initThemeSync();
    try {
      expect(document.documentElement.dataset.theme).toBe("light");

      // Simulate the OS switching to dark.
      matchesSpy.mockReturnValue(true);
      mql.dispatchEvent(new Event("change"));

      // No explicit choice exists, so the OS change should be honored.
      expect(document.documentElement.dataset.theme).toBe("dark");
    } finally {
      matchesSpy.mockRestore();
    }
  });

  it("stops honoring OS changes once an explicit choice is stored", () => {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const matchesSpy = vi.spyOn(mql, "matches", "get").mockReturnValue(false);
    initThemeSync();
    try {
      setTheme("light");
      expect(document.documentElement.dataset.theme).toBe("light");

      // OS switches to dark — explicit light choice must win.
      matchesSpy.mockReturnValue(true);
      mql.dispatchEvent(new Event("change"));
      expect(document.documentElement.dataset.theme).toBe("light");
      expect(getTheme()).toBe("light");
    } finally {
      matchesSpy.mockRestore();
    }
  });
});
