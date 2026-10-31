"use client";

import { ListFilter, SlidersHorizontal, X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import type { CloudLabel } from "@/lib/cloud-label-contract";
import { unassignedFilter, unestimatedFilter } from "@/lib/issue-scopes";
import { issueGroupings } from "./issue-grouping";
import {
  assigneeOptions,
  cycleOptions,
  priorityOptions,
  projectOptions,
  statusOptions,
} from "./issue-properties";
import { PropertyMenu, type PropertyOption } from "./property-menu";

interface FilterDefinition {
  key: string;
  label: string;
  options: PropertyOption[];
}

function filterDefinitions(
  workspace: CloudWorkspace,
  labels: CloudLabel[],
  teamId: string | null,
): FilterDefinition[] {
  const scopedTeam = teamId ?? undefined;
  const statusChoices = teamId
    ? statusOptions(workspace, [teamId]).map((option) => ({
        ...option,
        value: (JSON.parse(option.value) as { id: string }).id,
      }))
    : [];
  return [
    {
      key: "teamId",
      label: "Team",
      options: workspace.teams.map((team) => ({
        value: team.id,
        label: team.name,
      })),
    },
    ...(statusChoices.length
      ? [{ key: "statusId", label: "Status", options: statusChoices }]
      : []),
    {
      key: "assigneeId",
      label: "Assignee",
      options: assigneeOptions(workspace).map((option) => ({
        ...option,
        value: option.value === "none" ? unassignedFilter : option.value,
      })),
    },
    { key: "priority", label: "Priority", options: priorityOptions },
    {
      key: "projectId",
      label: "Project",
      options: projectOptions(workspace, scopedTeam).slice(1),
    },
    {
      key: "cycleId",
      label: "Cycle",
      options: cycleOptions(workspace, scopedTeam).slice(1),
    },
    ...(labels.length
      ? [
          {
            key: "labelId",
            label: "Label",
            options: labels.map((label) => ({
              value: label.id,
              label: label.archived ? `${label.name} (archived)` : label.name,
            })),
          },
        ]
      : []),
    {
      key: "estimate",
      label: "Estimate",
      options: [{ value: unestimatedFilter, label: "Not estimated" }],
    },
    {
      key: "archived",
      label: "Visibility",
      options: [{ value: "true", label: "Archived issues" }],
    },
  ];
}

export function IssueFilters({
  workspace,
  labels,
  search,
  setFilter,
  clearable,
  onClear,
  children,
}: {
  workspace: CloudWorkspace;
  labels: CloudLabel[];
  search: URLSearchParams;
  setFilter: (name: string, value: string) => void;
  clearable: boolean;
  onClear: () => void;
  children?: ReactNode;
}) {
  const definitions = filterDefinitions(
    workspace,
    labels,
    search.get("teamId"),
  );
  const active = definitions.filter((definition) =>
    search.has(definition.key),
  );
  const available = definitions.filter(
    (definition) => !search.has(definition.key),
  );
  return (
    <div className="cloud-filter-bar">
      <PropertyMenu
        label="Add filter"
        options={available.flatMap((definition) =>
          definition.options.map((option) => ({
            ...option,
            group: definition.label,
            value: `${definition.key}=${option.value}`,
          })),
        )}
        onSelect={(value) => {
          const separator = value.indexOf("=");
          setFilter(value.slice(0, separator), value.slice(separator + 1));
        }}
      >
        <Button variant="ghost" size="sm" className="cloud-filter-button">
          <ListFilter />
          Filter
        </Button>
      </PropertyMenu>
      {active.map((definition) => {
        const value = search.get(definition.key) ?? "";
        const option = definition.options.find(
          (entry) => entry.value === value,
        );
        return (
          <span className="cloud-filter-chip" key={definition.key}>
            <PropertyMenu
              label={`Filter by ${definition.label.toLowerCase()}`}
              options={definition.options}
              value={value}
              onSelect={(next) => setFilter(definition.key, next)}
            >
              <button type="button" className="cloud-filter-chip-value">
                <span>{definition.label}</span>
                {option?.label ?? "Unavailable"}
              </button>
            </PropertyMenu>
            <button
              type="button"
              aria-label={`Remove ${definition.label.toLowerCase()} filter`}
              onClick={() => setFilter(definition.key, "")}
            >
              <X size={12} />
            </button>
          </span>
        );
      })}
      {clearable && (
        <Button variant="ghost" size="sm" onClick={onClear}>
          Clear filters
        </Button>
      )}
      <span className="cloud-filter-spacer" />
      {children}
    </div>
  );
}

export function IssueDisplayMenu({
  search,
  setFilter,
}: {
  search: URLSearchParams;
  setFilter: (name: string, value: string) => void;
}) {
  const group = search.get("group") ?? "status";
  const sort = search.get("sort") ?? "default";
  return (
    <PropertyMenu
      label="Display options"
      align="end"
      value={undefined}
      options={[
        ...Object.entries(issueGroupings).map(([value, label]) => ({
          value: `group=${value}`,
          label: value === group ? `${label} ✓` : label,
          group: "Group by",
        })),
        ...[
          ["default", "Priority"],
          ["updated", "Last updated"],
          ["created", "Created"],
          ["due", "Due date"],
        ].map(([value, label]) => ({
          value: `sort=${value}`,
          label: value === sort ? `${label} ✓` : label!,
          group: "Order by",
        })),
      ]}
      onSelect={(selection) => {
        const [name, value] = selection.split("=") as [string, string];
        setFilter(
          name,
          (name === "group" && value === "status") ||
            (name === "sort" && value === "default")
            ? ""
            : value,
        );
      }}
    >
      <Button variant="ghost" size="sm" className="cloud-filter-button">
        <SlidersHorizontal />
        Display
      </Button>
    </PropertyMenu>
  );
}
