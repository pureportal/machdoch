"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import type { ChatContextKind } from "@/lib/cloud-chat-contract";
import type { CloudIssueSummary, CloudWorkspace } from "@/lib/cloud-contract";
import { cloudRequest } from "../api-client";
import { PropertyMenu } from "../property-menu";
import { contextIcons } from "./agent-turn";
import type { AgentPageEntity } from "./agent-shell";

const groups: Record<ChatContextKind, string> = {
  issue: "Recent issues",
  project: "Projects",
  cycle: "Cycles",
  team: "Teams",
};

export const contextKey = (entity: Pick<AgentPageEntity, "kind" | "id">) =>
  `${entity.kind}:${entity.id}`;

export function AgentContextPicker({
  workspace,
  exclude,
  disabled,
  onAdd,
}: {
  workspace: CloudWorkspace;
  exclude: ReadonlySet<string>;
  disabled: boolean;
  onAdd: (entity: AgentPageEntity) => void;
}) {
  const [issues, setIssues] = useState<CloudIssueSummary[] | null>(null);
  const load = () => {
    if (issues) return;
    setIssues([]);
    void cloudRequest<{ issues: CloudIssueSummary[] }>("issues/search?query=")
      .then((result) => setIssues(result.issues))
      .catch(() => setIssues(null));
  };
  const entities: AgentPageEntity[] = [
    ...(issues ?? []).map((issue) => ({
      kind: "issue" as const,
      id: issue.id,
      label: issue.identifier,
      title: issue.title,
    })),
    ...workspace.projects.map((project) => ({
      kind: "project" as const,
      id: project.id,
      label: project.name,
      title: null,
    })),
    ...workspace.cycles
      .filter((cycle) => cycle.status !== "closed")
      .map((cycle) => ({
        kind: "cycle" as const,
        id: cycle.id,
        label: cycle.name,
        title: null,
      })),
    ...workspace.teams.map((team) => ({
      kind: "team" as const,
      id: team.id,
      label: team.name,
      title: null,
    })),
  ].filter((entity) => !exclude.has(contextKey(entity)));
  return (
    <PropertyMenu
      label="Add context"
      align="end"
      options={entities.map((entity) => {
        const Icon = contextIcons[entity.kind];
        return {
          value: contextKey(entity),
          label: entity.title
            ? `${entity.label} ${entity.title}`
            : entity.label,
          group: groups[entity.kind],
          icon: <Icon size={13} aria-hidden="true" />,
        };
      })}
      onSelect={(value) => {
        const entity = entities.find((entry) => contextKey(entry) === value);
        if (entity) onAdd(entity);
      }}
    >
      <button
        type="button"
        className="cloud-agent-attach"
        aria-label="Add context"
        disabled={disabled}
        onPointerDown={load}
        onFocus={load}
      >
        <Plus size={14} />
      </button>
    </PropertyMenu>
  );
}
