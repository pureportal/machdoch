import { useMemo, useRef } from "react";
import {
  ALL_SESSION_PROJECTS_FILTER,
  type SessionSidebarCommandState,
  type SessionSidebarAction,
} from "@machdoch/product-ui";
import {
  asPaletteCommands,
  type CommandDefinition,
  type CommandPageItem,
} from "@machdoch/media-studio/tauri/ui/commands/command-types.js";
import { useOptionalRegisterCommands } from "@machdoch/media-studio/tauri/ui/commands/command-context.js";

export function createSessionSidebarCommands(
  state: () => SessionSidebarCommandState,
): readonly CommandDefinition[] {
  const scope = { kind: "view", ownerId: "chat" } as const;
  const availability = (enabled: boolean, reason: string) =>
    state().disabled
      ? { state: "disabled" as const, reason: "Wait for the device to finish." }
      : enabled
        ? { state: "enabled" as const }
        : { state: "disabled" as const, reason };
  return asPaletteCommands([
    {
      id: "chat.sessions.import",
      title: "Import sessions",
      group: "Chat",
      scope,
      overlayPolicy: "replace-non-modal",
      availability: () =>
        availability(
          Boolean(state().importSessions),
          "Session import is unavailable.",
        ),
      execute: () => state().importSessions?.(),
    },
    {
      id: "chat.sessions.export",
      title: "Export visible sessions",
      group: "Chat",
      scope,
      availability: () =>
        availability(
          Boolean(state().exportSessions),
          "Session export is unavailable.",
        ),
      execute: () => state().exportSessions?.(),
    },
    {
      id: "chat.sessions.scope-filter.select",
      title: "Filter sessions by scope",
      group: "Chat",
      scope,
      children: () => ({
        id: "chat-sessions-scope-filter",
        title: "Session scope",
        searchPlaceholder: "Choose scope",
        numericSelection: true,
        groups: [
          {
            id: "scopes",
            items: state().scopeOptions.map((filter, index) => ({
              id: filter.id,
              title: filter.label,
              current: state().scope === filter.id,
              numericKey: String(index + 1) as CommandPageItem["numericKey"],
              execute: () => state().onScopeChange(filter.id),
            })),
          },
        ],
      }),
    },
    {
      id: "chat.sessions.status-filter.toggle",
      title: "Filter sessions by status",
      group: "Chat",
      scope,
      children: () => ({
        id: "chat-sessions-status-filter",
        title: "Session status",
        searchPlaceholder: "Choose status",
        groups: [
          {
            id: "statuses",
            items: state().statusOptions.map((filter) => ({
              id: filter.id,
              title: filter.label,
              current: state().statuses.includes(filter.id),
              execute: () => state().onStatusToggle(filter.id),
            })),
          },
        ],
      }),
    },
    {
      id: "chat.sessions.workspace-filter.select",
      title: "Filter sessions by workspace",
      group: "Chat",
      scope,
      availability: () =>
        availability(
          state().projects.length > 1,
          "Only one workspace is present",
        ),
      children: () => ({
        id: "chat-sessions-workspace-filter",
        title: "Session workspace",
        searchPlaceholder: "Choose workspace",
        groups: [
          {
            id: "workspaces",
            items: [
              {
                id: ALL_SESSION_PROJECTS_FILTER,
                title: "All workspaces",
                current: state().project === ALL_SESSION_PROJECTS_FILTER,
                execute: () =>
                  state().onProjectChange(ALL_SESSION_PROJECTS_FILTER),
              },
              ...state().projects.map((project) => ({
                id: project.id,
                title: project.label,
                ...(project.path ? { keywords: [project.path] } : {}),
                current: state().project === project.id,
                execute: () => state().onProjectChange(project.id),
              })),
            ],
          },
        ],
      }),
    },
    {
      id: "chat.sessions.tag-filter.toggle",
      title: "Filter sessions by tag",
      group: "Chat",
      scope,
      availability: () =>
        availability(state().availableTags.length > 0, "No session tags"),
      children: () => ({
        id: "chat-sessions-tag-filter",
        title: "Session tags",
        searchPlaceholder: "Choose tag",
        groups: [
          {
            id: "tags",
            items: state().availableTags.map((tag) => ({
              id: tag,
              title: tag,
              current: state().tags.some(
                (selected) => selected.toLowerCase() === tag.toLowerCase(),
              ),
              execute: () => state().onTagToggle(tag),
            })),
          },
        ],
      }),
    },
    ...(
      [
        ["pin", "Pin or unpin session"],
        ["duplicate", "Duplicate session"],
        ["archive", "Archive session"],
        ["delete", "Delete empty session"],
      ] as const
    ).map(
      ([action, title]: readonly [
        SessionSidebarAction,
        string,
      ]): CommandDefinition => ({
        id: `chat.sessions.${action}.select`,
        title,
        group: "Chat",
        scope,
        availability: () =>
          availability(
            state().sessions.some((session) => session.actions[action]),
            "No eligible visible sessions",
          ),
        children: () => ({
          id: `chat-sessions-${action}`,
          title,
          searchPlaceholder: "Choose session",
          groups: [
            {
              id: "sessions",
              items: state()
                .sessions.filter((session) => session.actions[action])
                .map((session) => ({
                  id: session.id,
                  title:
                    action === "pin"
                      ? `${session.pinned ? "Unpin" : "Pin"} ${session.title}`
                      : session.title,
                  keywords: [session.workspace ?? "", ...session.tags].filter(
                    Boolean,
                  ),
                  execute: () => state().onSessionAction(action, session.id),
                })),
            },
          ],
        }),
      }),
    ),
  ]);
}

export function SessionSidebarCommands(
  state: SessionSidebarCommandState,
): null {
  const latest = useRef(state);
  latest.current = state;
  const commands = useMemo(
    () => createSessionSidebarCommands(() => latest.current),
    [],
  );
  useOptionalRegisterCommands(commands);
  return null;
}
