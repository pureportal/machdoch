export const RALPH_WORK_ITEM_STATES = [
  "planned",
  "implementing",
  "verifying",
  "repairing",
  "completed",
  "deferred",
] as const;

export type RalphWorkItemState = (typeof RALPH_WORK_ITEM_STATES)[number];

const RALPH_WORK_ITEM_STATE_ALIASES: Readonly<Record<string, RalphWorkItemState>> = {
  pending: "planned",
  todo: "planned",
  in_progress: "implementing",
  "in-progress": "implementing",
  done: "completed",
};

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

export const normalizeRalphWorkItemState = (
  value: unknown,
): RalphWorkItemState | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();

  return RALPH_WORK_ITEM_STATES.includes(normalized as RalphWorkItemState)
    ? (normalized as RalphWorkItemState)
    : RALPH_WORK_ITEM_STATE_ALIASES[normalized];
};

export const transitionRalphWorkItemState = (
  current: unknown,
  requested: unknown,
): RalphWorkItemStateTransition => {
  const missingCurrent = current === undefined || current === null || current === "";
  const from = normalizeRalphWorkItemState(current);
  const to = normalizeRalphWorkItemState(requested);

  if (!from && !missingCurrent) {
    throw new Error(
      `Unsupported current work-item state \`${String(current)}\`; expected ${RALPH_WORK_ITEM_STATES.join(", ")}.`,
    );
  }

  if (!to) {
    throw new Error(
      `Unsupported work-item state \`${String(requested)}\`; expected ${RALPH_WORK_ITEM_STATES.join(", ")}.`,
    );
  }

  const normalizedFrom = from ?? "planned";
  if (normalizedFrom === to) {
    return { from: normalizedFrom, to, changed: false };
  }

  if (!ALLOWED_RALPH_WORK_ITEM_TRANSITIONS[normalizedFrom].includes(to)) {
    throw new Error(`Invalid work-item state transition ${normalizedFrom} -> ${to}.`);
  }

  return { from: normalizedFrom, to, changed: true };
};
