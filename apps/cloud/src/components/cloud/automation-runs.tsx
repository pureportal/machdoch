"use client";

import Link from "next/link";
import { CircleCheck, CircleSlash, CircleX } from "lucide-react";
import type { CloudAutomationRun } from "@/lib/cloud-automation-contract";
import { actionKinds, triggerKinds } from "./automation-display";
import { RelativeTime } from "./relative-time";

const runStateLabels: Record<CloudAutomationRun["state"], string> = {
  queued: "Queued",
  running: "Running",
  waiting: "Waiting for Agent",
  succeeded: "Succeeded",
  failed: "Failed",
  skipped: "Skipped",
};

const stepIcons = {
  succeeded: CircleCheck,
  failed: CircleX,
  skipped: CircleSlash,
};

export function AutomationRuns({
  runs,
  showAutomation = false,
}: {
  runs: CloudAutomationRun[];
  showAutomation?: boolean;
}) {
  if (!runs.length)
    return <p className="cloud-automation-muted">No runs yet.</p>;
  return (
    <ol className="cloud-automation-runs">
      {runs.map((run) => (
        <li key={run.id}>
          <div className="cloud-automation-run-heading">
            <span className="cloud-task-state" data-state={run.state}>
              {runStateLabels[run.state]}
            </span>
            {showAutomation && <strong>{run.automationName}</strong>}
            <span>
              {triggerKinds.find((entry) => entry.kind === run.trigger)
                ?.label ?? run.trigger}
            </span>
            {run.issueIdentifier && (
              <Link href={`/cloud/issues/${run.issueIdentifier}`}>
                {run.issueIdentifier}
              </Link>
            )}
            {run.actorName && <span>{run.actorName}</span>}
            <span className="cloud-automation-spacer" />
            <RelativeTime value={run.createdAt} />
          </div>
          {run.steps.length > 0 && (
            <ul className="cloud-automation-run-steps">
              {run.steps.map((step, index) => {
                const Icon = stepIcons[step.state];
                const label =
                  actionKinds.find((entry) => entry.kind === step.kind)
                    ?.label ?? step.kind;
                return (
                  <li key={index} data-state={step.state}>
                    <Icon size={13} aria-label={step.state} />
                    <span>{label}</span>
                    <span className="cloud-automation-muted">
                      {step.detail}
                    </span>
                    {step.link && <Link href={step.link}>Open</Link>}
                  </li>
                );
              })}
            </ul>
          )}
          {run.chatId && (
            <Link
              className="cloud-automation-run-link"
              href={`/cloud/chat/${run.chatId}`}
            >
              Open conversation
            </Link>
          )}
          {run.error && run.state !== "failed" && (
            <p className="cloud-automation-muted">{run.error}</p>
          )}
        </li>
      ))}
    </ol>
  );
}
