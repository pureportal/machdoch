"use client";

import Link from "next/link";
import { ArrowLeft, CalendarRange, Users } from "lucide-react";
import { CycleOverview } from "./cycle-overview";
import { CycleIssues } from "./cycle-issues";
import { CycleDates } from "./cycle-dates";
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
  const { cycle, commitment } = detail;
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
  const open = (next: "start" | "close") => {
    sender.current = createCommandSender();
    setAction(next);
  };
  return (
    <>
      <header className="cloud-page-header">
        <div>
          <Link className="cloud-cycle-back" href="/cloud/cycles">
            <ArrowLeft size={13} aria-hidden="true" />
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
      <div className="cloud-cycle-context">
        <span className="cloud-cycle-status" data-status={cycle.status}>
          {cycle.status}
        </span>
        <span>
          <CalendarRange size={14} aria-hidden="true" />
          <CycleDates cycle={cycle} />
        </span>
        <span>{cycle.timezone}</span>
        <Link href={`/cloud/issues?teamId=${cycle.teamId}`}>
          <Users size={14} aria-hidden="true" />
          {workspace.teams.find((team) => team.id === cycle.teamId)?.name}
        </Link>
      </div>
      <CycleOverview detail={detail} />
      <CycleIssues detail={detail} />
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
