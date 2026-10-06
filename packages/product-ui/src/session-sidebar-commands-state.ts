import type { SessionIndexQuery } from "@machdoch/fleet-protocol/session-data";

export type SessionSidebarAction = "pin" | "duplicate" | "archive" | "delete";
export type SessionSidebarStatus =
  | SessionIndexQuery["statuses"][number]
  | "any";

export interface SessionSidebarCommandState {
  disabled: boolean;
  sessions: readonly {
    id: string;
    title: string;
    workspace?: string | null | undefined;
    tags: readonly string[];
    pinned: boolean;
    actions: Readonly<Record<SessionSidebarAction, boolean>>;
  }[];
  scope: SessionIndexQuery["scope"];
  scopeOptions: readonly { id: SessionIndexQuery["scope"]; label: string }[];
  statuses: readonly SessionSidebarStatus[];
  statusOptions: readonly { id: SessionSidebarStatus; label: string }[];
  project: string;
  projects: readonly {
    id: string;
    label: string;
    path?: string | null | undefined;
  }[];
  tags: readonly string[];
  availableTags: readonly string[];
  importSessions?: (() => void) | undefined;
  exportSessions?: (() => void | Promise<void>) | undefined;
  onScopeChange: (scope: SessionIndexQuery["scope"]) => void;
  onStatusToggle: (status: SessionSidebarStatus) => void;
  onProjectChange: (project: string) => void;
  onTagToggle: (tag: string) => void;
  onSessionAction: (
    action: SessionSidebarAction,
    sessionId: string,
  ) => void | Promise<void>;
}
