import {
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { NavLink, useLocation } from "react-router-dom";
import { ThemeToggle } from "../components/ThemeToggle";
import { initThemeSync } from "../theme/theme";
import "../styles/shell.css";

/**
 * In-application navigation entries. External destinations (Docs, Changelog,
 * GitHub) are plain anchors; in-app destinations use NavLink so an active route
 * is marked with `aria-current="page"`.
 */
interface NavEntry {
  /** Stable id used for React keys and test selection. */
  id: string;
  /** Accessible name shown in the menu. */
  label: string;
  /** In-app route, or null for an external link. */
  to: string | null;
  /** External href when `to` is null. */
  href: string | null;
}

const PRIMARY_NAV: readonly NavEntry[] = [
  { id: "product", label: "Product", to: "/", href: null },
  { id: "playground", label: "Playground", to: "/playground", href: null },
  { id: "docs", label: "Docs", to: null, href: "https://github.com/olaniyi-oladokun/clean-ui-mcp#readme" },
  { id: "changelog", label: "Changelog", to: null, href: "https://github.com/olaniyi-oladokun/clean-ui-mcp/releases" },
  { id: "github", label: "GitHub", to: null, href: "https://github.com/olaniyi-oladokun/clean-ui-mcp" },
];

/**
 * Global layout shell: skip link, semantic landmarks, primary navigation with a
 * mobile disclosure menu, theme control, and a main landmark that the skip link
 * targets. Renders its children inside `<main id="main-content">`.
 *
 * Accessibility contract:
 * - Skip link targets `#main-content`.
 * - The mobile menu trigger is a disclosure button with `aria-expanded` and
 *   `aria-controls`.
 * - Escape closes the menu and returns focus to the trigger.
 * - A route change closes the menu.
 * - Active in-app route is marked with `aria-current="page"`.
 */
export function SiteShell({ children }: { children: ReactElement | ReactElement[] }): ReactElement {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuId = "site-nav-mobile";

  // Initialize OS-preference theme sync once on mount. The inline bootstrap in
  // index.html has already applied a dataset value before paint.
  useEffect(() => {
    initThemeSync();
  }, []);

  // Close the mobile menu on any route change.
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname, location.search]);

  // Escape closes the menu and returns focus to the trigger.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setMenuOpen(false);
        // Return focus to the trigger so keyboard users are not stranded.
        window.requestAnimationFrame(() => {
          triggerRef.current?.focus();
        });
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [menuOpen]);

  const handleTriggerKey = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === "Escape" && menuOpen) {
      event.preventDefault();
      setMenuOpen(false);
      triggerRef.current?.focus();
    }
  };

  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="site-header">
        <div className="site-header__inner">
          <a className="site-brand" href="/" aria-label="clean-ui-mcp home">
            clean-ui-mcp
          </a>
          <button
            ref={triggerRef}
            type="button"
            className="nav-menu-toggle"
            aria-expanded={menuOpen}
            aria-controls={menuId}
            aria-label="Toggle navigation menu"
            onClick={() => setMenuOpen((open) => !open)}
            onKeyDown={handleTriggerKey}
          >
            Menu
          </button>
          <nav className="site-nav" id={menuId} aria-label="Primary">
            <ul className="site-nav__list" data-open={menuOpen ? "true" : "false"}>
              {PRIMARY_NAV.map((entry) => (
                <li key={entry.id} className="site-nav__item">
                  {entry.to !== null ? (
                    <NavLink
                      to={entry.to}
                      className="site-nav__link"
                      // The Product link is the homepage; mark it active only on
                      // the exact root so a Play­ground/evidence page does not
                      // also light up Product.
                      end={entry.to === "/"}
                    >
                      {entry.label}
                    </NavLink>
                  ) : (
                    <a
                      className="site-nav__link site-nav__link--external"
                      href={entry.href ?? "#"}
                      rel="noreferrer noopener"
                      target="_blank"
                    >
                      {entry.label}
                    </a>
                  )}
                </li>
              ))}
              <li className="site-nav__item site-nav__item--control">
                <ThemeToggle />
              </li>
            </ul>
          </nav>
        </div>
      </header>
      <main id="main-content" className="site-main" tabIndex={-1}>
        {children}
      </main>
      <footer className="site-footer">
        <div className="site-footer__inner">
          <p className="site-footer__note">
            clean-ui-mcp — design judgment for AI agents, grounded in real interfaces.
          </p>
        </div>
      </footer>
    </>
  );
}
