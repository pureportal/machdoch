import type { CloudProject } from "./cloud-contract";

export const projectStatusLabels: Record<CloudProject["status"], string> = {
  backlog: "Backlog",
  planned: "Planned",
  active: "In progress",
  paused: "Paused",
  completed: "Completed",
  canceled: "Canceled",
};

export const projectStatusStates: Record<
  CloudProject["status"],
  "backlog" | "ready" | "active" | "blocked" | "complete" | "canceled"
> = {
  backlog: "backlog",
  planned: "ready",
  active: "active",
  paused: "blocked",
  completed: "complete",
  canceled: "canceled",
};
