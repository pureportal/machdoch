import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";
import { App } from "./app";

declare const __MACHDOCH_DEVELOPMENT__: boolean;

if (__MACHDOCH_DEVELOPMENT__) {
  void import("./media-quality-driver").then((driver) => {
    Object.assign(window, {
      startWitchFramePackQualityRun:
        driver.startWitchFramePackQualityRun,
      startWitchHunyuanQualityRun:
        driver.startWitchHunyuanQualityRun,
      startGeneralHunyuanQualityRun:
        driver.startGeneralHunyuanQualityRun,
      startAnimationIterationRun:
        driver.startAnimationIterationRun,
      startDogLoraImageQualityRun:
        driver.startDogLoraImageQualityRun,
    });
  });
}

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
