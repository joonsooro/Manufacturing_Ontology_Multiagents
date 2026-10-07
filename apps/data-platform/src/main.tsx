/**
 * React browser entry point. Mount the data-platform shell into index.html's root element.
 * StrictMode enables React's development checks for effects and rendering.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
