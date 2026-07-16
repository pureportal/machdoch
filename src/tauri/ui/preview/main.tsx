import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";
import { App } from "./app";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("The UI preview root element was not found.");
}

document.addEventListener(
  "contextmenu",
  (event) => {
    if (
      event.target instanceof Element &&
      event.target.closest("[data-app-context-menu-trigger]")
    ) {
      return;
    }

    event.preventDefault();
  },
  { capture: true },
);

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
