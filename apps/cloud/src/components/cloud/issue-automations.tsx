"use client";

import { useRouter } from "next/navigation";
import { Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type {
  CloudAutomation,
  CloudAutomationRun,
} from "@/lib/cloud-automation-contract";
import { cloudRequest } from "./api-client";
import { PropertyMenu } from "./property-menu";
import { useToast } from "./toast";

const pollMs = 2_000;
const maximumPolls = 150;

export function IssueAutomations({ issueId }: { issueId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [automations, setAutomations] = useState<CloudAutomation[]>([]);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    cloudRequest<CloudAutomation[]>(`automations/manual?issueId=${issueId}`, {
      signal: abort.signal,
    })
      .then(setAutomations)
      .catch(() => setAutomations([]));
    return () => abort.abort();
  }, [issueId]);
  if (!automations.length) return null;
  async function run(automation: CloudAutomation) {
    setRunning(true);
    try {
      const { runIds } = await cloudRequest<{ runIds: string[] }>(
        `automations/${automation.id}/run`,
        { method: "POST", key: crypto.randomUUID(), body: { issueId } },
      );
      toast(`Running ${automation.name}`);
      for (let poll = 0; poll < maximumPolls; poll++) {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        const runs = await cloudRequest<CloudAutomationRun[]>(
          `automations/runs?issueId=${issueId}`,
        );
        const current = runs.find((entry) => entry.id === runIds[0]);
        if (
          !current ||
          ["queued", "running", "waiting"].includes(current.state)
        )
          continue;
        toast(
          current.state === "succeeded"
            ? `${automation.name} finished`
            : (current.error ?? `${automation.name} ${current.state}`),
          current.state === "succeeded" ? undefined : "error",
        );
        router.refresh();
        return;
      }
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "Try again.", "error");
    } finally {
      setRunning(false);
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
