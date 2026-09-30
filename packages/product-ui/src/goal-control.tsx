import type { ProductGoal } from "@machdoch/fleet-protocol";
import { Target } from "lucide-react";
import { Popover } from "radix-ui";
import { useState, type ReactElement } from "react";

export function GoalControl({
  mode,
  modes,
  goal,
  running,
  disabled = false,
  onModeChange,
  onCommand,
  onPause,
}: {
  mode: "machdoch" | "native";
  modes: readonly ("machdoch" | "native")[];
  goal?: ProductGoal | null | undefined;
  running: boolean;
  disabled?: boolean;
  onModeChange: (mode: "machdoch" | "native") => void;
  onCommand: (command: string) => void;
  onPause: () => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [objective, setObjective] = useState("");
  const active = running && goal?.status === "active";
  const submit = (command: string): void => {
    onCommand(command);
    setOpen(false);
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="m-goal-trigger app-composer-toolbar-control"
          aria-label="Goal"
          data-active={active}
          disabled={disabled}
        >
          <Target aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="m-goal-control"
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          aria-label="Goal"
        >
          {modes.length > 1 ? (
            <label>
              Goal mode
              <select
                aria-label="Goal mode"
                value={mode}
                disabled={running}
                onChange={(event) =>
                  onModeChange(event.target.value as "machdoch" | "native")
                }
              >
                {modes.map((value) => (
                  <option key={value} value={value}>
                    {value === "machdoch" ? "Machdoch" : "Native"}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {goal ? (
            <div className="m-goal-state">
              <p>{goal.objective}</p>
              <p>
                {active
                  ? "Active"
                  : goal.status === "active"
                    ? "Paused"
                    : {
                        paused: "Paused",
                        blocked: "Blocked",
                        "budget-limited": "Limit reached",
                        complete: "Complete",
                      }[goal.status]}{" "}
                · {goal.turns} turns · {goal.tokensUsed} tokens
              </p>
              {goal.reason ? <p>{goal.reason}</p> : null}
              <div className="m-goal-actions">
                {active ? (
                  <button
                    type="button"
                    onClick={() => {
                      onPause();
                      setOpen(false);
                    }}
                  >
                    Pause goal
                  </button>
                ) : goal.status !== "complete" &&
                  goal.status !== "budget-limited" ? (
                  <button
                    type="button"
                    disabled={running}
                    onClick={() => submit("/goal resume")}
                  >
                    Resume goal
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={running}
                  onClick={() => submit("/goal clear")}
                >
                  Clear goal
                </button>
              </div>
            </div>
          ) : null}
          {!running && (!goal || goal.status !== "active") ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (objective.trim()) {
                  submit(`/goal -- ${objective.trim()}`);
                  setObjective("");
                }
              }}
            >
              <label>
                Goal
                <textarea
                  aria-label="Goal objective"
                  value={objective}
                  maxLength={4_000}
                  required
                  onChange={(event) => setObjective(event.target.value)}
                />
              </label>
              <button type="submit" disabled={!objective.trim()}>
                Start goal
              </button>
            </form>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
