import { useEffect, useState, type ReactElement } from "react";
import { getTheme, setTheme, type Theme } from "../theme/theme";

/**
 * Accessible light/dark theme control.
 *
 * - A native `<button>` with a 44px minimum target (see `shell.css`).
 * - Reflects state via `aria-pressed` (true when dark is active) and a
 *   descriptive `aria-label`.
 * - Wires to the theme module: clicking persists an explicit choice, which the
 *   theme module then locks in (OS-preference changes no longer override it).
 *
 * The visible glyph is the only theme-sensitive decoration; the accessible name
 * always describes the action the button will perform.
 */
export function ThemeToggle(): ReactElement {
  const [theme, setThemeState] = useState<Theme>(() => getTheme());

  // Keep the local state in sync if the theme changes elsewhere (e.g. another
  // tab, or the initial OS sync on mount).
  useEffect(() => {
    setThemeState(getTheme());
  }, []);

  const toggle = (): void => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    setThemeState(next);
  };

  const isDark = theme === "dark";

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggle}
      aria-pressed={isDark}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      title={isDark ? "Switch to light theme" : "Switch to dark theme"}
    >
      <span className="theme-toggle__icon" aria-hidden="true">
        {isDark ? "☀" : "☾"}
      </span>
      <span className="theme-toggle__label">
        {isDark ? "Light" : "Dark"}
      </span>
    </button>
  );
}
