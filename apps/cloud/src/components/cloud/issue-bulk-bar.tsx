"use client";

import { Archive, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CloudIssueSummary, CloudWorkspace } from "@/lib/cloud-contract";
import type { ApplyChange } from "./issue-cells";
import {
  assigneeOptions,
  cycleOptions,
  estimateOptions,
  priorityOptions,
  projectOptions,
  referenceValue,
  statusChange,
  statusOptions,
} from "./issue-properties";
import { PropertyMenu, type PropertyOption } from "./property-menu";

function BulkMenu({
  label,
  options,
  onSelect,
}: {
  label: string;
  options: PropertyOption[];
  onSelect: (value: string) => void;
}) {
  return (
    <PropertyMenu label={label} options={options} onSelect={onSelect}>
      <Button variant="ghost" size="sm">
        {label}
      </Button>
    </PropertyMenu>
  );
}

export function IssueBulkBar({
  issues,
  workspace,
  apply,
  onClear,
}: {
  issues: CloudIssueSummary[];
  workspace: CloudWorkspace;
  apply: ApplyChange;
  onClear: () => void;
}) {
  const teamIds = [...new Set(issues.map((issue) => issue.teamId))];
  const teamId = teamIds.length === 1 ? teamIds[0] : undefined;
  return (
    <div className="cloud-bulk-bar" role="toolbar" aria-label="Selected issues">
      <span className="cloud-bulk-count">{issues.length} selected</span>
      <BulkMenu
        label="Status"
        options={statusOptions(workspace, teamIds)}
        onSelect={(value) => apply(issues, statusChange(value))}
      />
      <BulkMenu
        label="Priority"
        options={priorityOptions}
        onSelect={(value) =>
          apply(issues, { priority: value as CloudIssueSummary["priority"] })
        }
      />
      <BulkMenu
        label="Assignee"
        options={assigneeOptions(workspace)}
        onSelect={(value) =>
          apply(issues, { assigneeId: referenceValue(value) })
        }
      />
      {teamId && (
        <>
          <BulkMenu
            label="Project"
            options={projectOptions(workspace, teamId)}
            onSelect={(value) =>
              apply(issues, { projectId: referenceValue(value) })
            }
          />
          <BulkMenu
            label="Cycle"
            options={cycleOptions(workspace, teamId)}
            onSelect={(value) =>
              apply(issues, { cycleId: referenceValue(value) })
            }
          />
          <BulkMenu
            label="Estimate"
            options={estimateOptions(
              workspace.teams.find((team) => team.id === teamId),
            )}
            onSelect={(value) =>
              apply(issues, { estimate: referenceValue(value) })
            }
          />
        </>
      )}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => apply(issues, { archived: !issues[0]!.archived })}
      >
        <Archive />
        {issues[0]!.archived ? "Restore" : "Archive"}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Clear selection"
        onClick={onClear}
      >
        <X />
      </Button>
    </div>
  );
}
