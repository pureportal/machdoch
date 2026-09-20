import {
  CIVITAI_DEFAULT_SEARCH,
  type CivitaiSearch,
} from "../../../core/media/civitai.js";
import {
  loadStoredValue,
  saveStoredValue,
} from "../lib/_helpers/shell-store-storage.helper";

const storageKey = "machdoch.media.civitai-browser";
export function normalizeCivitaiPreferences(value: unknown): CivitaiSearch {
  const result = { ...CIVITAI_DEFAULT_SEARCH };
  if (!value || typeof value !== "object") return result;
  const stored = value as Record<string, unknown>;
  for (const key of [
    "query",
    "modelType",
    "baseModel",
    "tag",
    "username",
  ] as const) {
    if (typeof stored[key] === "string") result[key] = stored[key];
  }
  for (const key of ["nsfw", "favorites"] as const) {
    if (typeof stored[key] === "boolean") result[key] = stored[key];
  }
  if (
    ["Most Downloaded", "Highest Rated", "Newest"].includes(String(stored.sort))
  )
    result.sort = String(stored.sort);
  if (
    ["AllTime", "Year", "Month", "Week", "Day"].includes(String(stored.period))
  )
    result.period = String(stored.period);
  return result;
}

export const loadCivitaiPreferences = async () => {
  await pendingSave;
  return loadStoredValue({
    storageKey,
    fallback: { ...CIVITAI_DEFAULT_SEARCH },
    normalize: normalizeCivitaiPreferences,
    tauriErrorMessage: "Could not load Civitai filters",
    localStorageErrorMessage: "Could not load Civitai filters",
  });
};

let pendingSave = Promise.resolve(true);
export const saveCivitaiPreferences = (value: CivitaiSearch) => {
  pendingSave = pendingSave.then(() =>
    saveStoredValue({
      storageKey,
      value: { ...value, cursor: null },
      tauriErrorMessage: "Could not save Civitai filters",
      localStorageErrorMessage: "Could not save Civitai filters",
    }),
  );
  return pendingSave;
};
