"use client";

import type { ExecutionCheck } from "@machdoch/fleet-protocol/cloud-execution";
import { Field } from "@/components/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

export interface CheckDraft extends ExecutionCheck {
  key: string;
}
export function ExecutionChecks({
  checks,
  onChange,
}: {
  checks: CheckDraft[];
  onChange: (checks: CheckDraft[]) => void;
}) {
  function update(index: number, change: Partial<ExecutionCheck>) {
    onChange(
      checks.map((check, position) =>
        position === index ? { ...check, ...change } : check,
      ),
    );
  }
  return (
    <fieldset className="grid min-w-0 gap-3">
      <legend className="mb-2 font-medium">Required checks</legend>
      {checks.map((check, index) => (
        <fieldset
          key={check.key}
          className="grid min-w-0 gap-3 rounded-lg border border-border p-3"
        >
          <legend className="px-1 text-sm text-muted-foreground">
            Check {index + 1}
          </legend>
          <Field label="Name" htmlFor={`check-${check.key}-name`}>
            <Input
              id={`check-${check.key}-name`}
              aria-label={`Check name ${index + 1}`}
              required
              maxLength={120}
              value={check.name}
              onChange={(event) => update(index, { name: event.target.value })}
            />
          </Field>
          <Field label="Command" htmlFor={`check-${check.key}-command`}>
            <Textarea
              id={`check-${check.key}-command`}
              aria-label={`Check command ${index + 1}`}
              required
              rows={2}
              maxLength={16384}
              value={check.command}
              onChange={(event) =>
                update(index, { command: event.target.value })
              }
            />
          </Field>
          <div className="flex items-end justify-between gap-3">
            <Field
              label="Timeout (seconds)"
              htmlFor={`check-${check.key}-timeout`}
            >
              <Input
                id={`check-${check.key}-timeout`}
                className="max-w-32"
                aria-label={`Check timeout ${index + 1}`}
                type="number"
                min={1}
                max={300}
                step={1}
                required
                value={
                  Number.isNaN(check.timeoutSeconds) ? "" : check.timeoutSeconds
                }
                onChange={(event) =>
                  update(index, { timeoutSeconds: event.target.valueAsNumber })
                }
              />
            </Field>
            <Button
              type="button"
              variant="ghost"
              disabled={checks.length === 1}
              aria-label={`Remove check ${index + 1}`}
              onClick={() =>
                onChange(checks.filter((_, position) => position !== index))
              }
            >
              Remove
            </Button>
          </div>
        </fieldset>
      ))}
      {checks.length < 30 && (
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            onChange([
              ...checks,
              {
                key: crypto.randomUUID(),
                name: "",
                command: "",
                timeoutSeconds: 60,
              },
            ])
          }
        >
          Add check
        </Button>
      )}
    </fieldset>
  );
}
