import type { ReactElement } from "react";
import { Link, Route, Routes } from "react-router-dom";
import { HomePage } from "../pages/HomePage";
import { InstallPage } from "../pages/InstallPage";
import { SiteShell } from "./SiteShell";

function NotFoundPage(): ReactElement {
  return (
    <section>
      <h1>Page not found</h1>
      <p>
        <Link to="/">Back to home</Link>
      </p>
    </section>
  );
}

/**
 * The public application routes wrapped in the global {@link SiteShell}.
 *
 * The shell owns the skip link, header/nav landmarks, mobile disclosure menu,
 * `<main id="main-content">`, and footer. Each route renders its content as the
 * shell's children, so the H1 and route copy live inside the main landmark.
 */
export function AppRoutes(): ReactElement {
  return (
    <SiteShell>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/install" element={<InstallPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </SiteShell>
  );
}
