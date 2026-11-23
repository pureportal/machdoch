"use client";

import { Pencil, Play, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ConfirmButton } from "@/components/confirm-button";
import { Button } from "@/components/ui/button";
import {
  actionNeedsManualIssue,
  type AutomationInput,
  type AutomationSecret,
  type CloudAutomation,
} from "@/lib/cloud-automation-contract";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import { holderCan } from "@/lib/cloud-permissions";
import { cloudRequest, createCommandSender } from "./api-client";
import {
  describeAction,
  describeTrigger,
  type AutomationNames,
} from "./automation-display";
import { AutomationEditor } from "./automation-editor";
import { AutomationWebhookDialog } from "./automation-webhook-dialog";
import { RelativeTime } from "./relative-time";
import { Timestamp } from "./timestamp";
import { useToast } from "./toast";
import type { AutomationOptions } from "./use-automation-options";

function draftOf(automation: CloudAutomation): AutomationInput {
  return {
    name: automation.name,
    teamId: automation.teamId,
    trigger: automation.trigger,
    conditions: automation.conditions,
    actions: automation.actions,
    dailyLimit: automation.dailyLimit,
  };
}

function runnable(automation: CloudAutomation): boolean {
  return (
    automation.trigger.kind === "schedule" ||
    (automation.trigger.kind === "manual" &&
      !/\{\{\s*issue\./.test(JSON.stringify(automation.actions)) &&
      !automation.actions.some(actionNeedsManualIssue))
  );
}

export function LoopAutomationControls({
  workspace,
  automation,
  options,
  killed,
}: {
  workspace: CloudWorkspace;
  automation: CloudAutomation;
  options: AutomationOptions;
  killed: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const sender = useRef(createCommandSender());
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState<string | null>(null);
  const canWrite = holderCan(workspace.actor, "automations.edit");
  const admin = holderCan(workspace.actor, "teams.manage");
  const owner = automation.ownerId === workspace.actor.id;
  const owned = owner && canWrite;
  const canToggle = automation.enabled ? owned || admin : owned;
  const names: AutomationNames = {
    workspace,
    labels: options.labels,
    products: options.products,
    automations: options.automations,
  };

  async function perform(action: () => Promise<unknown>, success?: string) {
    setPending(true);
    try {
      await action();
      router.refresh();
      if (success) toast(success);
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "Try again.", "error");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <div className="cloud-release-actions">
        <button
          type="button"
          role="switch"
          className="cloud-automation-switch"
          aria-checked={automation.enabled}
          aria-label={automation.enabled ? "Pause" : "Enable"}
          disabled={!canToggle || pending}
          onClick={() =>
            void perform(() =>
              sender.current(`automations/${automation.id}/state`, {
                revision: automation.revision,
                enabled: !automation.enabled,
              }),
            )
          }
        />
        {runnable(automation) && canWrite && automation.enabled && !killed && (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() =>
              void perform(
                () =>
                  sender.current(`automations/${automation.id}/run`, {
                    issueId: null,
                  }),
                "Run started",
              )
            }
          >
            <Play />
            Run now
          </Button>
        )}
        {owned && (
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            <Pencil />
            Edit
          </Button>
        )}
        {automation.trigger.kind === "webhook" && owned && (
          <ConfirmButton
            trigger={
              <Button size="sm" variant="outline">
                {automation.webhookConfigured
                  ? "Replace webhook address"
                  : "Create webhook address"}
              </Button>
            }
            title="Replace webhook address?"
            description="The current address stops working."
            actionLabel="Replace"
            destructive={false}
            onConfirm={() =>
              perform(async () => {
                const secret = await cloudRequest<AutomationSecret>(
                  `automations/${automation.id}/webhook`,
                  { method: "POST" },
                );
                setWebhookUrl(secret.webhookUrl);
              })
            }
          />
        )}
        {(owner || admin) && canWrite && (
          <ConfirmButton
            trigger={
              <Button size="sm" variant="ghost" aria-label="Delete automation">
                <Trash2 />
              </Button>
            }
            title="Delete automation?"
            description="Its run history is deleted too."
            actionLabel="Delete"
            onConfirm={async () => {
              try {
                await cloudRequest(`automations/${automation.id}`, {
                  method: "DELETE",
                });
                router.push("/cloud/loops");
              } catch (reason) {
                toast(
                  reason instanceof Error ? reason.message : "Try again.",
                  "error",
                );
              }
            }}
          />
        )}
      </div>
      {automation.error && <p role="alert">{automation.error}</p>}
      <dl className="cloud-automation-facts">
        <dt>When</dt>
        <dd>{describeTrigger(automation.trigger, names)}</dd>
        {automation.conditions.length > 0 && (
          <>
            <dt>If</dt>
            <dd>
              {automation.conditions.length === 1
                ? "1 condition"
                : `${automation.conditions.length} conditions`}
            </dd>
          </>
        )}
        <dt>Then</dt>
        <dd>
          <ol>
            {automation.actions.map((action, index) => (
              <li key={index}>{describeAction(action, names)}</li>
            ))}
          </ol>
        </dd>
        <dt>Team</dt>
        <dd>
          {workspace.teams.find((team) => team.id === automation.teamId)
            ?.name ?? ""}
        </dd>
        <dt>Owner</dt>
        <dd>{automation.ownerName}</dd>
        <dt>Today</dt>
        <dd>
          {automation.runsToday} / {automation.dailyLimit} runs
        </dd>
        {automation.nextRunAt && automation.enabled && (
          <>
            <dt>Next run</dt>
            <dd>
              <Timestamp value={automation.nextRunAt} />
            </dd>
          </>
        )}
        {automation.lastRunAt && (
          <>
            <dt>Last run</dt>
            <dd>
              <RelativeTime value={automation.lastRunAt} />
            </dd>
          </>
        )}
      </dl>
      {editing && (
        <AutomationEditor
          workspace={workspace}
          options={options}
          initial={draftOf(automation)}
          automation={automation}
          onClose={() => setEditing(false)}
          onSaved={async (secret) => {
            router.refresh();
            if (secret.webhookUrl) setWebhookUrl(secret.webhookUrl);
          }}
        />
      )}
      {webhookUrl && (
        <AutomationWebhookDialog
          url={webhookUrl}
          onClose={() => setWebhookUrl(null)}
        />
      )}
    </>
  );
}
