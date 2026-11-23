"use client";

import { Field } from "@/components/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  loopHarnesses,
  loopPlacements,
  type LoopExecutor,
  type LoopHarness,
  type LoopPlacement,
} from "@/lib/cloud-loop-contract";
import {
  capabilityLabels,
  harnessLabels,
  offeredCapabilities,
  placementLabels,
} from "@/lib/loop-capabilities";
import type { AutomationOptions } from "./use-automation-options";

interface TargetOption {
  id: string;
  label: string;
}

export function targetOptions(
  placement: LoopPlacement,
  options: AutomationOptions,
  teamId: string | null,
): TargetOption[] {
  if (placement === "sandbox")
    return options.profiles
      .filter((profile) => profile.target !== "client" && profile.enabled)
      .filter((profile) => teamId === null || profile.teamId === teamId)
      .map((profile) => ({ id: profile.id, label: profile.name }));
  if (placement === "client")
    return [
      ...new Map(
        options.clients.map((client) => [
          client.instanceId,
          { id: client.instanceId, label: client.device },
        ]),
      ).values(),
    ];
  return [];
}

export function LoopExecutorFields({
  executor,
  options,
  teamId,
  placements = loopPlacements,
  onChange,
}: {
  executor: LoopExecutor;
  options: AutomationOptions;
  teamId: string | null;
  placements?: readonly LoopPlacement[];
  onChange: (executor: LoopExecutor) => void;
}) {
  const targets = targetOptions(executor.placement, options, teamId);
  const offered = offeredCapabilities(executor.placement);
  return (
    <>
      <Field label="Runs on" htmlFor="loop-placement">
        <Select
          id="loop-placement"
          value={executor.placement}
          onChange={(event) => {
            const placement = event.target.value as LoopPlacement;
            const allowed = offeredCapabilities(placement);
            onChange({
              ...executor,
              placement,
              targetId:
                placement === "automatic"
                  ? null
                  : (targetOptions(placement, options, teamId)[0]?.id ?? null),
              capabilities: executor.capabilities.filter((capability) =>
                allowed.includes(capability),
              ),
            });
          }}
        >
          {placements.map((placement) => (
            <option key={placement} value={placement}>
              {placementLabels[placement]}
            </option>
          ))}
        </Select>
      </Field>
      {executor.placement === "runner_pool" ? (
        <Field label="Pool" htmlFor="loop-target">
          <Input
            id="loop-target"
            value={executor.targetId ?? ""}
            required
            maxLength={200}
            onChange={(event) =>
              onChange({ ...executor, targetId: event.target.value || null })
            }
          />
        </Field>
      ) : (
        executor.placement !== "automatic" && (
          <Field label="Target" htmlFor="loop-target">
            <Select
              id="loop-target"
              value={executor.targetId ?? ""}
              required
              onChange={(event) =>
                onChange({ ...executor, targetId: event.target.value || null })
              }
            >
              {!targets.some((target) => target.id === executor.targetId) && (
                <option value={executor.targetId ?? ""} disabled>
                  {executor.targetId ? executor.targetId : "None available"}
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
      <Field label="Harness" htmlFor="loop-harness">
        <Select
          id="loop-harness"
          value={executor.harness}
          onChange={(event) =>
            onChange({
              ...executor,
              harness: event.target.value as LoopHarness,
            })
          }
        >
          {loopHarnesses.map((harness) => (
            <option key={harness} value={harness}>
              {harnessLabels[harness]}
            </option>
          ))}
        </Select>
      </Field>
      <fieldset className="cloud-loop-capabilities">
        <legend>Requires</legend>
        {offered.map((capability) => (
          <Label key={capability} className="cloud-automation-check">
            <input
              type="checkbox"
              checked={executor.capabilities.includes(capability)}
              onChange={(event) =>
                onChange({
                  ...executor,
                  capabilities: event.target.checked
                    ? [...executor.capabilities, capability]
                    : executor.capabilities.filter(
                        (entry) => entry !== capability,
                      ),
                })
              }
            />
            {capabilityLabels[capability]}
          </Label>
        ))}
      </fieldset>
    </>
  );
}
