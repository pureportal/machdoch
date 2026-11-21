"use client";

import { useRouter } from "next/navigation";
import { Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type {
  CloudAutomation,
  CloudAutomationRun,
} from "@/lib/cloud-automation-contract";
import { CloudRequestError, cloudRequest } from "./api-client";
import { PropertyMenu } from "./property-menu";
import { useToast } from "./toast";

const pollMs = 2_000;
const maximumPolls = 150;

export function IssueAutomations({ issueId }: { issueId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [automations, setAutomations] = useState<CloudAutomation[]>([]);
  const [running, setRunning] = useState(false);
  const tracking = useRef<AbortController | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    cloudRequest<CloudAutomation[]>(`automations/manual?issueId=${issueId}`, {
      signal: abort.signal,
    })
      .then(setAutomations)
      .catch(() => setAutomations([]));
    return () => {
      abort.abort();
      tracking.current?.abort();
    };
  }, [issueId]);
  if (!automations.length) return null;
  async function waitForRun(
    runId: string,
    signal: AbortSignal,
  ): Promise<CloudAutomationRun | null> {
    for (let poll = 0; poll < maximumPolls; poll++) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      if (signal.aborted) return null;
      const runs = await cloudRequest<CloudAutomationRun[]>(
        `automations/runs?issueId=${issueId}`,
        { signal },
      ).catch((reason: unknown) => {
        if (
          reason instanceof CloudRequestError &&
          ["network_unavailable", "request_timeout"].includes(reason.code)
        )
          return null;
        throw reason;
      });
      const current = runs?.find((entry) => entry.id === runId);
      if (current && !["queued", "running", "waiting"].includes(current.state))
        return current;
    }
    return null;
  }
  async function run(automation: CloudAutomation) {
    tracking.current?.abort();
    const abort = new AbortController();
    tracking.current = abort;
    setRunning(true);
    try {
      const { runIds } = await cloudRequest<{ runIds: string[] }>(
        `automations/${automation.id}/run`,
        {
          method: "POST",
          key: crypto.randomUUID(),
          body: { issueId },
          signal: abort.signal,
        },
      );
      const [runId] = runIds;
      if (!runId) {
        toast(`${automation.name} did not start for this issue.`, "error");
        return;
      }
      toast(`Running ${automation.name}`);
      const finished = await waitForRun(runId, abort.signal);
      if (abort.signal.aborted) return;
      if (!finished) {
        toast(`${automation.name} is still running.`);
        return;
      }
      toast(
        finished.state === "succeeded"
          ? `${automation.name} finished`
          : (finished.error ?? `${automation.name} ${finished.state}`),
        finished.state === "succeeded" ? undefined : "error",
      );
      router.refresh();
    } catch (reason) {
      if (!abort.signal.aborted)
        toast(reason instanceof Error ? reason.message : "Try again.", "error");
    } finally {
      if (tracking.current === abort) {
        tracking.current = null;
        setRunning(false);
      }
    }
  }
  return (
    <PropertyMenu
      label="Run automation"
      options={automations.map((automation) => ({
        value: automation.id,
        label: automation.name,
        icon: <Zap size={14} aria-hidden="true" />,
      }))}
      onSelect={(id) => {
        const automation = automations.find((entry) => entry.id === id);
        if (automation) void run(automation);
      }}
      align="end"
    >
      <Button variant="ghost" size="sm" disabled={running}>
        <Zap />
        {running ? "Running…" : "Automate"}
      </Button>
    </PropertyMenu>
  );
}
