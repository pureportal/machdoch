import { useSyncExternalStore } from "react";
import type {
  ComposerModelOption,
  ComposerModelProvider,
} from "./composer-model-picker";

export interface RecentComposerModel {
  provider: string;
  model: string;
}

export interface RecentComposerModelOption {
  provider: ComposerModelProvider;
  model: ComposerModelOption;
}

const RECENT_COMPOSER_MODELS_STORAGE_KEY = "machdoch.composer.recent-models";
const MAX_RECENT_COMPOSER_MODELS = 5;
const NO_RECENT_COMPOSER_MODELS: readonly RecentComposerModel[] = [];

const isSameRecentModel = (
  left: RecentComposerModel,
  right: RecentComposerModel,
): boolean => left.provider === right.provider && left.model === right.model;

const isRecentComposerModel = (
  value: unknown,
): value is RecentComposerModel => {
  if (!value || typeof value !== "object") return false;
  const { provider, model } = value as Record<string, unknown>;
  return (
    typeof provider === "string" &&
    provider.length > 0 &&
    typeof model === "string" &&
    model.length > 0
  );
};

export const withRecentComposerModel = (
  recentModels: readonly RecentComposerModel[],
  selection: RecentComposerModel,
): readonly RecentComposerModel[] => {
  const mostRecent = recentModels[0];
  if (mostRecent && isSameRecentModel(mostRecent, selection)) {
    return recentModels;
  }
  return [
    { provider: selection.provider, model: selection.model },
    ...recentModels.filter((entry) => !isSameRecentModel(entry, selection)),
  ].slice(0, MAX_RECENT_COMPOSER_MODELS);
};

export const parseRecentComposerModels = (
  raw: string | null,
): readonly RecentComposerModel[] => {
  if (!raw) return NO_RECENT_COMPOSER_MODELS;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return NO_RECENT_COMPOSER_MODELS;
  }
  if (!Array.isArray(value)) return NO_RECENT_COMPOSER_MODELS;

  const recentModels: RecentComposerModel[] = [];
  for (const entry of value) {
    if (recentModels.length === MAX_RECENT_COMPOSER_MODELS) break;
    if (
      isRecentComposerModel(entry) &&
      !recentModels.some((recent) => isSameRecentModel(recent, entry))
    ) {
      recentModels.push({ provider: entry.provider, model: entry.model });
    }
  }
  return recentModels;
};

export const resolveRecentComposerModels = (
  recentModels: readonly RecentComposerModel[],
  providers: readonly ComposerModelProvider[],
): RecentComposerModelOption[] =>
  recentModels.flatMap((recent) => {
    const provider = providers.find((entry) => entry.id === recent.provider);
    const model = provider?.available
      ? provider.models.find((entry) => entry.id === recent.model)
      : undefined;
    return provider && model ? [{ provider, model }] : [];
  });

const listeners = new Set<() => void>();
let cachedRaw: string | null = null;
let cachedRecentModels = NO_RECENT_COMPOSER_MODELS;

const readRecentComposerModels = (): readonly RecentComposerModel[] => {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(RECENT_COMPOSER_MODELS_STORAGE_KEY);
  } catch (error) {
    console.warn("Failed to read recent models", error);
    return cachedRecentModels;
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedRecentModels = parseRecentComposerModels(raw);
  }
  return cachedRecentModels;
};

const subscribeToRecentComposerModels = (
  listener: () => void,
): (() => void) => {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
};

export const rememberRecentComposerModel = (
  selection: RecentComposerModel,
): void => {
  const current = readRecentComposerModels();
  const next = withRecentComposerModel(current, selection);
  if (next === current) return;
  try {
    window.localStorage.setItem(
      RECENT_COMPOSER_MODELS_STORAGE_KEY,
      JSON.stringify(next),
    );
  } catch (error) {
    console.warn("Failed to save recent models", error);
    return;
  }
  for (const listener of listeners) listener();
};

export const useRecentComposerModels = (): readonly RecentComposerModel[] =>
  useSyncExternalStore(
    subscribeToRecentComposerModels,
    readRecentComposerModels,
    () => NO_RECENT_COMPOSER_MODELS,
  );
