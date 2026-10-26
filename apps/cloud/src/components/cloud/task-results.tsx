"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowUpRight, FolderKanban, Search } from "lucide-react";
import {
  runStates,
  type CloudRun,
} from "@machdoch/fleet-protocol/cloud-execution";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { TaskState } from "./task-state";
import { Timestamp } from "./timestamp";

export function TaskResults({
  runs,
  workspace,
}: {
  runs: CloudRun[];
  workspace: CloudWorkspace;
}) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState("");
  const visible = runs.filter(
    (run) =>
      (!state || run.state === state) &&
      run.title.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <>
      <div className="cloud-toolbar">
        <div className="cloud-issue-search">
          <Search size={15} aria-hidden="true" />
          <Input
            aria-label="Search tasks"
            placeholder="Search tasks…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <Select
          aria-label="Filter tasks by status"
          value={state}
          onChange={(event) => setState(event.target.value)}
        >
          <option value="">All statuses</option>
          {runStates.map((value) => (
            <option key={value} value={value}>
              {value[0]!.toUpperCase() + value.slice(1).replaceAll("_", " ")}
            </option>
          ))}
        </Select>
        {(query || state) && (
          <Button
            variant="ghost"
            onClick={() => {
              setQuery("");
              setState("");
            }}
          >
            Clear filters
          </Button>
        )}
      </div>
      <p className="sr-only" role="status">
        {visible.length} {visible.length === 1 ? "task" : "tasks"}
      </p>
      {visible.length ? (
        <ul className="cloud-task-list" aria-label="AI tasks">
          {visible.map((run) => (
            <li key={run.id}>
              <Link className="cloud-task-row" href={`/cloud/tasks/${run.id}`}>
                <div className="cloud-task-row-title">
                  <span className="cloud-issue-title">{run.title}</span>
                  <ArrowUpRight size={15} aria-hidden="true" />
                </div>
                <TaskState state={run.state} />
                <span className="cloud-task-project">
                  <FolderKanban size={14} aria-hidden="true" />
                  {
                    workspace.projects.find(
                      (project) => project.id === run.projectId,
                    )?.name
                  }
                </span>
                <span className="cloud-task-created">
                  <span className="sr-only">Created </span>
                  <Timestamp value={run.createdAt} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="cloud-empty">
          <Search aria-hidden="true" />
          <p>No matching tasks.</p>
        </div>
      )}
    </>
  );
}
