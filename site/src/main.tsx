import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { AppRoutes } from "./app/App";
import "./styles/global.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing #root mount node");
}

createRoot(root).render(
  <StrictMode>
    <BrowserRouter basename="/clean-ui-mcp">
      <AppRoutes />
    </BrowserRouter>
  </StrictMode>,
);
