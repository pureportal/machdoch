"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { CopyField } from "@/components/copy-field";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import {
  codeAccessModes,
  loopPlacements,
  type CodeAccessMode,
  type LoopPlacement,
  type LoopSettings,
  type LoopSettingsInput,
  type LoopSourceSecret,
  type LoopSourceState,
} from "@/lib/cloud-loop-contract";
import { placementLabels } from "@/lib/loop-capabilities";
import { formatLoopCost } from "@/lib/loop-list";
import {
  centsToDollars,
  dollarsToCents,
  loopSourceLabels,
  rejectionLabels,
} from "@/lib/loop-labels";
import { cloudRequest, createCommandSender } from "./api-client";
import { targetOptions } from "./loop-executor-fields";
import { RelativeTime } from "./relative-time";
import { useToast } from "./toast";
import { useAutomationOptions } from "./use-automation-options";

const codeAccessLabels: Record<CodeAccessMode, string> = {
  all: "All repositories",
  selected: "Selected repositories",
};

export function LoopSettingsPanel({
  workspace,
  settings,
  sources,
  repositories,
}: {
  workspace: CloudWorkspace;
  settings: LoopSettings;
  sources: LoopSourceState[];
  repositories: { id: string; fullName: string }[];
}) {
  return (
    <div className="cloud-settings">
      <LoopSettingsForm
        workspace={workspace}
        settings={settings}
        repositories={repositories}
      />
      <LoopSourceList sources={sources} />
    </div>
  );
}

function LoopSettingsForm({
  workspace,
  settings,
  repositories,
}: {
  workspace: CloudWorkspace;
  settings: LoopSettings;
  repositories: { id: string; fullName: string }[];
}) {
  const router = useRouter();
  const toast = useToast();
  const options = useAutomationOptions(workspace);
  const sender = useRef(createCommandSender());
  const [draft, setDraft] = useState<LoopSettingsInput>({
    enabled: settings.enabled,
    codeAccess: settings.codeAccess,
    repositoryIds: settings.repositoryIds,
    defaultPlacement: settings.defaultPlacement,
    defaultTargetId: settings.defaultTargetId,
    runBudgetCapCents: settings.runBudgetCapCents,
    monthBudgetCapCents: settings.monthBudgetCapCents,
    retentionDays: settings.retentionDays,
  });
  const [runCap, setRunCap] = useState(
    centsToDollars(settings.runBudgetCapCents),
  );
  const [monthCap, setMonthCap] = useState(
    centsToDollars(settings.monthBudgetCapCents),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const targets = targetOptions(draft.defaultPlacement, options, null);

  async function save() {
    setPending(true);
    setError("");
    try {
      await sender.current(
        "loops/settings",
        {
          revision: settings.revision,
          settings: {
            ...draft,
            repositoryIds:
              draft.codeAccess === "selected" ? draft.repositoryIds : [],
            runBudgetCapCents: dollarsToCents(runCap),
            monthBudgetCapCents: dollarsToCents(monthCap),
          },
        },
        "PUT",
      );
      router.refresh();
      toast("Saved");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      className="cloud-settings-section cloud-loop-config"
      aria-label="Loops"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <fieldset disabled={pending} className="grid gap-5">
        <Label className="cloud-automation-check">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) =>
              setDraft({ ...draft, enabled: event.target.checked })
            }
          />
          Loops enabled
        </Label>
        <dl className="cloud-automation-facts" aria-label="Usage this month">
          <dt>Runs</dt>
          <dd>{settings.usage.runs}</dd>
          <dt>Tokens</dt>
          <dd>{settings.usage.tokens.toLocaleString()}</dd>
          <dt>Cost</dt>
          <dd>{formatLoopCost(settings.usage.costCents)}</dd>
        </dl>
        <div className="cloud-loop-fields">
          <Field label="Code access" htmlFor="loop-settings-code">
            <Select
              id="loop-settings-code"
              value={draft.codeAccess}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  codeAccess: event.target.value as CodeAccessMode,
                })
              }
            >
              {codeAccessModes.map((mode) => (
                <option key={mode} value={mode}>
                  {codeAccessLabels[mode]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Default runner" htmlFor="loop-settings-placement">
            <Select
              id="loop-settings-placement"
              value={draft.defaultPlacement}
              onChange={(event) => {
                const placement = event.target.value as LoopPlacement;
                setDraft({
                  ...draft,
                  defaultPlacement: placement,
                  defaultTargetId:
                    placement === "automatic"
                      ? null
                      : (targetOptions(placement, options, null)[0]?.id ??
                        null),
                });
              }}
            >
              {loopPlacements.map((placement) => (
                <option key={placement} value={placement}>
                  {placementLabels[placement]}
                </option>
              ))}
            </Select>
          </Field>
          {draft.defaultPlacement === "runner_pool" ? (
            <Field label="Pool" htmlFor="loop-settings-target">
              <Input
                id="loop-settings-target"
                required
                maxLength={200}
                value={draft.defaultTargetId ?? ""}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    defaultTargetId: event.target.value || null,
                  })
                }
              />
            </Field>
          ) : (
            draft.defaultPlacement !== "automatic" && (
              <Field label="Target" htmlFor="loop-settings-target">
                <Select
                  id="loop-settings-target"
                  required
                  value={draft.defaultTargetId ?? ""}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      defaultTargetId: event.target.value || null,
                    })
                  }
                >
                  {!targets.some(
                    (target) => target.id === draft.defaultTargetId,
                  ) && (
                    <option value={draft.defaultTargetId ?? ""} disabled>
                      {draft.defaultTargetId ?? "None available"}
                    </option>
                  )}
                  {targets.map((target) => (
                    <option key={target.id} value={target.id}>
                      {target.label}
                    </option>
                  ))}
                </Select>
              </Field>
            )
          )}
          <Field label="Run budget cap ($)" htmlFor="loop-settings-run-cap">
            <Input
              id="loop-settings-run-cap"
              inputMode="decimal"
              value={runCap}
              onChange={(event) => setRunCap(event.target.value)}
            />
          </Field>
          <Field
            label="Monthly budget cap ($)"
            htmlFor="loop-settings-month-cap"
          >
            <Input
              id="loop-settings-month-cap"
              inputMode="decimal"
              value={monthCap}
              onChange={(event) => setMonthCap(event.target.value)}
            />
          </Field>
          <Field
            label="Keep run history (days)"
            htmlFor="loop-settings-retention"
          >
            <Input
              id="loop-settings-retention"
              type="number"
              min={7}
              max={3650}
              required
              value={draft.retentionDays}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  retentionDays: event.target.valueAsNumber,
                })
              }
            />
          </Field>
        </div>
        {draft.codeAccess === "selected" && (
          <fieldset className="cloud-loop-capabilities">
            <legend>Repositories</legend>
            {repositories.map((repository) => (
              <Label key={repository.id} className="cloud-automation-check">
                <input
                  type="checkbox"
                  checked={draft.repositoryIds.includes(repository.id)}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      repositoryIds: event.target.checked
                        ? [...draft.repositoryIds, repository.id]
                        : draft.repositoryIds.filter(
                            (id) => id !== repository.id,
                          ),
                    })
                  }
                />
                {repository.fullName}
              </Label>
            ))}
          </fieldset>
        )}
        {error && <p role="alert">{error}</p>}
        <div className="cloud-release-actions">
          <Button type="submit">{pending ? "Saving…" : "Save"}</Button>
        </div>
      </fieldset>
    </form>
  );
}

function LoopSourceList({ sources }: { sources: LoopSourceState[] }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState("");
  const [secret, setSecret] = useState<LoopSourceSecret | null>(null);

  async function run(source: string, action: () => Promise<void>) {
    setPending(source);
    try {
      await action();
      router.refresh();
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "Try again.", "error");
    } finally {
      setPending("");
    }
  }

  return (
    <section className="cloud-settings-section" aria-labelledby="loop-sources">
      <header>
        <h2 id="loop-sources">Sources</h2>
      </header>
      <ul className="cloud-member-list">
        {sources.map((state) => (
          <li key={state.source}>
            <div>
              <strong>{loopSourceLabels[state.source]}</strong>
              <span>
                {state.trustedBy === 1
                  ? "Trusted by 1 loop"
                  : `Trusted by ${state.trustedBy} loops`}
              </span>
              {state.lastRejection && (
                <span>
                  {rejectionLabels[state.lastRejection.reason]} ·{" "}
                  <RelativeTime value={state.lastRejection.at} compact />
                </span>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending === state.source}
              onClick={() =>
                void run(state.source, async () => {
                  setSecret(
                    await cloudRequest<LoopSourceSecret>(
                      `loops/sources/${state.source}/secret`,
                      { method: "POST" },
                    ),
                  );
                })
              }
            >
              <RefreshCw />
              {state.configured ? "Rotate secret" : "Create secret"}
            </Button>
            <Label className="cloud-automation-check">
              <input
                type="checkbox"
                checked={state.enabled}
                disabled={pending === state.source}
                onChange={(event) => {
                  const enabled = event.target.checked;
                  void run(state.source, () =>
                    cloudRequest(`loops/sources/${state.source}`, {
                      method: "PATCH",
                      body: { enabled },
                    }).then(() => undefined),
                  );
                }}
              />
              On
            </Label>
          </li>
        ))}
      </ul>
      {secret && (
        <div className="grid gap-3" role="status">
          <CopyField label="URL" value={secret.url} monospace />
          <CopyField label="Secret" value={secret.secret} monospace />
          <div className="cloud-release-actions">
            <Button variant="ghost" onClick={() => setSecret(null)}>
              Done
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
