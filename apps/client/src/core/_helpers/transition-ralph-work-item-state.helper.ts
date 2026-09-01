export const RALPH_WORK_ITEM_STATES = [
  "planned",
  "implementing",
  "verifying",
  "repairing",
  "completed",
  "deferred",
] as const;

export type RalphWorkItemState = (typeof RALPH_WORK_ITEM_STATES)[number];

const ALLOWED_RALPH_WORK_ITEM_TRANSITIONS: Readonly<
  Record<RalphWorkItemState, readonly RalphWorkItemState[]>
> = {
  planned: ["implementing", "deferred"],
  implementing: ["verifying", "repairing", "deferred"],
  verifying: ["completed", "repairing", "deferred"],
  repairing: ["verifying", "deferred"],
  completed: [],
  deferred: ["planned", "implementing"],
};

export interface RalphWorkItemStateTransition {
  from: RalphWorkItemState;
  to: RalphWorkItemState;
  changed: boolean;
}

export const parseRalphWorkItemState = (
  value: unknown,
): RalphWorkItemState | undefined => {
  return RALPH_WORK_ITEM_STATES.includes(value as RalphWorkItemState)
    ? (value as RalphWorkItemState)
    : undefined;
};

export const isTerminalRalphWorkItemState = (value: unknown): boolean => {
  const state = parseRalphWorkItemState(value);
  return state === "completed" || state === "deferred";
};

export const transitionRalphWorkItemState = (
  current: unknown,
  requested: unknown,
): RalphWorkItemStateTransition => {
  const from = parseRalphWorkItemState(current);
  const to = parseRalphWorkItemState(requested);

  if (!from) {
    throw new Error(
      `Unsupported current work-item state \`${String(current)}\`; expected ${RALPH_WORK_ITEM_STATES.join(", ")}.`,
    );
  }

  if (!to) {
    throw new Error(
      `Unsupported work-item state \`${String(requested)}\`; expected ${RALPH_WORK_ITEM_STATES.join(", ")}.`,
    );
  }

  if (from === to) {
    return { from, to, changed: false };
  }

  if (!ALLOWED_RALPH_WORK_ITEM_TRANSITIONS[from].includes(to)) {
    throw new Error(`Invalid work-item state transition ${from} -> ${to}.`);
  }

  return { from, to, changed: true };
};
