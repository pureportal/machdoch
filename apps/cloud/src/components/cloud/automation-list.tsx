"use client";

import { holderCan } from "@/lib/cloud-permissions";
import { Pencil, Play, Plus, RefreshCw, Trash2, Zap } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmButton } from "@/components/confirm-button";
import { CopyField } from "@/components/copy-field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  actionNeedsManualIssue,
  type AutomationInput,
  type AutomationSecret,
  type CloudAutomation,
  type CloudAutomationRun,
} from "@/lib/cloud-automation-contract";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import { cloudRequest, createCommandSender } from "./api-client";
import {
  describeAction,
  describeTrigger,
  triggerKinds,
  type AutomationNames,
} from "./automation-display";
import { AutomationEditor } from "./automation-editor";
import { AutomationGallery } from "./automation-gallery";
import { AutomationRuns } from "./automation-runs";
import { RelativeTime } from "./relative-time";
import { useToast } from "./toast";
import { useAutomationOptions } from "./use-automation-options";
import { Timestamp } from "./timestamp";

const pollMs = 10_000;

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

export function AutomationList({
  workspace,
  initial,
  initialSelectedId,
}: {
  workspace: CloudWorkspace;
  initial: CloudAutomation[];
  initialSelectedId: string | null;
}) {
  const toast = useToast();
  const options = useAutomationOptions(workspace);
  const [automations, setAutomations] = useState(initial);
  const [selectedId, setSelectedId] = useState(
    initial.find((entry) => entry.id === initialSelectedId)?.id ??
      initial[0]?.id ??
      null,
  );
  const [runs, setRuns] = useState<CloudAutomationRun[]>([]);
  const [gallery, setGallery] = useState(false);
  const [galleryTeam, setGalleryTeam] = useState(workspace.teams[0]?.id ?? "");
  const [editor, setEditor] = useState<{
    draft: AutomationInput;
    automation?: CloudAutomation;
  } | null>(null);
  const [webhookUrl, setWebhookUrl] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const sender = useRef(createCommandSender());
  const selected = automations.find((entry) => entry.id === selectedId);
  const names: AutomationNames = {
    workspace,
    labels: options.labels,
    products: options.products,
    automations,
  };
  const canWrite = holderCan(workspace.actor, "automations.edit");
  const admin = holderCan(workspace.actor, "teams.manage");

  const refresh = useCallback(async () => {
    const next = await cloudRequest<CloudAutomation[]>("automations");
    setAutomations(next);
    setSelectedId((current) =>
      next.some((entry) => entry.id === current)
        ? current
        : (next[0]?.id ?? null),
    );
  }, []);
  const loadRuns = useCallback(async (automationId: string) => {
    setRuns(
      await cloudRequest<CloudAutomationRun[]>(
        `automations/runs?automationId=${automationId}`,
      ),
    );
  }, []);
  useEffect(() => {
    if (!selectedId) {
      setRuns([]);
      return;
    }
    void loadRuns(selectedId).catch((reason: Error) =>
      toast(reason.message, "error"),
    );
    const timer = setInterval(() => {
      if (document.hidden) return;
      void loadRuns(selectedId).catch(() => undefined);
      void refresh().catch(() => undefined);
    }, pollMs);
    return () => clearInterval(timer);
  }, [selectedId, loadRuns, refresh, toast]);

  async function perform(action: () => Promise<unknown>, success?: string) {
    setPending(true);
    try {
      await action();
      await refresh();
      if (selectedId) await loadRuns(selectedId);
      if (success) toast(success);
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "Try again.", "error");
    } finally {
      setPending(false);
    }
  }

  const runnable = (automation: CloudAutomation) =>
    automation.trigger.kind === "schedule" ||
    (automation.trigger.kind === "manual" &&
      !/\{\{\s*issue\./.test(JSON.stringify(automation.actions)) &&
      !automation.actions.some(actionNeedsManualIssue));

  return (
    <>
      <header className="cloud-page-header">
        <h1>Automations</h1>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => void perform(refresh)}
          >
            <RefreshCw />
            Refresh
          </Button>
          {canWrite && workspace.teams.length > 0 && (
            <Button onClick={() => setGallery(true)}>
              <Plus />
              New automation
            </Button>
          )}
        </div>
      </header>
      {options.error && <p role="alert">{options.error}</p>}
      {!automations.length ? (
        canWrite && workspace.teams.length > 0 ? (
          <AutomationGallery
            workspace={workspace}
            options={options}
            teamId={galleryTeam}
            onTeamChange={setGalleryTeam}
            onChoose={(draft) => setEditor({ draft })}
          />
        ) : (
          <div className="cloud-empty">
            <Zap aria-hidden="true" />
            <p>No automations yet.</p>
          </div>
        )
      ) : (
        <div className="cloud-automation-layout">
          <ul className="cloud-automation-list" aria-label="Automations">
            {automations.map((automation) => {
              const Icon =
                triggerKinds.find(
                  (entry) => entry.kind === automation.trigger.kind,
                )?.icon ?? Zap;
              const owned =
                automation.ownerId === workspace.actor.id && canWrite;
              const canToggle = automation.enabled ? owned || admin : owned;
              return (
                <li
                  key={automation.id}
                  aria-current={automation.id === selectedId || undefined}
                >
                  <button
                    type="button"
                    className="cloud-automation-row-button"
                    onClick={() => setSelectedId(automation.id)}
                  >
                    <span className="cloud-icon-tile">
                      <Icon size={16} aria-hidden="true" />
                    </span>
                    <span className="cloud-automation-row-text">
                      <strong>{automation.name}</strong>
                      <span>
                        {describeTrigger(automation.trigger, names)} →{" "}
                        {automation.actions
                          .map((action) => describeAction(action, names))
                          .join(", ")}
                      </span>
                    </span>
                    {automation.error && (
                      <span className="cloud-task-state" data-state="failed">
                        Needs attention
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    role="switch"
                    className="cloud-automation-switch"
                    aria-checked={automation.enabled}
                    aria-label={`${automation.enabled ? "Pause" : "Enable"} ${automation.name}`}
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
                </li>
              );
            })}
          </ul>
          {selected && (
            <aside
              className="cloud-automation-detail"
              aria-label={selected.name}
            >
              <header>
                <h2>{selected.name}</h2>
                <div className="flex flex-wrap gap-2">
                  {runnable(selected) && canWrite && selected.enabled && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() =>
                        void perform(
                          () =>
                            sender.current(`automations/${selected.id}/run`, {
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
                  {selected.ownerId === workspace.actor.id && canWrite && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setEditor({
                          draft: draftOf(selected),
                          automation: selected,
                        })
                      }
                    >
                      <Pencil />
                      Edit
                    </Button>
                  )}
                  {(selected.ownerId === workspace.actor.id || admin) &&
                    canWrite && (
                      <ConfirmButton
                        trigger={
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label="Delete automation"
                          >
                            <Trash2 />
                          </Button>
                        }
                        title="Delete automation?"
                        description="Its run history is deleted too."
                        actionLabel="Delete"
                        onConfirm={() =>
                          perform(() =>
                            cloudRequest(`automations/${selected.id}`, {
                              method: "DELETE",
                            }),
                          )
                        }
                      />
                    )}
                </div>
              </header>
              {selected.error && <p role="alert">{selected.error}</p>}
              <dl className="cloud-automation-facts">
                <dt>When</dt>
                <dd>{describeTrigger(selected.trigger, names)}</dd>
                {selected.conditions.length > 0 && (
                  <>
                    <dt>If</dt>
                    <dd>
                      {selected.conditions.length === 1
                        ? "1 condition"
                        : `${selected.conditions.length} conditions`}
                    </dd>
                  </>
                )}
                <dt>Then</dt>
                <dd>
                  <ol>
                    {selected.actions.map((action, index) => (
                      <li key={index}>{describeAction(action, names)}</li>
                    ))}
                  </ol>
                </dd>
                <dt>Team</dt>
                <dd>
                  {workspace.teams.find((team) => team.id === selected.teamId)
                    ?.name ?? ""}
                </dd>
                <dt>Owner</dt>
                <dd>{selected.ownerName}</dd>
                <dt>Today</dt>
                <dd>
                  {selected.runsToday} / {selected.dailyLimit} runs
                </dd>
                {selected.nextRunAt && selected.enabled && (
                  <>
                    <dt>Next run</dt>
                    <dd>
                      <Timestamp value={selected.nextRunAt} />
                    </dd>
                  </>
                )}
                {selected.lastRunAt && (
                  <>
                    <dt>Last run</dt>
                    <dd>
                      <RelativeTime value={selected.lastRunAt} />
                    </dd>
                  </>
                )}
              </dl>
              {selected.trigger.kind === "webhook" &&
                selected.ownerId === workspace.actor.id &&
                canWrite && (
                  <ConfirmButton
                    trigger={
                      <Button size="sm" variant="outline">
                        {selected.webhookConfigured
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
                          `automations/${selected.id}/webhook`,
                          { method: "POST" },
                        );
                        setWebhookUrl(secret.webhookUrl);
                      })
                    }
                  />
                )}
              <h3>Runs</h3>
              <AutomationRuns runs={runs} />
            </aside>
          )}
        </div>
      )}
      <Dialog open={gallery} onOpenChange={setGallery}>
        <DialogContent className="max-w-3xl" aria-describedby={undefined}>
          <DialogTitle>New automation</DialogTitle>
          <AutomationGallery
            workspace={workspace}
            options={options}
            teamId={galleryTeam}
            onTeamChange={setGalleryTeam}
            onChoose={(draft) => {
              setGallery(false);
              setEditor({ draft });
            }}
          />
        </DialogContent>
      </Dialog>
      {editor && (
        <AutomationEditor
          workspace={workspace}
          options={options}
          initial={editor.draft}
          automation={editor.automation}
          onClose={() => setEditor(null)}
          onSaved={async (secret) => {
            await refresh();
            setSelectedId(secret.id);
            if (secret.webhookUrl) setWebhookUrl(secret.webhookUrl);
          }}
        />
      )}
      <Dialog
        open={webhookUrl !== null}
        onOpenChange={(open) => !open && setWebhookUrl(null)}
      >
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Webhook address</DialogTitle>
          <p className="text-sm text-muted-foreground">
            Copy it now. It is shown only once.
          </p>
          {webhookUrl && (
            <CopyField label="POST JSON to" value={webhookUrl} monospace />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
