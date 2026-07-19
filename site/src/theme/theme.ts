/**
 * Theme resolution, persistence, and DOM application.
 *
 * Contract (see `docs/design-system.md` and the unified-product-experience spec
 * §5.4 "Theme behavior"):
 *
 * - The theme is stored under `localStorage["clean-ui-theme"]` with the values
 *   `"light"` or `"dark"`.
 * - When no explicit choice is stored, the OS `prefers-color-scheme` preference
 *   is honored.
 * - An explicit choice always wins over the OS preference.
 * - The resolved theme is written to `document.documentElement.dataset.theme`
 *   so CSS custom properties switch without a flash.
 *
 * `resolveTheme` is pure: it performs no DOM or storage access. All side effects
 * live in `setTheme`, `getTheme`, and the optional `initThemeSync`/`disposeThemeSync`
 * pair.
 */

export type Theme = "light" | "dark";

/** The localStorage key used for the explicit theme choice. */
export const THEME_STORAGE_KEY = "clean-ui-theme";

const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

/**
 * Resolve a theme from an optional saved value and the OS preference.
 *
 * Pure: no DOM or storage access. An explicit `"light"` or `"dark"` value always
 * wins. Any other saved value (including `null`, `undefined`, and invalid strings)
 * falls back to the OS preference.
 */
export function resolveTheme(saved: string | null | undefined, prefersDark: boolean): Theme {
  if (saved === "light" || saved === "dark") {
    return saved;
  }
  return prefersDark ? "dark" : "light";
}

function readSavedTheme(): string | null {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    // localStorage may be unavailable (private mode, sandbox). Treat as no choice.
    return null;
  }
}

function writeSavedTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Ignore storage failures; the in-memory dataset still updates so the UI is
    // correct for the session even if the choice cannot persist.
  }
}

function prefersDarkFromMedia(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(DARK_MEDIA_QUERY).matches;
}

/** Apply a resolved theme to the document root dataset. */
function applyThemeToDom(theme: Theme): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
}

// --- OS-preference subscription -----------------------------------------------

let mediaListener: ((event: MediaQueryListEvent) => void) | null = null;
let watchedMedia: MediaQueryList | null = null;

function stopWatchingOs(): void {
  if (watchedMedia && mediaListener) {
    watchedMedia.removeEventListener("change", mediaListener);
  }
  mediaListener = null;
  watchedMedia = null;
}

function startWatchingOs(): void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return;
  }
  if (mediaListener) return; // Already subscribed.
  watchedMedia = window.matchMedia(DARK_MEDIA_QUERY);
  mediaListener = (): void => {
    // Only honor OS changes while no explicit local choice exists.
    if (readSavedTheme() === "light" || readSavedTheme() === "dark") {
      stopWatchingOs();
      return;
    }
    // Read the media query list's current `matches` rather than the event's
    // payload so we always apply the freshest OS state.
    const prefersDark = watchedMedia ? watchedMedia.matches : prefersDarkFromMedia();
    applyThemeToDom(prefersDark ? "dark" : "light");
  };
  watchedMedia.addEventListener("change", mediaListener);
}

/**
 * Initialize OS-preference synchronization. Subscribes to `prefers-color-scheme`
 * changes ONLY while no explicit local choice exists, and applies the resolved
 * theme to the document root. Safe to call multiple times.
 *
 * Call this once on application bootstrap (after the inline pre-paint bootstrap
 * in `index.html` has set an initial dataset value).
 */
export function initThemeSync(): void {
  const saved = readSavedTheme();
  if (saved === "light" || saved === "dark") {
    // An explicit choice exists: apply it and do not subscribe to OS changes.
    applyThemeToDom(saved);
    stopWatchingOs();
    return;
  }
  // No explicit choice: follow the OS, now and as it changes.
  applyThemeToDom(resolveTheme(saved, prefersDarkFromMedia()));
  startWatchingOs();
}

/** Tear down OS-preference synchronization. Intended for tests. */
export function disposeThemeSync(): void {
  stopWatchingOs();
}

/**
 * Read the active theme. If an explicit choice exists, return it; otherwise
 * resolve from the OS preference (falling back to the dataset attribute applied
 * before first paint, then to "light").
 */
export function getTheme(): Theme {
  const saved = readSavedTheme();
  if (saved === "light" || saved === "dark") {
    return saved;
  }
  if (typeof document !== "undefined") {
    const dataset = document.documentElement.dataset.theme;
    if (dataset === "light" || dataset === "dark") {
      return dataset;
    }
  }
  return resolveTheme(saved, prefersDarkFromMedia());
}

/**
 * Persist an explicit theme choice, apply it to the document root, and stop
 * honoring further OS-preference changes. Once a user chooses, their choice
 * sticks across OS theme switches.
 */
export function setTheme(theme: Theme): void {
  writeSavedTheme(theme);
  applyThemeToDom(theme);
  // An explicit choice now exists; OS changes must no longer override it.
  stopWatchingOs();
}
