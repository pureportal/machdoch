export type AppearanceTheme = "dark" | "light";
export type AppearanceDensity = "comfortable" | "compact";
export type AppearanceAccent = "sky" | "emerald" | "violet" | "amber";

export interface AppearanceSettings {
  version: 1;
  theme: AppearanceTheme;
  density: AppearanceDensity;
  accent: AppearanceAccent;
}

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  version: 1,
  theme: "dark",
  density: "comfortable",
  accent: "sky",
};

export function normalizeAppearanceSettings(
  value: unknown,
): AppearanceSettings {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1
  )
    return DEFAULT_APPEARANCE_SETTINGS;
  const settings = value as Record<string, unknown>;
  return {
    version: 1,
    theme: settings.theme === "light" ? "light" : "dark",
    density: settings.density === "compact" ? "compact" : "comfortable",
    accent:
      settings.accent === "emerald" ||
      settings.accent === "violet" ||
      settings.accent === "amber"
        ? settings.accent
        : "sky",
  };
}

export function applyAppearanceSettings(settings: AppearanceSettings): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = settings.theme;
  root.dataset.density = settings.density;
  root.dataset.accent = settings.accent;
  root.classList.toggle("dark", settings.theme === "dark");
  root.style.colorScheme = settings.theme;
}
