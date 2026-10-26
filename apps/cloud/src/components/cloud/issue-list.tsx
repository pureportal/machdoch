"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { LayoutList, Columns3, Search, CircleDot } from "lucide-react";
import {
  issueStates,
  type CloudIssue,
  type CloudWorkspace,
} from "@/lib/cloud-contract";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { CreateIssue } from "./issue-form";
import type { CloudLabel } from "@/lib/cloud-label-contract";
import { IssuePriority } from "./issue-priority";
import { PersonAvatar } from "./person-avatar";

export function IssueList({
  workspace,
  issues,
  labels,
}: {
  workspace: CloudWorkspace;
  issues: CloudIssue[];
  labels: CloudLabel[];
}) {
  const router = useRouter();
  const search = useSearchParams();
  const board = search.get("view") === "board";
  const offset = Number(search.get("offset") ?? 0);
  const query = search.get("query") ?? "";
  const workflow = workspace.workflows.find(
    (entry) => entry.teamId === search.get("teamId"),
  );
  const columns = workflow
    ? workflow.statuses
        .filter(
          (status) =>
            !status.archived ||
            issues.some((issue) => issue.status.id === status.id),
        )
        .map((status) => ({
          id: status.id,
          name: status.name,
          category: status.category,
          issues: issues.filter((issue) => issue.status.id === status.id),
        }))
    : issueStates.map((state) => ({
        id: state,
        name: state[0]!.toUpperCase() + state.slice(1),
        category: state,
        issues: issues.filter((issue) => issue.state === state),
      }));
  const [searchText, setSearchText] = useState(query);
  useEffect(() => setSearchText(query), [query]);
  function filter(name: string, value: string) {
    const next = new URLSearchParams(search);
    if (value) next.set(name, value);
    else next.delete(name);
    if (name !== "offset") next.delete("offset");
    if (name === "teamId") {
      next.delete("projectId");
      next.delete("cycleId");
      next.delete("labelId");
      next.delete("statusId");
    }
    router.push(`/cloud/issues?${next}`);
  }
  return (
    <>
      <header className="cloud-page-header">
        <div className="cloud-page-heading">
          <h1>Issues</h1>
        </div>
        <CreateIssue
          workspace={workspace}
          teamId={search.get("teamId") ?? undefined}
          projectId={search.get("projectId") ?? undefined}
          cycleId={search.get("cycleId") ?? undefined}
        />
      </header>
      <div className="cloud-toolbar">
        <form
          className="cloud-issue-search"
          onSubmit={(event) => {
            event.preventDefault();
            filter(
              "query",
              String(new FormData(event.currentTarget).get("query") ?? ""),
            );
          }}
        >
          <Search size={15} aria-hidden="true" />
          <Input
            name="query"
            aria-label="Search issues"
            placeholder="Search issues…"
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            maxLength={200}
          />
          <Button variant="outline" type="submit" aria-label="Search">
            <Search />
          </Button>
        </form>
        <Select
          aria-label="Filter by team"
          value={search.get("teamId") ?? ""}
          onChange={(event) => filter("teamId", event.target.value)}
        >
          <option value="">All teams</option>
          {workspace.teams.map((team) => (
            <option key={team.id} value={team.id}>
              {team.name}
            </option>
          ))}
        </Select>
        {workflow && (
          <Select
            aria-label="Filter by status"
            value={search.get("statusId") ?? ""}
            onChange={(event) => filter("statusId", event.target.value)}
          >
            <option value="">All statuses</option>
            {workflow.statuses.map((status) => (
              <option key={status.id} value={status.id}>
                {status.name}
                {status.archived ? " (archived)" : ""}
              </option>
            ))}
          </Select>
        )}
        {search.get("teamId") && labels.length > 0 && (
          <Select
            aria-label="Filter by label"
            value={search.get("labelId") ?? ""}
            onChange={(event) => filter("labelId", event.target.value)}
          >
            <option value="">All labels</option>
            {labels.map((label) => (
              <option key={label.id} value={label.id}>
                {label.name}
                {label.archived ? " (archived)" : ""}
              </option>
            ))}
          </Select>
        )}
        <Select
          aria-label="Issue visibility"
          value={search.get("archived") ?? "false"}
          onChange={(event) => filter("archived", event.target.value)}
        >
          <option value="false">Active issues</option>
          <option value="true">Archived issues</option>
        </Select>
        <div className="cloud-view-toggle" role="group" aria-label="Issue view">
          <Button
            variant="outline"
            aria-label="List view"
            aria-pressed={!board}
            onClick={() => filter("view", "list")}
          >
            <LayoutList />
          </Button>
          <Button
            variant="outline"
            aria-label="Board view"
            aria-pressed={board}
            onClick={() => filter("view", "board")}
          >
            <Columns3 />
          </Button>
        </div>
        {[
          "teamId",
          "projectId",
          "cycleId",
          "labelId",
          "statusId",
          "query",
        ].some((name) => search.has(name)) ||
        search.get("archived") === "true" ? (
          <Button
            variant="ghost"
            onClick={() =>
              router.push(`/cloud/issues${board ? "?view=board" : ""}`)
            }
          >
            Clear filters
          </Button>
        ) : null}
      </div>
      {!issues.length ? (
        <div className="cloud-empty">
          <CircleDot aria-hidden="true" />
          <p>
            {search.get("query") || search.get("labelId")
              ? "No matching issues."
              : "No issues yet."}
          </p>
          {!workspace.teams.length && workspace.actor.role !== "viewer" && (
            <Link className="underline" href="/cloud/teams">
              Create a team
            </Link>
          )}
        </div>
      ) : board ? (
        <div className="cloud-board">
          {columns.map((column) => (
            <section
              key={column.id}
              className="cloud-board-column"
              aria-label={column.name}
            >
              <h2>
                <span className="cloud-state" data-state={column.category}>
                  {column.name}
                </span>
                <span>{column.issues.length}</span>
              </h2>
              {column.issues.map((issue) => (
                <Link
                  key={issue.id}
                  className="cloud-board-card"
                  href={`/cloud/issues/${issue.id}`}
                >
                  <span className="cloud-issue-key">{issue.identifier}</span>
                  <span className="cloud-issue-title">{issue.title}</span>
                  {!workflow && (
                    <span className="text-xs text-muted-foreground">
                      {issue.statusName}
                    </span>
                  )}
                  <div className="cloud-board-card-footer">
                    <IssuePriority priority={issue.priority} />
                    {issue.estimate && (
                      <span
                        className="cloud-count"
                        aria-label={`${issue.estimate} points`}
                      >
                        {issue.estimate}
                      </span>
                    )}
                    {workspace.members
                      .filter((member) => member.id === issue.assigneeId)
                      .map((member) => (
                        <PersonAvatar key={member.id} name={member.name} />
                      ))}
                  </div>
                </Link>
              ))}
            </section>
          ))}
        </div>
      ) : (
        <div
          className="cloud-table-wrap cloud-issue-table"
          role="region"
          aria-label="Issues"
          tabIndex={0}
        >
          <table className="cloud-table" role="table">
            <thead>
              <tr>
                <th>Issue</th>
                <th>Status</th>
                <th>Priority</th>
                <th>Assignee</th>
                <th>Estimate</th>
              </tr>
            </thead>
            <tbody role="rowgroup">
              {issues.map((issue) => (
                <tr key={issue.id} role="row">
                  <td role="cell">
                    <Link
                      className="cloud-issue-link"
                      href={`/cloud/issues/${issue.id}`}
                    >
                      <span className="cloud-issue-key">
                        {issue.identifier}
                      </span>
                      <span className="cloud-issue-title">{issue.title}</span>
                    </Link>
                  </td>
                  <td role="cell">
                    <span className="cloud-state" data-state={issue.state}>
                      {issue.statusName}
                    </span>
                  </td>
                  <td role="cell">
                    <IssuePriority priority={issue.priority} />
                  </td>
                  <td role="cell">
                    {issue.assigneeId ? (
                      workspace.members
                        .filter((member) => member.id === issue.assigneeId)
                        .map((member) => (
                          <span key={member.id} className="cloud-assignee">
                            <PersonAvatar name={member.name} />
                            {member.name}
                          </span>
                        ))
                    ) : (
                      <span className="text-muted-foreground">Unassigned</span>
                    )}
                  </td>
                  <td role="cell">
                    <span className="cloud-mobile-cell-label">Estimate </span>
                    {issue.estimate ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(offset > 0 || issues.length === 100) && (
        <div className="cloud-editor-actions mt-5">
          <Button
            variant="outline"
            disabled={offset === 0}
            onClick={() => filter("offset", String(Math.max(0, offset - 100)))}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            disabled={issues.length < 100}
            onClick={() => filter("offset", String(offset + 100))}
          >
            Next
          </Button>
        </div>
      )}
    </>
  );
}
