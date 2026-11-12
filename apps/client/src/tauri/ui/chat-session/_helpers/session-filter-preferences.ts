import type {
  SessionProjectFilter,
  SessionProjectFilterMode,
} from "@machdoch/product-ui";
import {
  normalizeSessionStatusFilterSelection,
  SESSION_SCOPE_FILTERS,
  SESSION_STATUS_FILTERS,
  type SessionScopeFilter,
  type SessionStatusFilter,
  type SessionStatusFilterSelection,
} from "./session-shell";
import { DEFAULT_SESSION_PROJECT_FILTER } from "./session-project-filter";

export interface SessionFilterPreferences {
  scope: SessionScopeFilter;
  status: SessionStatusFilterSelection;
  projectFilter: SessionProjectFilter;
  tags: readonly string[];
}

export const SESSION_FILTER_STORAGE_KEY = "machdoch.session-filters";

export const DEFAULT_SESSION_FILTER_PREFERENCES: SessionFilterPreferences = {
  scope: "open",
  status: ["any"],
  projectFilter: DEFAULT_SESSION_PROJECT_FILTER,
  tags: [],
};

const SCOPE_IDS: readonly SessionScopeFilter[] = SESSION_SCOPE_FILTERS.map(
  (filter) => filter.id,
);
const STATUS_IDS: readonly SessionStatusFilter[] = SESSION_STATUS_FILTERS.map(
  (filter) => filter.id,
);
const PROJECT_FILTER_MODES: readonly SessionProjectFilterMode[] = [
  "include",
  "exclude",
];

const uniqueTexts = (value: unknown): string[] =>
  Array.isArray(value)
    ? [
        ...new Set(
          value.filter(
            (entry): entry is string =>
              typeof entry === "string" && entry.length > 0,
          ),
        ),
      ]
    : [];

const projectFilterFrom = (value: unknown): SessionProjectFilter => {
  if (!value || typeof value !== "object") {
    return DEFAULT_SESSION_PROJECT_FILTER;
  }

  const record = value as Record<string, unknown>;
  const mode = PROJECT_FILTER_MODES.find((entry) => entry === record.mode);

  return {
    mode: mode ?? DEFAULT_SESSION_PROJECT_FILTER.mode,
    projectIds: uniqueTexts(record.projectIds),
  };
};

export const parseSessionFilterPreferences = (
  raw: string | null,
): SessionFilterPreferences => {
  if (!raw) {
    return DEFAULT_SESSION_FILTER_PREFERENCES;
  }

  let value: unknown;

  try {
    value = JSON.parse(raw);
  } catch {
    return DEFAULT_SESSION_FILTER_PREFERENCES;
  }

  if (!value || typeof value !== "object") {
    return DEFAULT_SESSION_FILTER_PREFERENCES;
  }

  const record = value as Record<string, unknown>;

  return {
    scope:
      SCOPE_IDS.find((scope) => scope === record.scope) ??
      DEFAULT_SESSION_FILTER_PREFERENCES.scope,
    status: normalizeSessionStatusFilterSelection(
      uniqueTexts(record.status).filter((status): status is SessionStatusFilter =>
        STATUS_IDS.includes(status as SessionStatusFilter),
      ),
    ),
    projectFilter: projectFilterFrom(record.projectFilter),
    tags: uniqueTexts(record.tags),
  };
};

export const readSessionFilterPreferences = (): SessionFilterPreferences => {
  try {
    return parseSessionFilterPreferences(
      window.localStorage.getItem(SESSION_FILTER_STORAGE_KEY),
    );
  } catch (error) {
    console.warn("Failed to read session filter preferences", error);
    return DEFAULT_SESSION_FILTER_PREFERENCES;
  }
};

export const writeSessionFilterPreferences = (
  preferences: SessionFilterPreferences,
): void => {
  try {
    window.localStorage.setItem(
      SESSION_FILTER_STORAGE_KEY,
      JSON.stringify(preferences),
    );
  } catch (error) {
    console.warn("Failed to save session filter preferences", error);
  }
};
