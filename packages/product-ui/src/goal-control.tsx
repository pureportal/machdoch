import type { ProductGoal } from "@machdoch/fleet-protocol";
import { Check, ChevronDown, X } from "lucide-react";
import { Select } from "radix-ui";
import { GoalIcon } from "./composer-icons";
import { useEffect, useId, useRef, type ReactElement } from "react";

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
      aria-pressed={open || active}
      aria-controls={controls}
      data-active={open || active}
      disabled={disabled}
      onClick={onClick}
    >
      <GoalIcon aria-hidden="true" />
    </button>
  );
}

export function GoalControl({
  id,
  open,
  mode,
  modes,
  goal,
  objective,
  running,
  disabled = false,
  onClose,
  onModeChange,
  onObjectiveChange,
  onCommand,
  onPause,
}: {
  id: string;
  open: boolean;
  mode: "machdoch" | "native";
  modes: readonly ("machdoch" | "native")[];
  goal?: ProductGoal | null | undefined;
  objective: string;
  running: boolean;
  disabled?: boolean;
  onClose: () => void;
  onModeChange: (mode: "machdoch" | "native") => void;
  onObjectiveChange: (objective: string) => void;
  onCommand: (command: string) => void;
  onPause: () => void;
}): ReactElement {
  const objectiveId = useId();
  const disabledReasonId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const active = running && goal?.status === "active";
  const changed =
    objective.trim() !== (goal?.objective ?? "") ||
    Boolean(goal && goal.mode !== mode);
  const canResume =
    goal &&
    !changed &&
    goal.status !== "complete" &&
    goal.status !== "budget-limited";
  const status = active
    ? "Active"
    : goal && !changed
      ? {
          active: "Paused",
          paused: "Paused",
          blocked: "Blocked",
          "budget-limited": "Limit reached",
          complete: "Complete",
        }[goal.status]
      : objective.trim()
        ? "Not started"
        : null;
  const disabledReason =
    running && !active ? "Finish or stop the current task first." : null;
  const close = (): void => {
    onClose();
    document.getElementById(`${id}-trigger`)?.focus();
  };

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
            <GoalIcon aria-hidden="true" />
            Goal
          </label>
          {status ? (
            <span className="m-goal-status" role="status">
              {status}
            </span>
          ) : null}
          <Select.Root
            value={mode}
            disabled={disabled || running}
            onValueChange={(value) =>
              onModeChange(value as "machdoch" | "native")
            }
          >
            <Select.Trigger
              className="m-goal-mode-trigger"
              aria-label="Goal mode"
            >
              <Select.Value />
              <Select.Icon asChild>
                <ChevronDown aria-hidden="true" />
              </Select.Icon>
            </Select.Trigger>
            <Select.Portal>
              <Select.Content
                className="m-goal-mode-menu"
                position="popper"
                align="start"
                sideOffset={6}
                collisionPadding={12}
              >
                <Select.Viewport>
                  {(["machdoch", "native"] as const).map((value) => (
                    <Select.Item
                      key={value}
                      className="m-goal-mode-option"
                      value={value}
                      disabled={!modes.includes(value)}
                    >
                      <Select.ItemText>
                        {value === "machdoch"
                          ? "Machdoch"
                          : modes.includes(value)
                            ? "Native"
                            : "Native (unavailable)"}
                      </Select.ItemText>
                      <Select.ItemIndicator>
                        <Check aria-hidden="true" />
                      </Select.ItemIndicator>
                    </Select.Item>
                  ))}
                </Select.Viewport>
              </Select.Content>
            </Select.Portal>
          </Select.Root>
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
          onChange={(event) => onObjectiveChange(event.target.value)}
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
                aria-describedby={disabledReason ? disabledReasonId : undefined}
              >
                {canResume ? "Resume goal" : "Start goal"}
              </button>
            )}
          </div>
        </div>
        {disabledReason ? (
          <p id={disabledReasonId} className="m-goal-reason">
            {disabledReason}
          </p>
        ) : null}
      </div>
    </form>
  );
}
