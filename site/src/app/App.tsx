import type { ReactElement } from "react";
import { Link, Route, Routes } from "react-router-dom";

function HomePage(): ReactElement {
  return (
    <main>
      <h1>Design judgment grounded in real interfaces</h1>
    </main>
  );
}

function NotFoundPage(): ReactElement {
  return (
    <main>
      <h1>Page not found</h1>
      <p>
        <Link to="/">Back to home</Link>
      </p>
    </main>
  );
}

export function AppRoutes(): ReactElement {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
