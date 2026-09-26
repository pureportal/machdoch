import { useEffect, useState } from "react";
import { mediaStorageKey } from "./media-platform";
import type { MediaAssetFilters } from "../../../core/media/asset-discovery.js";
import type { MediaResourceFilters } from "../../../core/media/resource-discovery.js";
import type {
  MediaAssetTypeFilter,
  MediaLibraryModelFilters,
} from "./components/media-assets-filters";

interface MediaViewPreferences {
  optionsExpanded: boolean;
  assetType: MediaAssetTypeFilter;
  assetQuery: string;
  assetTag: string;
  assetArchitecture: string;
  assetSort: MediaResourceFilters["sort"] | "default";
  assetMediaFilters: MediaAssetFilters;
  assetModelFilters: MediaLibraryModelFilters;
  assetCategories: string[];
  addonSelectedOnly: boolean;
  addonType: "all" | "lora" | "textual-inversion";
  addonFilters: MediaResourceFilters;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isBoolean = (value: unknown): value is boolean =>
  typeof value === "boolean";
const isOneOf =
  <T extends string>(values: readonly T[]) =>
  (value: unknown): value is T =>
    isString(value) && values.includes(value as T);
const isSort = isOneOf(["name", "name-desc", "newest"] as const);

const validators: {
  [K in keyof MediaViewPreferences]: (
    value: unknown,
  ) => value is MediaViewPreferences[K];
} = {
  optionsExpanded: isBoolean,
  assetType: isOneOf([
    "all",
    "model",
    "lora",
    "embedding",
    "image",
    "openpose",
    "video",
    "svg",
  ]),
  assetQuery: isString,
  assetTag: isString,
  assetArchitecture: isString,
  assetSort: isOneOf(["default", "name", "name-desc", "newest"]),
  assetMediaFilters: (value): value is MediaAssetFilters =>
    isRecord(value) &&
    isOneOf(["all", "generated", "added"])(value.origin) &&
    isOneOf(["all", "landscape", "portrait", "square"])(value.orientation) &&
    isString(value.format) &&
    isString(value.dateFrom) &&
    isString(value.dateTo),
  assetModelFilters: (value): value is MediaLibraryModelFilters =>
    isRecord(value) &&
    isOneOf(["all", "local", "remote"])(value.target) &&
    isOneOf(["all", "ready", "needs-attention"])(value.readiness),
  assetCategories: (value): value is string[] =>
    Array.isArray(value) && value.every(isString),
  addonSelectedOnly: isBoolean,
  addonType: isOneOf(["all", "lora", "textual-inversion"]),
  addonFilters: (value): value is MediaResourceFilters =>
    isRecord(value) &&
    isString(value.query) &&
    isString(value.categoryId) &&
    isString(value.tag) &&
    isSort(value.sort),
};

export function useMediaViewPreference<K extends keyof MediaViewPreferences>(
  key: K,
  initialValue: MediaViewPreferences[K],
) {
  const storageKey = mediaStorageKey(`machdoch.media.view.${key}`);
  const [value, setValue] = useState<MediaViewPreferences[K]>(() => {
    try {
      const stored: unknown = JSON.parse(
        window.localStorage.getItem(storageKey) ?? "null",
      );
      return validators[key](stored) ? stored : initialValue;
    } catch (error) {
      console.error("Could not restore Media Studio view preferences", error);
      return initialValue;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(value));
    } catch (error) {
      console.error("Could not save Media Studio view preferences", error);
    }
  }, [storageKey, value]);
  return [value, setValue] as const;
}
