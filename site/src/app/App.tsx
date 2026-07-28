import { lazy, Suspense, type ReactElement } from "react";
import { Link, Route, Routes } from "react-router-dom";
import { HomePage } from "../pages/HomePage";
import { InstallPage } from "../pages/InstallPage";
import { SiteShell } from "./SiteShell";

// Route-level code splitting (spec §12 performance). Browse, the Playground
// composer, and Evidence detail are the heaviest surfaces — Browse pulls in the
// MiniSearch index, Evidence the full evidence-section tree — so they are
// lazy-loaded to keep the initial bundle under the 150KB gzip budget. Each
// dynamic import becomes its own chunk.
const BrowsePage = lazy(() =>
  import("../pages/BrowsePage").then((module) => ({ default: module.BrowsePage })),
);
const PlaygroundPage = lazy(() =>
  import("../pages/PlaygroundPage").then((module) => ({ default: module.PlaygroundPage })),
);
const EvidencePage = lazy(() =>
  import("../pages/EvidencePage").then((module) => ({ default: module.EvidencePage })),
);

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
 *
 * Lazy routes are wrapped in `<Suspense fallback={null}>`. The fallback is null
 * (rather than a spinner) so the initial paint of the homepage / install page
 * stays clean; each lazy page owns its own loading affordance via {@link AsyncState}.
 */
export function AppRoutes(): ReactElement {
  return (
    <SiteShell>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/install" element={<InstallPage />} />
        {/* /playground is the C3 create_ui_spec composer. The corpus-search
            surface that used to live here moved to /browse (C3 Task 6) with its
            search, filters and query-string contract unchanged. */}
        <Route
          path="/playground"
          element={
            <Suspense fallback={null}>
              <PlaygroundPage />
            </Suspense>
          }
        />
        <Route
          path="/browse"
          element={
            <Suspense fallback={null}>
              <BrowsePage />
            </Suspense>
          }
        />
        <Route
          path="/evidence/:entryId"
          element={
            <Suspense fallback={null}>
              <EvidencePage />
            </Suspense>
          }
        />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </SiteShell>
  );
}
