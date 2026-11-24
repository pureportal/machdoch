export type EditorPane = "primary" | "secondary";

export interface EditorTab {
  path: string;
  dirty: boolean;
  pinned: boolean;
  revision: string | null;
  diskRevision: string | null;
  diffAgainstHead: boolean;
  blame: boolean;
}

export interface EditorTabsState {
  tabs: EditorTab[];
  active: Record<EditorPane, string | null>;
  split: boolean;
  focusedPane: EditorPane;
}

export const EMPTY_EDITOR_TABS: EditorTabsState = {
  tabs: [],
  active: { primary: null, secondary: null },
  split: false,
  focusedPane: "primary",
};

const MAX_OPEN_TABS = 30;

const newTab = (path: string, pinned: boolean): EditorTab => ({
  path,
  dirty: false,
  pinned,
  revision: null,
  diskRevision: null,
  diffAgainstHead: false,
  blame: false,
});

export const openEditorTab = (
  state: EditorTabsState,
  path: string,
  {
    pinned = true,
    pane = state.focusedPane,
  }: { pinned?: boolean; pane?: EditorPane } = {},
): EditorTabsState => {
  const existing = state.tabs.find((tab) => tab.path === path);
  let tabs = state.tabs;
  if (existing) {
    if (pinned && !existing.pinned)
      tabs = tabs.map((tab) =>
        tab.path === path ? { ...tab, pinned: true } : tab,
      );
  } else {
    const preview = tabs.find((tab) => !tab.pinned && !tab.dirty);
    tabs = preview
      ? tabs.map((tab) => (tab === preview ? newTab(path, pinned) : tab))
      : [...tabs, newTab(path, pinned)];
    while (tabs.length > MAX_OPEN_TABS) {
      const removable = tabs.find(
        (tab) =>
          !tab.dirty &&
          tab.path !== path &&
          tab.path !== state.active.primary &&
          tab.path !== state.active.secondary,
      );
      if (!removable) break;
      tabs = tabs.filter((tab) => tab !== removable);
    }
  }
  const active = { ...state.active, [pane]: path };
  const replacedPreview = state.tabs.find(
    (tab) =>
      !tab.pinned && !tab.dirty && !tabs.some((next) => next.path === tab.path),
  );
  if (replacedPreview) {
    for (const key of ["primary", "secondary"] as const)
      if (active[key] === replacedPreview.path && key !== pane)
        active[key] = path;
  }
  return {
    ...state,
    tabs,
    active,
    focusedPane: pane,
    split: state.split || pane === "secondary",
  };
};

export const updateEditorTab = (
  state: EditorTabsState,
  path: string,
  update: Partial<Omit<EditorTab, "path">>,
): EditorTabsState => ({
  ...state,
  tabs: state.tabs.map((tab) =>
    tab.path === path
      ? { ...tab, ...update, pinned: tab.pinned || update.dirty === true }
      : tab,
  ),
});

export const editorTabNeedsCloseConfirmation = (
  state: EditorTabsState,
  path: string,
): boolean => state.tabs.some((tab) => tab.path === path && tab.dirty);

export const dirtyEditorTabs = (state: EditorTabsState): string[] =>
  state.tabs.filter((tab) => tab.dirty).map((tab) => tab.path);

export const closeEditorTab = (
  state: EditorTabsState,
  path: string,
): EditorTabsState => {
  const index = state.tabs.findIndex((tab) => tab.path === path);
  if (index < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.path !== path);
  const neighbour = tabs[Math.min(index, tabs.length - 1)]?.path ?? null;
  const active = { ...state.active };
  for (const pane of ["primary", "secondary"] as const)
    if (active[pane] === path) active[pane] = neighbour;
  const split = state.split && active.secondary !== null;
  return {
    ...state,
    tabs,
    active: split ? active : { primary: active.primary, secondary: null },
    split,
    focusedPane: split ? state.focusedPane : "primary",
  };
};

export const renameEditorTab = (
  state: EditorTabsState,
  previousPath: string,
  nextPath: string,
): EditorTabsState => {
  const rename = (path: string | null): string | null => {
    if (path === null) return null;
    if (path === previousPath) return nextPath;
    return path.startsWith(`${previousPath}/`)
      ? `${nextPath}${path.slice(previousPath.length)}`
      : path;
  };
  return {
    ...state,
    tabs: state.tabs.map((tab) => ({ ...tab, path: rename(tab.path)! })),
    active: {
      primary: rename(state.active.primary),
      secondary: rename(state.active.secondary),
    },
  };
};

export const toggleEditorSplit = (state: EditorTabsState): EditorTabsState =>
  state.split
    ? {
        ...state,
        split: false,
        active: { ...state.active, secondary: null },
        focusedPane: "primary",
      }
    : {
        ...state,
        split: state.active.primary !== null,
        active: { ...state.active, secondary: state.active.primary },
        focusedPane: state.active.primary !== null ? "secondary" : "primary",
      };

export type DiskChangeResolution = "none" | "reload" | "conflict";

export const diskChangeResolution = (tab: EditorTab): DiskChangeResolution => {
  if (tab.diskRevision === null || tab.diskRevision === tab.revision)
    return "none";
  return tab.dirty ? "conflict" : "reload";
};

export const parseGoToLine = (
  input: string,
  lineCount: number,
): { line: number; column: number } | null => {
  const match = /^\s*:?(\d+)(?:[:,](\d+))?\s*$/u.exec(input);
  if (!match) return null;
  const line = Math.min(Math.max(Number(match[1]), 1), Math.max(lineCount, 1));
  return { line, column: Math.max(Number(match[2] ?? 1), 1) };
};
