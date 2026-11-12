export const WORKSPACE_DETAIL_SECTIONS = [
  "git",
  "files",
  "run",
  "knowledge",
  "research",
  "memory",
  "settings",
] as const;

export type WorkspaceDetailSection = (typeof WORKSPACE_DETAIL_SECTIONS)[number];

export const WORKSPACE_GIT_SECTIONS = [
  "changes",
  "branches",
  "stashes",
  "worktrees",
  "history",
  "pull-requests",
  "remotes",
] as const;

export type WorkspaceGitSection = (typeof WORKSPACE_GIT_SECTIONS)[number];

export type WorkspaceGitScope = "all" | "repository";

export interface WorkspaceViewPreferences {
  section: WorkspaceDetailSection;
  gitSection: WorkspaceGitSection;
  selectedWorkspaceKey: string | null;
  activeWorkspaceKey: string | null;
  repositoryRoots: Readonly<Record<string, string>>;
  singleRepositoryWorkspaces: readonly string[];
}

export const WORKSPACE_VIEW_STORAGE_KEY = "machdoch.workspace-view";

export const DEFAULT_WORKSPACE_VIEW_PREFERENCES: WorkspaceViewPreferences = {
  section: "git",
  gitSection: "changes",
  selectedWorkspaceKey: null,
  activeWorkspaceKey: null,
  repositoryRoots: {},
  singleRepositoryWorkspaces: [],
};

const MAX_REMEMBERED_REPOSITORIES = 64;

const oneOf = <T extends string>(
  values: readonly T[],
  value: unknown,
  fallback: T,
): T => (values.includes(value as T) ? (value as T) : fallback);

const optionalText = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const repositoryRootsFrom = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === "string" && entry[1].length > 0,
      )
      .slice(-MAX_REMEMBERED_REPOSITORIES),
  );
};

const workspaceKeysFrom = (value: unknown): string[] =>
  Array.isArray(value)
    ? [
        ...new Set(
          value.filter(
            (entry): entry is string =>
              typeof entry === "string" && entry.length > 0,
          ),
        ),
      ].slice(-MAX_REMEMBERED_REPOSITORIES)
    : [];

export const parseWorkspaceViewPreferences = (
  raw: string | null,
): WorkspaceViewPreferences => {
  if (!raw) return DEFAULT_WORKSPACE_VIEW_PREFERENCES;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return DEFAULT_WORKSPACE_VIEW_PREFERENCES;
  }
  if (!value || typeof value !== "object") {
    return DEFAULT_WORKSPACE_VIEW_PREFERENCES;
  }
  const record = value as Record<string, unknown>;
  return {
    section: oneOf(
      WORKSPACE_DETAIL_SECTIONS,
      record.section,
      DEFAULT_WORKSPACE_VIEW_PREFERENCES.section,
    ),
    gitSection: oneOf(
      WORKSPACE_GIT_SECTIONS,
      record.gitSection,
      DEFAULT_WORKSPACE_VIEW_PREFERENCES.gitSection,
    ),
    selectedWorkspaceKey: optionalText(record.selectedWorkspaceKey),
    activeWorkspaceKey: optionalText(record.activeWorkspaceKey),
    repositoryRoots: repositoryRootsFrom(record.repositoryRoots),
    singleRepositoryWorkspaces: workspaceKeysFrom(
      record.singleRepositoryWorkspaces,
    ),
  };
};

export const workspaceGitScope = (
  preferences: WorkspaceViewPreferences,
  workspaceKey: string,
): WorkspaceGitScope =>
  preferences.singleRepositoryWorkspaces.includes(workspaceKey)
    ? "repository"
    : "all";

export const withWorkspaceGitScope = (
  preferences: WorkspaceViewPreferences,
  workspaceKey: string,
  scope: WorkspaceGitScope,
): WorkspaceViewPreferences => {
  if (workspaceGitScope(preferences, workspaceKey) === scope) {
    return preferences;
  }
  const others = preferences.singleRepositoryWorkspaces.filter(
    (key) => key !== workspaceKey,
  );
  return {
    ...preferences,
    singleRepositoryWorkspaces:
      scope === "repository"
        ? workspaceKeysFrom([...others, workspaceKey])
        : others,
  };
};

export const withRememberedRepository = (
  preferences: WorkspaceViewPreferences,
  workspaceKey: string,
  repositoryRoot: string,
): WorkspaceViewPreferences => {
  if (preferences.repositoryRoots[workspaceKey] === repositoryRoot) {
    return preferences;
  }
  const { [workspaceKey]: _previous, ...others } = preferences.repositoryRoots;
  return {
    ...preferences,
    repositoryRoots: repositoryRootsFrom({
      ...others,
      [workspaceKey]: repositoryRoot,
    }),
  };
};

export const reconcileWorkspaceSelection = (
  preferences: WorkspaceViewPreferences,
  currentSelection: string | null,
  activeWorkspaceKey: string | null,
  availableKeys: readonly string[],
): { selection: string | null; preferences: WorkspaceViewPreferences } => {
  const available = (key: string | null): key is string =>
    key !== null && availableKeys.includes(key);
  if (
    available(activeWorkspaceKey) &&
    activeWorkspaceKey !== preferences.activeWorkspaceKey
  ) {
    return {
      selection: activeWorkspaceKey,
      preferences: {
        ...preferences,
        activeWorkspaceKey,
        selectedWorkspaceKey: activeWorkspaceKey,
      },
    };
  }
  const selection = available(preferences.selectedWorkspaceKey)
    ? preferences.selectedWorkspaceKey
    : available(currentSelection)
      ? currentSelection
      : available(activeWorkspaceKey)
        ? activeWorkspaceKey
        : (availableKeys[0] ?? null);
  return { selection, preferences };
};

let currentPreferences: WorkspaceViewPreferences | null = null;

const storage = (): Storage | null =>
  typeof window === "undefined" ? null : window.localStorage;

export const readWorkspaceViewPreferences = (): WorkspaceViewPreferences => {
  if (currentPreferences) return currentPreferences;
  try {
    currentPreferences = parseWorkspaceViewPreferences(
      storage()?.getItem(WORKSPACE_VIEW_STORAGE_KEY) ?? null,
    );
  } catch (error) {
    console.warn("Failed to read workspace view preferences", error);
    currentPreferences = DEFAULT_WORKSPACE_VIEW_PREFERENCES;
  }
  return currentPreferences;
};

export const writeWorkspaceViewPreferences = (
  update: (current: WorkspaceViewPreferences) => WorkspaceViewPreferences,
): void => {
  const previous = readWorkspaceViewPreferences();
  const next = update(previous);
  if (next === previous) return;
  currentPreferences = next;
  try {
    storage()?.setItem(WORKSPACE_VIEW_STORAGE_KEY, JSON.stringify(next));
  } catch (error) {
    console.warn("Failed to save workspace view preferences", error);
  }
};
