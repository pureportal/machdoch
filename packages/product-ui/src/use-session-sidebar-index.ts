import type { ProductSession } from "@machdoch/fleet-protocol";
import type { SessionIndexQuery } from "@machdoch/fleet-protocol/session-data";
import { useState } from "react";
import type { SessionDataSource } from "./session-data";
import { ALL_SESSION_PROJECTS_FILTER } from "./session-sidebar-model";
import { useSessionIndex } from "./use-session-index";

export function useSessionSidebarIndex(
  source: SessionDataSource | undefined,
  sessions: ProductSession[],
) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<SessionIndexQuery["scope"]>("all");
  const [selectedStatuses, setSelectedStatuses] = useState<
    SessionIndexQuery["statuses"]
  >([]);
  const [project, setProject] = useState(ALL_SESSION_PROJECTS_FILTER);
  const [tags, setTags] = useState<string[]>([]);
  const remote = useSessionIndex(
    source,
    {
      offset: 0,
      limit: 80,
      query,
      scope,
      statuses: selectedStatuses,
      project,
      tags,
    },
    JSON.stringify(
      sessions.map(
        ({ id, updatedAt, messageCount, unread, archivedAt, pinnedAt }) => [
          id,
          updatedAt,
          messageCount,
          unread,
          archivedAt,
          pinnedAt,
        ],
      ),
    ),
  );
  return {
    query,
    setQuery,
    scope,
    setScope,
    selectedStatuses,
    setSelectedStatuses,
    project,
    setProject,
    tags,
    setTags,
    remote,
  };
}
