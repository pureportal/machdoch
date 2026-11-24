"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Send } from "lucide-react";
import { pollWhileVisible } from "@machdoch/product-ui/view-visibility";
import {
  terminalRunStates,
  type RunDetail,
} from "@machdoch/fleet-protocol/cloud-execution";
import {
  handoffModel,
  handoffModels,
  handoffWhere,
  placementTargets,
  type AgentHandoff,
  type HandoffOptions,
} from "@/lib/agent-handoff";
import { loopHarnesses, type LoopHarness } from "@/lib/cloud-loop-contract";
import {
  harnessLabels,
  placementLabels,
  type ConcretePlacement,
} from "@/lib/loop-capabilities";
import type { CloudChatTurn } from "@/lib/cloud-chat-contract";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cloudRequest, createCommandSender, formText } from "../api-client";
import { TaskState } from "../task-state";
import { TaskTimeline } from "../task-timeline";

const brokeredPlacements = ["sandbox", "runner_pool"] as const;

function placementOf(
  where: string,
  options: HandoffOptions,
): {
  placement: "automatic" | ConcretePlacement;
  profileId: string | null;
  workerId: string | null;
} {
  const [kind, id = null] = where.split(":");
  if (kind === "device")
    return { placement: "client", profileId: null, workerId: id };
  const target = options.profiles.find((profile) => profile.id === id)?.target;
  const placement = brokeredPlacements.find(
    (entry) => placementTargets[entry] === target,
  );
  return placement
    ? { placement, profileId: id, workerId: null }
    : { placement: "automatic", profileId: null, workerId: null };
}

export function AgentHandoffButton({
  turn,
  disabled,
  onStarted,
}: {
  turn: CloudChatTurn;
  disabled: boolean;
  onStarted: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<HandoffOptions | null>(null);
  const [error, setError] = useState("");
  const [harness, setHarness] = useState<LoopHarness>("machdoch");
  const [model, setModel] = useState("");
  const [where, setWhere] = useState("automatic");
  const sender = useRef(createCommandSender());
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    setOptions(null);
    setError("");
    cloudRequest<HandoffOptions>(`chat-turns/${turn.id}/handoff-options`, {
      signal: abort.signal,
    })
      .then((next) => {
        const nextHarness = next.defaults.harness ?? "machdoch";
        setOptions(next);
        setHarness(nextHarness);
        setWhere(handoffWhere(next.defaults.placement, next));
        setModel(
          handoffModel(
            next.defaults.model,
            handoffModels(nextHarness, next),
            turn.model,
          ),
        );
      })
      .catch((reason: Error) => {
        if (!abort.signal.aborted) setError(reason.message);
      });
    return () => abort.abort();
  }, [open, turn.id, turn.model]);
  const models = options ? handoffModels(harness, options) : [];
  const brokered = options
    ? brokeredPlacements.flatMap((placement) =>
        options.profiles
          .filter((profile) => profile.target === placementTargets[placement])
          .map((profile) => ({ placement, profile })),
      )
    : [];
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <Send size={13} aria-hidden="true" />
        Run this on…
      </Button>
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title="Run this on…"
        submitLabel="Run"
        pendingLabel="Starting…"
        submitDisabled={!options?.subject}
        onSubmit={async (form) => {
          if (!options) return;
          await sender.current("agent-handoffs", {
            turnId: turn.id,
            ...placementOf(where, options),
            harness,
            model: formText(form, "model"),
            instructions: formText(form, "instructions"),
          });
          await onStarted();
        }}
      >
        {error && (
          <p role="alert" className="cloud-error">
            {error}
          </p>
        )}
        {options && !options.subject && (
          <p className="cloud-agent-muted">
            Add an issue or project to this conversation.
          </p>
        )}
        <Field label="Task" htmlFor={`handoff-task-${turn.id}`}>
          <Textarea
            id={`handoff-task-${turn.id}`}
            name="instructions"
            required
            rows={4}
            maxLength={20_000}
            defaultValue={turn.prompt}
          />
        </Field>
        <Field label="Where" htmlFor={`handoff-where-${turn.id}`}>
          <Select
            id={`handoff-where-${turn.id}`}
            value={where}
            onChange={(event) => setWhere(event.target.value)}
          >
            <option value="automatic">{placementLabels.automatic}</option>
            {brokeredPlacements.map((placement) => {
              const entries = brokered.filter(
                (entry) => entry.placement === placement,
              );
              return (
                entries.length > 0 && (
                  <optgroup key={placement} label={placementLabels[placement]}>
                    {entries.map(({ profile }) => (
                      <option key={profile.id} value={`profile:${profile.id}`}>
                        {profile.name}
                      </option>
                    ))}
                  </optgroup>
                )
              );
            })}
            {options && options.devices.length > 0 && (
              <optgroup label={placementLabels.client}>
                {options.devices.map((device) => (
                  <option key={device.id} value={`device:${device.id}`}>
                    {device.name}
                  </option>
                ))}
              </optgroup>
            )}
          </Select>
        </Field>
        <Field label="Harness" htmlFor={`handoff-harness-${turn.id}`}>
          <Select
            id={`handoff-harness-${turn.id}`}
            value={harness}
            onChange={(event) => {
              const next = event.target.value as LoopHarness;
              setHarness(next);
              const suggestions = options ? handoffModels(next, options) : [];
              if (suggestions.length && !suggestions.includes(model))
                setModel(suggestions[0]!);
            }}
          >
            {loopHarnesses.map((entry) => (
              <option key={entry} value={entry}>
                {harnessLabels[entry]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Model" htmlFor={`handoff-model-${turn.id}`}>
          <Input
            id={`handoff-model-${turn.id}`}
            name="model"
            required
            maxLength={160}
            list={`handoff-models-${turn.id}`}
            value={model}
            onChange={(event) => setModel(event.target.value)}
          />
          <datalist id={`handoff-models-${turn.id}`}>
            {models.map((entry) => (
              <option key={entry} value={entry} />
            ))}
          </datalist>
        </Field>
      </FormDialog>
    </>
  );
}

const activePollMs = 3000;

export function AgentHandoffRun({ handoff }: { handoff: AgentHandoff }) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    let finished = false;
    let stop = () => {};
    async function poll() {
      if (finished) return;
      try {
        const next = await cloudRequest<RunDetail>(`runs/${handoff.runId}`, {
          signal: abort.signal,
        });
        if (abort.signal.aborted) return;
        setRun(next);
        setError("");
        if (
          terminalRunStates.some((state) => state === next.state) &&
          (!next.delivery ||
            ["merged", "closed", "failed", "needs_person", "open"].includes(
              next.delivery.state,
            ))
        ) {
          finished = true;
          stop();
        }
      } catch (reason) {
        if (!abort.signal.aborted) setError((reason as Error).message);
      }
    }
    stop = pollWhileVisible(poll, () => activePollMs);
    return () => {
      abort.abort();
      stop();
    };
  }, [handoff.runId]);
  const live = run
    ? !terminalRunStates.some((state) => state === run.state)
    : false;
  return (
    <section className="cloud-agent-handoff">
      <header>
        <span>
          {[
            handoff.deviceName ?? placementLabels[handoff.placement],
            harnessLabels[handoff.harness],
            handoff.model,
          ].join(" · ")}
        </span>
        {run && <TaskState state={run.state} />}
        <Link href={`/cloud/tasks/${handoff.runId}`} aria-label="Open task">
          <ArrowUpRight size={14} aria-hidden="true" />
        </Link>
      </header>
      {run && run.timeline.length > 0 && (
        <TaskTimeline entries={run.timeline.slice(-6)} live={live} />
      )}
      {run?.delivery && <code>{run.delivery.branch}</code>}
      {error && (
        <p role="alert" className="cloud-error">
          {error}
        </p>
      )}
    </section>
  );
}
