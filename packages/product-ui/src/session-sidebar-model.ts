export interface SessionSidebarGroup {
  quick: boolean;
  pinned: boolean;
}

export interface SessionSearchEntry {
  searchText: string;
  titleSearchText: string;
  tagSearchText: string;
  projectSearchText: string;
}

export const ALL_SESSION_PROJECTS_FILTER = "__all_projects__";
const NO_WORKSPACE_PROJECT_KEY = "__no_workspace__";

export const isSessionPinnedInSidebar = (group: SessionSidebarGroup): boolean =>
  group.quick || group.pinned;

export const compareSessionsBySidebarGroup = (
  left: SessionSidebarGroup,
  right: SessionSidebarGroup,
): number => {
  const leftPinned = isSessionPinnedInSidebar(left);
  const rightPinned = isSessionPinnedInSidebar(right);
  return leftPinned === rightPinned ? 0 : leftPinned ? -1 : 1;
};

export const getUnpinnedSessionDividerIndex = <T>(
  sessions: readonly T[],
  getGroup: (session: T) => SessionSidebarGroup,
): number | null => {
  const index = sessions.findIndex(
    (session) => !isSessionPinnedInSidebar(getGroup(session)),
  );
  return index > 0 ? index : null;
};

export const normalizeSessionSearchText = (value: string): string =>
  value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, " ")
    .replace(/[^a-z0-9._:/\\-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

export const tokenizeSessionSearchQuery = (value: string): string[] =>
  normalizeSessionSearchText(value).split(" ").filter(Boolean);

export const getSessionProjectId = (
  workspace: string | null | undefined,
): string => {
  if (!workspace?.trim()) return NO_WORKSPACE_PROJECT_KEY;
  const trimmed = workspace.trim();
  return (
    trimmed.replace(/\\/gu, "/").replace(/\/+$/u, "") || trimmed
  ).toLowerCase();
};

export const calculateSessionSearchScore = (
  entry: SessionSearchEntry,
  queryTokens: readonly string[],
): number => {
  let score = 0;
  for (const token of queryTokens) {
    if (!entry.searchText.includes(token)) return -1;
    score += 1;
    if (entry.titleSearchText.includes(token)) score += 6;
    if (entry.titleSearchText.startsWith(token)) score += 4;
    if (entry.tagSearchText.includes(token)) score += 5;
    if (entry.projectSearchText.includes(token)) score += 2;
  }
  return score;
};
