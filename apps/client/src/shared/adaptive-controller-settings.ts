export const resolveAdaptiveControllerEnabled = (
  globalEnabled: boolean,
  workspaceOverride?: boolean | null,
  sessionOverride?: boolean | null,
): boolean => sessionOverride ?? workspaceOverride ?? globalEnabled;
