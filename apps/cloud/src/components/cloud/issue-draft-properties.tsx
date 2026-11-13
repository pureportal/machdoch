"use client";

import { ChevronDown } from "lucide-react";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import {
  assigneeOptions,
  cycleOptions,
  noValue,
  priorityOptions,
  projectOptions,
  statusOptions,
} from "./issue-properties";
import { PropertyMenu, type PropertyOption } from "./property-menu";

export interface IssueDraft {
  status: string;
  priority: string;
  assigneeId: string;
  projectId: string;
  cycleId: string;
}

export function draftForTeam(
  workspace: CloudWorkspace,
  teamId: string,
  draft: Partial<IssueDraft>,
): IssueDraft {
  const workflow = workspace.workflows.find((entry) => entry.teamId === teamId);
  const statuses = statusOptions(workspace, [teamId]);
  const fallback = workflow?.statuses.find(
    (status) => status.id === workflow.defaultStatusId,
  );
  const owned = (options: PropertyOption[], value: string | undefined) =>
    value && options.some((option) => option.value === value) ? value : noValue;
  return {
    status:
      draft.status && statuses.some((option) => option.value === draft.status)
        ? draft.status
        : fallback
          ? JSON.stringify({ id: fallback.id, revision: fallback.revision })
          : (statuses[0]?.value ?? ""),
    priority: draft.priority ?? "none",
    assigneeId: owned(assigneeOptions(workspace), draft.assigneeId),
    projectId: owned(projectOptions(workspace, teamId), draft.projectId),
    cycleId: owned(cycleOptions(workspace, teamId), draft.cycleId),
  };
}

function Chip({
  label,
  options,
  value,
  onSelect,
}: {
  label: string;
  options: PropertyOption[];
  value: string;
  onSelect: (value: string) => void;
}) {
  const selected = options.find((option) => option.value === value);
  return (
    <PropertyMenu
      label={label}
      options={options}
      value={value}
      onSelect={onSelect}
    >
      <button
        type="button"
        className="cloud-draft-chip"
        aria-label={`${label}: ${selected?.label ?? "None"}`}
      >
        {selected?.icon}
        <span>{selected?.label ?? label}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
    </PropertyMenu>
  );
}

export function IssueDraftProperties({
  workspace,
  teamId,
  draft,
  onChange,
}: {
  workspace: CloudWorkspace;
  teamId: string;
  draft: IssueDraft;
  onChange: (draft: IssueDraft) => void;
}) {
  const set = (key: keyof IssueDraft) => (value: string) =>
    onChange({ ...draft, [key]: value });
  return (
    <div
      className="cloud-draft-properties"
      role="group"
      aria-label="Properties"
    >
      <Chip
        label="Status"
        options={statusOptions(workspace, [teamId])}
        value={draft.status}
        onSelect={set("status")}
      />
      <Chip
        label="Priority"
        options={priorityOptions}
        value={draft.priority}
        onSelect={set("priority")}
      />
      <Chip
        label="Assignee"
        options={assigneeOptions(workspace)}
        value={draft.assigneeId}
        onSelect={set("assigneeId")}
      />
      <Chip
        label="Project"
        options={projectOptions(workspace, teamId)}
        value={draft.projectId}
        onSelect={set("projectId")}
      />
      <Chip
        label="Cycle"
        options={cycleOptions(workspace, teamId)}
        value={draft.cycleId}
        onSelect={set("cycleId")}
      />
    </div>
  );
}
