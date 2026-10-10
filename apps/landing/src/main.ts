import {
  getConsentSnapshot,
  setAnalyticsConsent,
  startBrowserAnalytics,
  subscribeConsent,
} from "@machdoch/analytics/browser";
import packageManifest from "../package.json";

for (const element of document.querySelectorAll<HTMLElement>(".download-card"))
  element.dataset.analyticsFeature = "landing.download";
for (const element of document.querySelectorAll<HTMLElement>(
  'a[href="https://github.com/pureportal/machdoch"]',
))
  element.dataset.analyticsFeature = "landing.github";
for (const element of document.querySelectorAll<HTMLElement>(
  'a[href="#download"]',
))
  element.dataset.analyticsFeature = "landing.download";
for (const element of document.querySelectorAll<HTMLElement>(
  "section[id], .hero",
))
  element.dataset.analyticsFeature =
    element.id === "download"
      ? "landing.download"
      : element.classList.contains("hero")
        ? "landing.overview"
        : "landing.features";

startBrowserAnalytics({
  app: "landing",
  version: packageManifest.version,
  development: import.meta.env.DEV,
});

const consent = document.querySelector<HTMLInputElement>("#analytics-consent")!;
const description = document.querySelector<HTMLParagraphElement>(
  "#analytics-description",
)!;
const error = document.querySelector<HTMLParagraphElement>("#analytics-error")!;
const originalDescription = description.textContent;
const renderConsent = (): void => {
  const state = getConsentSnapshot();
  consent.checked = state.enabled;
  consent.disabled = state.blocked;
  description.textContent = state.blocked
    ? "Your browser privacy preference disables analytics."
    : originalDescription;
  error.hidden = !state.error;
  error.textContent = state.error;
};
subscribeConsent(renderConsent);
renderConsent();
consent.addEventListener("change", () => setAnalyticsConsent(consent.checked));
