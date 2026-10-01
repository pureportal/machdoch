import type { ProductGoal } from "@machdoch/fleet-protocol";
import { Target, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactElement } from "react";

export function GoalTrigger({
  open,
  active,
  controls,
  disabled = false,
  onClick,
}: {
  open: boolean;
  active: boolean;
  controls: string;
  disabled?: boolean;
  onClick: () => void;
}): ReactElement {
  return (
    <button
      id={`${controls}-trigger`}
      type="button"
      className="m-goal-trigger app-composer-toolbar-control"
      aria-label="Goal"
      aria-expanded={open}
      aria-controls={controls}
      data-active={active || open}
      disabled={disabled}
      onClick={onClick}
    >
      <Target aria-hidden="true" />
    </button>
  );
}

export function GoalControl({
  id,
  open,
  mode,
  modes,
  goal,
  running,
  disabled = false,
  onClose,
  onModeChange,
  onCommand,
  onPause,
}: {
  id: string;
  open: boolean;
  mode: "machdoch" | "native";
  modes: readonly ("machdoch" | "native")[];
  goal?: ProductGoal | null | undefined;
  running: boolean;
  disabled?: boolean;
  onClose: () => void;
  onModeChange: (mode: "machdoch" | "native") => void;
  onCommand: (command: string) => void;
  onPause: () => void;
}): ReactElement {
  const objectiveId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [objective, setObjective] = useState(goal?.objective ?? "");
  const active = running && goal?.status === "active";
  const changed = objective.trim() !== (goal?.objective ?? "");
  const canResume =
    goal &&
    !changed &&
    goal.status !== "complete" &&
    goal.status !== "budget-limited";
  const status = goal
    ? active
      ? "Active"
      : goal.status === "active"
        ? "Paused"
        : {
            paused: "Paused",
            blocked: "Blocked",
            "budget-limited": "Limit reached",
            complete: "Complete",
          }[goal.status]
    : null;
  const close = (): void => {
    onClose();
    document.getElementById(`${id}-trigger`)?.focus();
  };

  useEffect(() => {
    setObjective(goal?.objective ?? "");
  }, [goal?.id, goal?.objective]);

  useEffect(() => {
    if (open) textareaRef.current?.focus();
  }, [open]);

  return (
    <form
      id={id}
      className="m-goal-control"
      hidden={!open}
      aria-label="Goal"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
        } else if (
          event.key === "Enter" &&
          (event.ctrlKey || event.metaKey) &&
          !event.altKey &&
          !event.shiftKey &&
          !event.repeat &&
          !event.nativeEvent.isComposing
        ) {
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.requestSubmit();
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled && !running && objective.trim()) {
          onCommand(
            canResume ? "/goal resume" : `/goal -- ${objective.trim()}`,
          );
        }
      }}
    >
      <div className="m-goal-field">
        <div className="m-goal-heading">
          <label htmlFor={objectiveId}>
            <Target aria-hidden="true" />
            Goal
          </label>
          {status && !changed ? (
            <span className="m-goal-status">{status}</span>
          ) : null}
          {modes.length > 1 ? (
            <select
              aria-label="Goal mode"
              value={mode}
              disabled={disabled || running}
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
          ) : null}
          <button
            type="button"
            className="m-goal-close"
            aria-label="Hide goal"
            onClick={close}
          >
            <X aria-hidden="true" />
          </button>
        </div>
        <textarea
          ref={textareaRef}
          id={objectiveId}
          aria-label="Goal objective"
          value={objective}
          rows={2}
          maxLength={4_000}
          required
          readOnly={running}
          disabled={disabled}
          onChange={(event) => setObjective(event.target.value)}
        />
        {goal?.reason && !changed ? (
          <p className="m-goal-reason">{goal.reason}</p>
        ) : null}
        <div className="m-goal-footer">
          {goal && !changed ? (
            <span className="m-goal-progress">
              {goal.turns} turns · {goal.tokensUsed} tokens
            </span>
          ) : null}
          <div className="m-goal-actions">
            {goal ? (
              <button
                type="button"
                disabled={disabled || running}
                onClick={() => onCommand("/goal clear")}
              >
                Clear goal
              </button>
            ) : null}
            {active ? (
              <button type="button" disabled={disabled} onClick={onPause}>
                Pause goal
              </button>
            ) : (
              <button
                type="submit"
                aria-keyshortcuts="Control+Enter Meta+Enter"
                className="m-goal-submit"
                disabled={disabled || running || !objective.trim()}
              >
                {canResume ? "Resume goal" : "Start goal"}
              </button>
            )}
          </div>
        </div>
      </div>
    </form>
  );
}
