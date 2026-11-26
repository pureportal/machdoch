"use client";

import { ArrowLeft, OctagonX, Play } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ConfirmButton } from "@/components/confirm-button";
import { Button } from "@/components/ui/button";
import type { CloudAutomation } from "@/lib/cloud-automation-contract";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import type { CloudLoop } from "@/lib/cloud-loop-contract";
import { holderCan } from "@/lib/cloud-permissions";
import type { CloudSchedule } from "@/lib/cloud-schedule-contract";
import { useAgentPageEntity } from "./agent/agent-shell";
import { createCommandSender } from "./api-client";
import { LoopAutomationControls } from "./loop-automation-controls";
import { LoopConfigForm } from "./loop-config-form";
import { LoopMemory } from "./loop-memory";
import { LoopRuns } from "./loop-runs";
import { LoopScheduleControls } from "./loop-schedule-controls";
import { Timestamp } from "./timestamp";
import { useToast } from "./toast";
import { useAutomationOptions } from "./use-automation-options";

export function LoopDetail({
  workspace,
  loop,
  automation,
  schedule,
  workerAvailable,
}: {
  workspace: CloudWorkspace;
  loop: CloudLoop;
  automation: CloudAutomation | null;
  schedule: CloudSchedule | null;
  workerAvailable: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const options = useAutomationOptions(workspace);
  const sender = useRef(createCommandSender());
  const [pending, setPending] = useState(false);
  const owned = loop.ownerId === workspace.actor.id;
  const canEdit = holderCan(workspace.actor, "automations.edit");
  const canKill = owned || holderCan(workspace.actor, "teams.manage");
  useAgentPageEntity({
    kind: "loop",
    id: loop.id,
    label: loop.name,
    title: null,
  });

  async function setKilled(killed: boolean) {
    setPending(true);
    try {
      await sender.current(`loops/${loop.id}/kill`, { killed });
      sender.current = createCommandSender();
      router.refresh();
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "Try again.", "error");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="cloud-loop-detail">
      <header className="cloud-page-header">
        <div className="flex items-center gap-2">
          <Button asChild size="icon" variant="ghost" aria-label="Automations">
            <Link href="/cloud/automations">
              <ArrowLeft />
            </Link>
          </Button>
          <h1>{loop.name}</h1>
          {loop.killed && (
            <span className="cloud-task-state" data-state="failed">
              Killed
            </span>
          )}
        </div>
        {canKill &&
          (loop.killed ? (
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => void setKilled(false)}
            >
              <Play />
              Revive
            </Button>
          ) : (
            <ConfirmButton
              trigger={
                <Button variant="outline" disabled={pending}>
                  <OctagonX />
                  Kill
                </Button>
              }
              title={`Kill ${loop.name}?`}
              description="Runs stop and no new runs start until it is revived."
              actionLabel="Kill"
              onConfirm={() => setKilled(true)}
            />
          ))}
      </header>
      {options.error && <p role="alert">{options.error}</p>}
      {automation && (
        <LoopAutomationControls
          workspace={workspace}
          automation={automation}
          options={options}
          killed={loop.killed}
        />
      )}
      {schedule && (
        <LoopScheduleControls
          workspace={workspace}
          schedule={schedule}
          workerAvailable={workerAvailable}
        />
      )}
      <section className="cloud-loop-section" aria-labelledby="loop-config">
        <header>
          <h2 id="loop-config">Configuration</h2>
          {loop.consecutiveFailures > 0 && (
            <span className="cloud-task-state" data-state="failed">
              {loop.consecutiveFailures === 1
                ? "1 failure in a row"
                : `${loop.consecutiveFailures} failures in a row`}
            </span>
          )}
        </header>
        <LoopConfigForm
          key={loop.revision}
          loop={loop}
          options={options}
          editable={owned && canEdit}
        />
      </section>
      <LoopMemory loopId={loop.id} memory={loop.memory} editable={owned} />
      {loop.kind === "automation" && (
        <LoopRuns loopId={loop.id} owned={owned} canAct={canEdit} />
      )}
      <section className="cloud-loop-section" aria-labelledby="loop-revisions">
        <header>
          <h2 id="loop-revisions">Revisions</h2>
        </header>
        <ol className="cloud-loop-revisions">
          {loop.revisions.map((revision) => (
            <li key={revision.revision}>
              <span>#{revision.revision}</span>
              <Timestamp value={revision.createdAt} />
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
