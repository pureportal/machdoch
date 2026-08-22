import type { TerminalProfileSettings } from "../lib/shell-store";
import type { WorkspaceShell, WorkspaceShellDiscovery } from "../runtime";

export interface ResolvedTerminalProfiles {
  settings: TerminalProfileSettings;
  availableShells: readonly WorkspaceShell[];
  visibleShells: readonly WorkspaceShell[];
  defaultShellId: string | null;
}

export const terminalProfileSettingsEqual = (
  left: TerminalProfileSettings,
  right: TerminalProfileSettings,
): boolean =>
  left.defaultShellId === right.defaultShellId &&
  (left.visibleShellIds === null
    ? right.visibleShellIds === null
    : right.visibleShellIds !== null &&
      left.visibleShellIds.length === right.visibleShellIds.length &&
      left.visibleShellIds.every(
        (shellId, index) => shellId === right.visibleShellIds?.[index],
      ));

export const resolveTerminalProfiles = (
  settings: TerminalProfileSettings,
  discovery: WorkspaceShellDiscovery,
): ResolvedTerminalProfiles => {
  const availableShellIds = new Set(discovery.shells.map((shell) => shell.id));
  const configuredVisibleShellIds =
    settings.visibleShellIds === null
      ? null
      : new Set(
          settings.visibleShellIds.filter((shellId) =>
            availableShellIds.has(shellId),
          ),
        );
  const configuredVisibleShells =
    configuredVisibleShellIds === null
      ? discovery.shells
      : discovery.shells.filter((shell) =>
          configuredVisibleShellIds.has(shell.id),
        );
  const visibleShells =
    configuredVisibleShells.length > 0
      ? configuredVisibleShells
      : discovery.shells;
  const visibleShellIds = new Set(visibleShells.map((shell) => shell.id));
  const usesAllAvailableShells =
    visibleShells.length === discovery.shells.length;
  const storedVisibleShellIds = usesAllAvailableShells
    ? null
    : visibleShells.map((shell) => shell.id);
  const storedDefaultShellId =
    settings.defaultShellId && visibleShellIds.has(settings.defaultShellId)
      ? settings.defaultShellId
      : null;
  const defaultShellId =
    storedDefaultShellId ??
    (discovery.defaultShellId && visibleShellIds.has(discovery.defaultShellId)
      ? discovery.defaultShellId
      : (visibleShells[0]?.id ?? null));

  return {
    settings: {
      version: 1,
      visibleShellIds: storedVisibleShellIds,
      defaultShellId: storedDefaultShellId,
    },
    availableShells: discovery.shells,
    visibleShells,
    defaultShellId,
  };
};
