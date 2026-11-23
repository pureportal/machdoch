"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  loopMissedPolicies,
  loopOverlapPolicies,
  loopSources,
  type CloudLoop,
  type LoopConfig,
  type LoopMissedPolicy,
  type LoopOverlapPolicy,
} from "@/lib/cloud-loop-contract";
import {
  centsToDollars,
  dollarsToCents,
  loopSourceLabels,
  missedLabels,
  overlapLabels,
} from "@/lib/loop-labels";
import { createCommandSender } from "./api-client";
import { LoopExecutorFields } from "./loop-executor-fields";
import { useToast } from "./toast";
import type { AutomationOptions } from "./use-automation-options";

export function LoopConfigForm({
  loop,
  options,
  editable,
}: {
  loop: CloudLoop;
  options: AutomationOptions;
  editable: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const sender = useRef(createCommandSender());
  const [config, setConfig] = useState<LoopConfig>(loop.config);
  const [runBudget, setRunBudget] = useState(
    centsToDollars(loop.config.guardrails.runBudgetCents),
  );
  const [monthBudget, setMonthBudget] = useState(
    centsToDollars(loop.config.guardrails.monthBudgetCents),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const guardrails = config.guardrails;
  const setGuardrails = (next: Partial<LoopConfig["guardrails"]>) =>
    setConfig({ ...config, guardrails: { ...guardrails, ...next } });

  async function save() {
    setPending(true);
    setError("");
    try {
      await sender.current(
        `loops/${loop.id}/config`,
        {
          revision: loop.revision,
          config: {
            ...config,
            guardrails: {
              ...guardrails,
              runBudgetCents: dollarsToCents(runBudget),
              monthBudgetCents: dollarsToCents(monthBudget),
            },
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
      className="cloud-loop-config"
      aria-label="Configuration"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <fieldset disabled={!editable || pending} className="grid gap-5">
        <Field label="Description" htmlFor="loop-description">
          <Textarea
            id="loop-description"
            value={config.description}
            maxLength={2000}
            onChange={(event) =>
              setConfig({ ...config, description: event.target.value })
            }
          />
        </Field>
        <div className="cloud-loop-fields">
          <LoopExecutorFields
            executor={config.executor}
            options={options}
            teamId={loop.teamId}
            onChange={(executor) => setConfig({ ...config, executor })}
          />
          <Field label="Model" htmlFor="loop-model">
            <Select
              id="loop-model"
              value={config.executor.model}
              onChange={(event) =>
                setConfig({
                  ...config,
                  executor: { ...config.executor, model: event.target.value },
                })
              }
            >
              <option value="">Default</option>
              {config.executor.model &&
                !options.models.some(
                  (model) => model.model === config.executor.model,
                ) && (
                  <option value={config.executor.model}>
                    {config.executor.model}
                  </option>
                )}
              {options.models.map((model) => (
                <option
                  key={`${model.providerId}:${model.model}`}
                  value={model.model}
                >
                  {model.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="cloud-loop-fields">
          <Field label="Budget per run ($)" htmlFor="loop-run-budget">
            <Input
              id="loop-run-budget"
              inputMode="decimal"
              value={runBudget}
              onChange={(event) => setRunBudget(event.target.value)}
            />
          </Field>
          <Field label="Budget per month ($)" htmlFor="loop-month-budget">
            <Input
              id="loop-month-budget"
              inputMode="decimal"
              value={monthBudget}
              onChange={(event) => setMonthBudget(event.target.value)}
            />
          </Field>
          <Field label="Max duration (minutes)" htmlFor="loop-duration">
            <Input
              id="loop-duration"
              type="number"
              min={1}
              max={1440}
              required
              value={guardrails.maxDurationMinutes}
              onChange={(event) =>
                setGuardrails({
                  maxDurationMinutes: event.target.valueAsNumber,
                })
              }
            />
          </Field>
          <Field label="Pause after failures" htmlFor="loop-pause">
            <Input
              id="loop-pause"
              type="number"
              min={1}
              max={100}
              value={guardrails.pauseAfterFailures ?? ""}
              onChange={(event) =>
                setGuardrails({
                  pauseAfterFailures: event.target.value
                    ? event.target.valueAsNumber
                    : null,
                })
              }
            />
          </Field>
          <Field label="When runs overlap" htmlFor="loop-overlap">
            <Select
              id="loop-overlap"
              value={guardrails.overlap}
              onChange={(event) =>
                setGuardrails({
                  overlap: event.target.value as LoopOverlapPolicy,
                })
              }
            >
              {loopOverlapPolicies.map((policy) => (
                <option key={policy} value={policy}>
                  {overlapLabels[policy]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Missed runs" htmlFor="loop-missed">
            <Select
              id="loop-missed"
              value={guardrails.missed}
              onChange={(event) =>
                setGuardrails({
                  missed: event.target.value as LoopMissedPolicy,
                })
              }
            >
              {loopMissedPolicies.map((policy) => (
                <option key={policy} value={policy}>
                  {missedLabels[policy]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Label className="cloud-automation-check">
          <input
            type="checkbox"
            checked={guardrails.approvalRequired}
            onChange={(event) =>
              setGuardrails({ approvalRequired: event.target.checked })
            }
          />
          Require approval before consequential outputs
        </Label>
        <fieldset className="cloud-loop-capabilities">
          <legend>Trusted sources</legend>
          {loopSources.map((source) => (
            <Label key={source} className="cloud-automation-check">
              <input
                type="checkbox"
                checked={config.trustedSources.includes(source)}
                onChange={(event) =>
                  setConfig({
                    ...config,
                    trustedSources: event.target.checked
                      ? [...config.trustedSources, source]
                      : config.trustedSources.filter(
                          (entry) => entry !== source,
                        ),
                  })
                }
              />
              {loopSourceLabels[source]}
            </Label>
          ))}
        </fieldset>
        {error && <p role="alert">{error}</p>}
        {editable && (
          <div className="cloud-release-actions">
            <Button type="submit">{pending ? "Saving…" : "Save"}</Button>
          </div>
        )}
      </fieldset>
    </form>
  );
}
