import { useMemo, type JSX } from "react";
import { useOptionalRegisterCommands } from "../../commands/command-context";
import type {
  CommandDefinition,
  CommandPageItem,
} from "../../commands/command-types";
import { getWorkspaceLabel } from "../_helpers/session-shell";
import {
  WorkspaceSelect,
  type WorkspaceSelectOption,
} from "./workspace-select";

export interface WorkspacePickerProps {
  currentWorkspace: string | null;
  workspaceLabel: string;
  recentWorkspaces: string[];
  hasActiveWorkspace: boolean;
  workspaceLocked: boolean;
  allowNotSet?: boolean;
  buttonAriaLabel?: string;
  buttonClassName?: string;
  commandId?: string;
  commandViewId?: string;
  onSelectWorkspace: (workspace: string | null) => void;
  onRemoveWorkspace: (workspace: string) => void;
  onChooseNewWorkspace: () => Promise<void>;
}

const NOT_SET_WORKSPACE_OPTION_ID = "not-set";

const createWorkspaceKey = (workspace: string): string => {
  return workspace.trim().replace(/\\/gu, "/").toLowerCase();
};

const createWorkspaceOptions = (
  allowNotSet: boolean,
  recentWorkspaces: readonly string[],
): WorkspaceSelectOption[] => {
  const options: WorkspaceSelectOption[] = [];

  if (allowNotSet) {
    options.push({
      id: NOT_SET_WORKSPACE_OPTION_ID,
      label: "Not Set",
      path: null,
      icon: "not-set",
    });
  }

  for (const workspace of recentWorkspaces) {
    options.push({
      id: createWorkspaceKey(workspace),
      label: getWorkspaceLabel(workspace),
      path: workspace,
      removable: true,
    });
  }

  return options;
};

export const WorkspacePicker = ({
  currentWorkspace,
  workspaceLabel,
  recentWorkspaces,
  hasActiveWorkspace,
  workspaceLocked,
  allowNotSet = true,
  buttonAriaLabel,
  buttonClassName,
  commandId = "chat.session.workspace.select",
  commandViewId = "chat",
  onSelectWorkspace,
  onRemoveWorkspace,
  onChooseNewWorkspace,
}: WorkspacePickerProps): JSX.Element => {
  const currentWorkspaceKey = currentWorkspace
    ? createWorkspaceKey(currentWorkspace)
    : allowNotSet
      ? NOT_SET_WORKSPACE_OPTION_ID
      : null;
  const workspaceOptions = useMemo(
    () => createWorkspaceOptions(allowNotSet, recentWorkspaces),
    [allowNotSet, recentWorkspaces],
  );
  const workspaceCommands = useMemo<readonly CommandDefinition[]>(
    () => [
      {
        id: commandId,
        title: "Choose workspace",
        group: commandViewId === "ralph" ? "Ralph" : "Chat",
        keywords: ["folder", "project"],
        scope: { kind: "view", ownerId: commandViewId },
        palette: "visible",
        overlayPolicy: "replace-non-modal",
        availability: () =>
          workspaceLocked
            ? {
                state: "disabled",
                reason: "Workspace is locked after the first message",
              }
            : { state: "enabled" },
        children: () => ({
          id: `${commandId}-page`,
          title: "Workspace",
          searchPlaceholder: "Choose workspace",
          groups: [
            {
              id: "workspaces",
              items: [
                ...workspaceOptions.map(
                  (option): CommandPageItem => ({
                    id: option.id,
                    title: option.label,
                    keywords: option.path ? [option.path] : undefined,
                    current: currentWorkspaceKey === option.id,
                    execute: () => onSelectWorkspace(option.path),
                  }),
                ),
                {
                  id: "choose-new",
                  title: "Choose another workspace",
                  keywords: ["browse", "folder"],
                  execute: async () => {
                    await onChooseNewWorkspace();
                  },
                },
              ],
            },
          ],
        }),
      },
      {
        id: `${commandId}.recent.remove`,
        title: "Remove recent workspace",
        group: commandViewId === "ralph" ? "Ralph" : "Chat",
        scope: { kind: "view", ownerId: commandViewId },
        palette: "visible",
        availability: () =>
          workspaceLocked
            ? {
                state: "disabled",
                reason: "Workspace is locked after the first message",
              }
            : recentWorkspaces.length === 0
              ? { state: "disabled", reason: "No recent workspaces" }
              : { state: "enabled" },
        children: () => ({
          id: `${commandId}-remove-page`,
          title: "Remove recent workspace",
          searchPlaceholder: "Choose workspace",
          groups: [
            {
              id: "workspaces",
              items: recentWorkspaces.map((workspace) => ({
                id: createWorkspaceKey(workspace),
                title: getWorkspaceLabel(workspace),
                keywords: [workspace],
                execute: () => onRemoveWorkspace(workspace),
              })),
            },
          ],
        }),
      },
    ],
    [
      commandId,
      commandViewId,
      currentWorkspaceKey,
      onChooseNewWorkspace,
      onRemoveWorkspace,
      onSelectWorkspace,
      recentWorkspaces,
      workspaceLocked,
      workspaceOptions,
    ],
  );
  useOptionalRegisterCommands(workspaceCommands);

  return (
    <WorkspaceSelect
      selectedOptionId={currentWorkspaceKey}
      options={workspaceOptions}
      buttonLabel={workspaceLabel}
      active={hasActiveWorkspace}
      workspaceLocked={workspaceLocked}
      buttonAriaLabel={buttonAriaLabel}
      buttonClassName={buttonClassName}
      description={`Workspace target for this session · ${recentWorkspaces.length} configured.`}
      action={{
        label: "Choose new workspace folder",
        onSelect: onChooseNewWorkspace,
      }}
      selectActionOnTrigger={
        recentWorkspaces.length === 0 && (!hasActiveWorkspace || !allowNotSet)
      }
      onSelectOption={(option) => onSelectWorkspace(option.path)}
      onRemoveOption={(option) => {
        if (option.path) {
          onRemoveWorkspace(option.path);
        }
      }}
    />
  );
};
