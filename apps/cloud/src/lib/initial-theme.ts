import {
  browserAppearanceStorageKey,
  DEFAULT_APPEARANCE_SETTINGS,
} from "@machdoch/product-ui/appearance";

export const initialThemeScript = `(() => {
  let theme = ${JSON.stringify(DEFAULT_APPEARANCE_SETTINGS.theme)};
  try {
    const settings = JSON.parse(localStorage.getItem(${JSON.stringify(browserAppearanceStorageKey)}));
    if (settings?.version === 1 && settings.theme === "light") theme = "light";
  } catch (error) {
    console.error("Appearance could not be loaded", error);
  }
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
})();`;
