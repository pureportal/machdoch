import {
  normalizeExecutionAttempt,
  type ExecutionAttempt,
} from "./execution-attempt";

export type PromptEnhancementAttempt = {
  execution: ExecutionAttempt;
  updatedAt: number;
  failureMessage?: string;
} & (
  | { status: "waiting"; readyAt: number }
  | { status: "running" | "failed" | "cancelled" }
);

export const normalizePromptEnhancementAttempt = (
  value: unknown,
): PromptEnhancementAttempt | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as Record<string, unknown>;
  const execution = normalizeExecutionAttempt(entry.execution);
  if (
    !execution ||
    (entry.status !== "running" &&
      entry.status !== "waiting" &&
      entry.status !== "failed" &&
      entry.status !== "cancelled") ||
    typeof entry.updatedAt !== "number" ||
    !Number.isFinite(entry.updatedAt) ||
    (entry.status === "waiting" &&
      (typeof entry.readyAt !== "number" || !Number.isFinite(entry.readyAt)))
  )
    return undefined;

  const attempt = {
    execution,
    updatedAt: entry.updatedAt,
    ...(typeof entry.failureMessage === "string"
      ? { failureMessage: entry.failureMessage.slice(0, 8_000) }
      : {}),
  };
  return entry.status === "waiting"
    ? { ...attempt, status: "waiting", readyAt: entry.readyAt as number }
    : { ...attempt, status: entry.status };
};
