export const TERMINAL_COLORS = [
  "sky",
  "emerald",
  "amber",
  "rose",
  "violet",
  "slate",
] as const;

export type TerminalColor = (typeof TERMINAL_COLORS)[number];
export type TerminalDock = "bottom" | "side" | "window";
export type TerminalSplitDirection = "horizontal" | "vertical";

export interface TerminalTabLayout {
  id: string;
  shellId: string;
  name: string | null;
  color: TerminalColor | null;
  cwd: string | null;
}

export interface TerminalLayout {
  tabs: TerminalTabLayout[];
  activeTabId: string | null;
  split: { tabId: string; direction: TerminalSplitDirection } | null;
  dock: TerminalDock;
  size: number;
  scrollbackLines: number;
}

export const DEFAULT_TERMINAL_LAYOUT: TerminalLayout = {
  tabs: [],
  activeTabId: null,
  split: null,
  dock: "bottom",
  size: 260,
  scrollbackLines: 10_000,
};

export const MIN_SCROLLBACK_LINES = 1_000;
export const MAX_SCROLLBACK_LINES = 100_000;

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const optionalText = (value: unknown, maximum: number): string | null =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim().slice(0, maximum)
    : null;

export const normalizeTerminalLayout = (value: unknown): TerminalLayout => {
  if (!isRecord(value)) return DEFAULT_TERMINAL_LAYOUT;
  const tabs = (Array.isArray(value.tabs) ? value.tabs : [])
    .filter(isRecord)
    .flatMap((tab): TerminalTabLayout[] => {
      const id = optionalText(tab.id, 80);
      const shellId = optionalText(tab.shellId, 240);
      if (!id || !shellId) return [];
      return [
        {
          id,
          shellId,
          name: optionalText(tab.name, 60),
          color: TERMINAL_COLORS.includes(tab.color as TerminalColor)
            ? (tab.color as TerminalColor)
            : null,
          cwd: optionalText(tab.cwd, 2048),
        },
      ];
    })
    .slice(0, 8);
  const ids = new Set(tabs.map((tab) => tab.id));
  const activeTabId =
    typeof value.activeTabId === "string" && ids.has(value.activeTabId)
      ? value.activeTabId
      : (tabs[0]?.id ?? null);
  const splitDirection: TerminalSplitDirection | null =
    isRecord(value.split) &&
    (value.split.direction === "horizontal" ||
      value.split.direction === "vertical")
      ? value.split.direction
      : null;
  const split =
    isRecord(value.split) &&
    typeof value.split.tabId === "string" &&
    ids.has(value.split.tabId) &&
    value.split.tabId !== activeTabId &&
    splitDirection
      ? { tabId: value.split.tabId, direction: splitDirection }
      : null;
  return {
    tabs,
    activeTabId,
    split,
    dock:
      value.dock === "side" || value.dock === "window" ? value.dock : "bottom",
    size: clamp(Number(value.size) || DEFAULT_TERMINAL_LAYOUT.size, 120, 2000),
    scrollbackLines: clamp(
      Math.round(
        Number(value.scrollbackLines) ||
          DEFAULT_TERMINAL_LAYOUT.scrollbackLines,
      ),
      MIN_SCROLLBACK_LINES,
      MAX_SCROLLBACK_LINES,
    ),
  };
};

const updateTab = (
  layout: TerminalLayout,
  id: string,
  update: (tab: TerminalTabLayout) => TerminalTabLayout,
): TerminalLayout => ({
  ...layout,
  tabs: layout.tabs.map((tab) => (tab.id === id ? update(tab) : tab)),
});

export const addTerminalTab = (
  layout: TerminalLayout,
  tab: TerminalTabLayout,
): TerminalLayout => ({
  ...layout,
  tabs: [...layout.tabs, tab],
  activeTabId: tab.id,
});

export const renameTerminalTab = (
  layout: TerminalLayout,
  id: string,
  name: string,
): TerminalLayout =>
  updateTab(layout, id, (tab) => ({ ...tab, name: optionalText(name, 60) }));

export const colorTerminalTab = (
  layout: TerminalLayout,
  id: string,
  color: TerminalColor | null,
): TerminalLayout => updateTab(layout, id, (tab) => ({ ...tab, color }));

export const setTerminalTabCwd = (
  layout: TerminalLayout,
  id: string,
  cwd: string | null,
): TerminalLayout => updateTab(layout, id, (tab) => ({ ...tab, cwd }));

export const splitTerminal = (
  layout: TerminalLayout,
  tabId: string,
  direction: TerminalSplitDirection,
): TerminalLayout =>
  tabId === layout.activeTabId || !layout.tabs.some((tab) => tab.id === tabId)
    ? layout
    : { ...layout, split: { tabId, direction } };

export const unsplitTerminal = (layout: TerminalLayout): TerminalLayout => ({
  ...layout,
  split: null,
});

export const activateTerminalTab = (
  layout: TerminalLayout,
  id: string,
): TerminalLayout => {
  if (!layout.tabs.some((tab) => tab.id === id)) return layout;
  const split =
    layout.split?.tabId === id && layout.activeTabId
      ? { ...layout.split, tabId: layout.activeTabId }
      : layout.split;
  return { ...layout, activeTabId: id, split };
};

export const closeTerminalTab = (
  layout: TerminalLayout,
  id: string,
): TerminalLayout => {
  const index = layout.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return layout;
  const tabs = layout.tabs.filter((tab) => tab.id !== id);
  let activeTabId = layout.activeTabId;
  let split = layout.split;
  if (split?.tabId === id) split = null;
  if (activeTabId === id) {
    activeTabId =
      split?.tabId ?? tabs[Math.min(index, tabs.length - 1)]?.id ?? null;
    if (split?.tabId === activeTabId) split = null;
  }
  return { ...layout, tabs, activeTabId, split };
};

export const terminalTabTitle = (
  tab: Pick<TerminalTabLayout, "name">,
  fallback: string,
): string => tab.name ?? fallback;

const LAYOUT_PREFIX = "machdoch.terminal-layout:";
const SCROLLBACK_PREFIX = "machdoch.terminal-scrollback:";
export const MAX_SAVED_SCROLLBACK_CHARS = 256 * 1024;

interface LayoutStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export const readTerminalLayout = (
  storage: LayoutStorage | null,
  workspaceKey: string,
): TerminalLayout => {
  try {
    const raw = storage?.getItem(`${LAYOUT_PREFIX}${workspaceKey}`);
    return normalizeTerminalLayout(raw ? JSON.parse(raw) : null);
  } catch {
    return DEFAULT_TERMINAL_LAYOUT;
  }
};

export const writeTerminalLayout = (
  storage: LayoutStorage | null,
  workspaceKey: string,
  layout: TerminalLayout,
): void => {
  try {
    storage?.setItem(`${LAYOUT_PREFIX}${workspaceKey}`, JSON.stringify(layout));
  } catch (error) {
    console.error("Could not save the terminal layout", error);
  }
};

export const readTerminalScrollback = (
  storage: LayoutStorage | null,
  workspaceKey: string,
  tabId: string,
): string | null => {
  try {
    return (
      storage?.getItem(`${SCROLLBACK_PREFIX}${workspaceKey}:${tabId}`) ?? null
    );
  } catch {
    return null;
  }
};

export const writeTerminalScrollback = (
  storage: LayoutStorage | null,
  workspaceKey: string,
  tabId: string,
  serialized: string | null,
): void => {
  const key = `${SCROLLBACK_PREFIX}${workspaceKey}:${tabId}`;
  try {
    if (!serialized) {
      storage?.removeItem(key);
      return;
    }
    storage?.setItem(key, serialized.slice(-MAX_SAVED_SCROLLBACK_CHARS));
  } catch (error) {
    console.error("Could not save the terminal history", error);
  }
};

export const restorableTerminalTabs = (
  tabs: readonly TerminalTabLayout[],
  visibleShellIds: readonly string[],
  defaultShellId: string | null,
): TerminalTabLayout[] => {
  const fallback =
    defaultShellId && visibleShellIds.includes(defaultShellId)
      ? defaultShellId
      : (visibleShellIds[0] ?? null);
  return tabs.flatMap((tab) => {
    if (visibleShellIds.includes(tab.shellId)) return [tab];
    return fallback ? [{ ...tab, shellId: fallback }] : [];
  });
};

const COMMAND_HISTORY_PREFIX = "machdoch.terminal-commands:";
export const MAX_COMMAND_HISTORY = 100;

export const rememberTerminalCommand = (
  history: readonly string[],
  command: string,
): string[] => {
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > 2000) return [...history];
  return [trimmed, ...history.filter((entry) => entry !== trimmed)].slice(
    0,
    MAX_COMMAND_HISTORY,
  );
};

export const readTerminalCommandHistory = (
  storage: LayoutStorage | null,
  workspaceKey: string,
): string[] => {
  try {
    const raw = storage?.getItem(`${COMMAND_HISTORY_PREFIX}${workspaceKey}`);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed
          .filter((entry): entry is string => typeof entry === "string")
          .slice(0, MAX_COMMAND_HISTORY)
      : [];
  } catch {
    return [];
  }
};

export const writeTerminalCommandHistory = (
  storage: LayoutStorage | null,
  workspaceKey: string,
  history: readonly string[],
): void => {
  try {
    storage?.setItem(
      `${COMMAND_HISTORY_PREFIX}${workspaceKey}`,
      JSON.stringify(history),
    );
  } catch (error) {
    console.error("Could not save the terminal command history", error);
  }
};
