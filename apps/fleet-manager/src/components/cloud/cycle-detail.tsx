"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import type { CycleDetail } from "@/lib/cloud-cycle-contract";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { createCommandSender, formReference } from "./api-client";

export function CyclePlanning({
  detail,
  workspace,
}: {
  detail: CycleDetail;
  workspace: CloudWorkspace;
}) {
  const { cycle, issues, totals, commitment, committedTotals } = detail;
  const router = useRouter();
  const sender = useRef(createCommandSender());
  const [action, setAction] = useState<"start" | "close" | null>(null);
  const writable = workspace.actor.role !== "viewer";
  const targets = workspace.cycles.filter(
    (candidate) =>
      candidate.teamId === cycle.teamId &&
      candidate.status === "planned" &&
      candidate.startsOn >= cycle.endsOn,
  );
  const carried = new Set(detail.carriedIssueIds);
  const open = (next: "start" | "close") => {
    sender.current = createCommandSender();
    setAction(next);
  };
  return (
    <>
      <header className="cloud-page-header">
        <div>
          <Link className="text-muted-foreground" href="/cloud/cycles">
            Cycles
          </Link>
          <h1>{cycle.name}</h1>
        </div>
        <div className="cloud-editor-actions">
          {writable && cycle.status === "planned" && (
            <Button onClick={() => open("start")}>Start cycle</Button>
          )}
          {writable && cycle.status === "active" && (
            <Button onClick={() => open("close")}>Complete cycle</Button>
          )}
        </div>
      </header>
      <div className="cloud-toolbar text-muted-foreground">
        <span className="capitalize">{cycle.status}</span>
        <span>
          {cycle.startsOn} → {cycle.endsOn}
        </span>
        <span>{cycle.timezone}</span>
      </div>
      <dl className="cloud-cycle-totals">
        <div>
          <dt>Completed issues</dt>
          <dd>
            {totals.completed} / {totals.issues}
          </dd>
        </div>
        <div>
          <dt>Completed points</dt>
          <dd>
            {totals.completedPoints} / {totals.points}
          </dd>
        </div>
        {cycle.capacity !== null && (
          <div>
            <dt>Capacity</dt>
            <dd>{cycle.capacity}</dd>
          </div>
        )}
        {cycle.status !== "planned" && (
          <div>
            <dt>Committed points</dt>
            <dd>{committedTotals.points}</dd>
          </div>
        )}
        {totals.unestimated > 0 && (
          <div>
            <dt>Unestimated issues</dt>
            <dd>{totals.unestimated}</dd>
          </div>
        )}
      </dl>
      {totals.issues > 0 && (
        <progress
          className="cloud-cycle-progress"
          aria-label="Completed issues"
          value={totals.completed}
          max={totals.issues}
        />
      )}
      <div className="cloud-page-header">
        <h2>Issues</h2>
        {cycle.status !== "closed" && (
          <Link
            className="underline"
            href={`/cloud/issues?cycleId=${cycle.id}&teamId=${cycle.teamId}`}
          >
            Plan issues
          </Link>
        )}
      </div>
      {!issues.length ? (
        <div className="cloud-empty">No issues in this cycle.</div>
      ) : (
        <div className="cloud-table-wrap">
          <table className="cloud-table">
            <thead>
              <tr>
                <th>Issue</th>
                <th>Status</th>
                <th>Points</th>
                {cycle.status === "closed" && <th>Carryover</th>}
              </tr>
            </thead>
            <tbody>
              {issues.map((issue) => (
                <tr key={issue.id}>
                  <td>
                    <Link
                      className="cloud-issue-link"
                      href={`/cloud/issues/${issue.id}`}
                    >
                      <span className="cloud-issue-key">
                        {issue.identifier}
                      </span>
                      <span>{issue.title}</span>
                    </Link>
                  </td>
                  <td>
                    <span className="cloud-state" data-state={issue.state}>
                      {detail.statusNames[issue.id]}
                    </span>
                  </td>
                  <td>{issue.estimatePoints ?? "—"}</td>
                  {cycle.status === "closed" && (
                    <td>{carried.has(issue.id) ? "Carried over" : "—"}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {cycle.status !== "planned" && (
        <details className="cloud-cycle-commitment">
          <summary>Original commitment · {commitment.length} issues</summary>
          <ul>
            {commitment.map((issue) => (
              <li key={issue.id}>
                <Link href={`/cloud/issues/${issue.id}`}>
                  {issue.identifier} · {issue.title}
                </Link>
                <span>{issue.estimatePoints ?? "—"} points</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <FormDialog
        open={action !== null}
        onOpenChange={(value) => {
          if (!value) setAction(null);
        }}
        title={action === "start" ? "Start cycle" : "Complete cycle"}
        submitLabel={action === "start" ? "Start cycle" : "Complete cycle"}
        onSubmit={async (form) => {
          await sender.current(
            `cycles/${cycle.id}/commands`,
            action === "start"
              ? { kind: "start", revision: cycle.revision }
              : {
                  kind: "close",
                  revision: cycle.revision,
                  carryoverCycleId: formReference(form, "carryoverCycleId"),
                },
          );
          router.refresh();
        }}
      >
        {action === "start" ? (
          <p>
            The current issues and estimates will become this cycle’s original
            commitment.
          </p>
        ) : (
          <>
            <p>
              Unfinished issues will move to the selected cycle or leave this
              cycle.
            </p>
            <Field label="Move unfinished issues to" htmlFor="carryover-cycle">
              <Select id="carryover-cycle" name="carryoverCycleId">
                <option value="">No cycle</option>
                {targets.map((target) => (
                  <option key={target.id} value={target.id}>
                    {target.name}
                  </option>
                ))}
              </Select>
            </Field>
          </>
        )}
      </FormDialog>
    </>
  );
}
