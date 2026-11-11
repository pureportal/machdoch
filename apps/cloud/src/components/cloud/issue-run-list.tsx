"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Bot } from "lucide-react";
import type { CloudRun } from "@machdoch/fleet-protocol/cloud-execution";
import { cloudRequest } from "./api-client";
import { TaskState } from "./task-state";

const pollMs = 10_000;

export function IssueRunList({ issueId }: { issueId: string }) {
  const [runs, setRuns] = useState<CloudRun[]>([]);
  useEffect(() => {
    const abort = new AbortController();
    const load = () =>
      cloudRequest<{ runs: CloudRun[] }>(`runs?issueId=${issueId}`, {
        signal: abort.signal,
      })
        .then((result) => setRuns(result.runs))
        .catch(() => undefined);
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, pollMs);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [issueId]);
  if (!runs.length) return null;
  return (
    <section className="cloud-aside-section" aria-label="AI tasks">
      <header>
        <h2>AI tasks</h2>
      </header>
      <ul className="cloud-aside-runs">
        {runs.slice(0, 5).map((run) => (
          <li key={run.id}>
            <Bot size={14} aria-hidden="true" />
            <Link href={`/cloud/tasks/${run.id}`} prefetch={false}>
              {run.title}
            </Link>
            <TaskState state={run.state} />
          </li>
        ))}
      </ul>
    </section>
  );
}
