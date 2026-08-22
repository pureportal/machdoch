import type { RalphFlowScope } from "../../../../core/ralph.js";

export type RalphFlowLibraryMode = RalphFlowScope | "all";

export const RALPH_FLOW_SCOPES = [
  "workspace",
  "user",
] as const satisfies readonly RalphFlowScope[];

export const RALPH_FLOW_LIBRARY_MODES = [
  "workspace",
  "user",
  "all",
] as const satisfies readonly RalphFlowLibraryMode[];

export const RALPH_FLOW_SCOPE_LABELS = {
  workspace: "Workspace",
  user: "Global",
} as const satisfies Record<RalphFlowScope, string>;

export const RALPH_FLOW_LIBRARY_LABELS = {
  ...RALPH_FLOW_SCOPE_LABELS,
  all: "All",
} as const satisfies Record<RalphFlowLibraryMode, string>;

export const DEFAULT_RALPH_FLOW_SCOPE: RalphFlowScope = "workspace";

export const normalizeRalphFlowScope = (
  value: string | null | undefined,
): RalphFlowScope => {
  return value === "user" ? "user" : DEFAULT_RALPH_FLOW_SCOPE;
};

export const getDefaultCreationScope = (
  libraryMode: RalphFlowLibraryMode,
): RalphFlowScope => {
  return libraryMode === "user" ? "user" : DEFAULT_RALPH_FLOW_SCOPE;
};

export const isFlowScopeVisibleInLibraryMode = (
  scope: RalphFlowScope,
  libraryMode: RalphFlowLibraryMode,
): boolean => libraryMode === "all" || libraryMode === scope;
