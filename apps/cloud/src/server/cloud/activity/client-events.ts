import type { ProductSnapshot } from "@machdoch/fleet-protocol";
import type { AiActivityStatus } from "../../../lib/cloud-activity-contract";

export interface ClientEvent {
  status: AiActivityStatus;
  title: string;
  detail: string;
  provider?: string;
  model?: string;
}

interface ObservedTask {
  state: string;
  provider?: string;
  model?: string;
}

export interface ClientObservation {
  tasks: Record<string, ObservedTask>;
  scheduledRuns: Record<string, string>;
  workflowRuns: Record<string, string>;
  errors: Record<string, string>;
  unavailableProviders: Record<string, string>;
}

type Outcome = "succeeded" | "failed" | "canceled" | "warning";

const outcomes: Record<string, Outcome> = {
  completed: "succeeded",
  succeeded: "succeeded",
  executed: "succeeded",
  failed: "failed",
  crashed: "failed",
  error: "failed",
  timed_out: "failed",
  expired: "failed",
  abandoned: "failed",
  interrupted: "failed",
  canceled: "canceled",
  cancelled: "canceled",
  stopped: "canceled",
  skipped: "canceled",
  blocked: "warning",
  partial: "warning",
  "waiting-for-input": "warning",
};

const stateWords: Record<string, string> = {
  executed: "completed",
  cancelled: "canceled",
  timed_out: "timed out",
  partial: "partially completed",
  "waiting-for-input": "waiting for input",
  error: "failed",
};

const components = [
  ["runtime", "Runtime"],
  ["scheduler", "Scheduler"],
  ["ralph", "RALPH"],
  ["instructions", "Instructions"],
] as const;

export function clientOutcome(state: string): Outcome | null {
  return outcomes[state] ?? null;
}

function stateWord(state: string): string {
  return stateWords[state] ?? state.replaceAll("_", " ");
}

function settled(
  previous: string | undefined,
  current: string,
): Outcome | null {
  const outcome = clientOutcome(current);
  return outcome && previous !== current ? outcome : null;
}

function joined(...parts: (string | undefined)[]): string {
  return parts.filter((part) => part?.trim()).join(" · ");
}

function componentErrors(snapshot: ProductSnapshot): Record<string, string> {
  const shell = snapshot.shell;
  const errors: Record<string, string | undefined> = {
    runtime: shell?.runtime?.error,
    scheduler: shell?.scheduler?.error,
    ralph: shell?.ralph?.error,
    instructions: shell?.instructions?.error,
  };
  return Object.fromEntries(
    Object.entries(errors).filter((entry): entry is [string, string] =>
      Boolean(entry[1]?.trim()),
    ),
  );
}

function unavailableProviders(
  snapshot: ProductSnapshot,
): Record<string, string> {
  return Object.fromEntries(
    (snapshot.shell?.runtime?.providerStatuses ?? [])
      .filter((status) => !status.available)
      .map((status) => [status.provider, status.reason ?? ""]),
  );
}

export function observeClient(
  previous: ClientObservation | null,
  snapshot: ProductSnapshot,
): { observation: ClientObservation; events: ClientEvent[] } {
  const events: ClientEvent[] = [];
  const shell = snapshot.shell;
  const runningModels = new Map<string, { provider: string; model: string }>();
  const activeSession = shell?.sessions.find(
    (session) => session.id === shell.activeSessionId,
  );
  for (const message of shell?.visibleMessages ?? [])
    if (message.taskId && activeSession)
      runningModels.set(message.taskId, {
        provider: activeSession.provider,
        model: activeSession.model,
      });
  for (const session of shell?.sessions ?? [])
    if (session.runningTaskId)
      runningModels.set(session.runningTaskId, {
        provider: session.provider,
        model: session.model,
      });
  const tasks: Record<string, ObservedTask> = {};
  for (const task of snapshot.sessions) {
    const before = previous?.tasks[task.taskId];
    const usage = runningModels.get(task.taskId) ?? before;
    tasks[task.taskId] = {
      state: task.state,
      ...(usage?.provider ? { provider: usage.provider } : {}),
      ...(usage?.model ? { model: usage.model } : {}),
    };
    if (!previous) continue;
    const outcome = settled(before?.state, task.state);
    const model = {
      ...(usage?.provider ? { provider: usage.provider } : {}),
      ...(usage?.model ? { model: usage.model } : {}),
    };
    if (outcome)
      events.push({
        status: outcome,
        title: `Task ${stateWord(task.state)}`,
        detail: outcome === "succeeded" ? "" : task.message,
        ...model,
      });
    else if (!before && !clientOutcome(task.state))
      events.push({
        status: "started",
        title: "Task started",
        detail: "",
        ...model,
      });
  }
  const jobs = new Map(
    (shell?.scheduler?.jobs ?? []).map((job) => [job.id, job.name]),
  );
  const scheduledRuns: Record<string, string> = {};
  for (const run of shell?.scheduler?.runs ?? []) {
    scheduledRuns[run.id] = run.status;
    if (!previous) continue;
    const outcome = settled(previous.scheduledRuns[run.id], run.status);
    if (outcome)
      events.push({
        status: outcome,
        title: `Scheduled job ${stateWord(run.status)}`,
        detail: joined(
          jobs.get(run.jobId),
          outcome === "succeeded" ? undefined : (run.error ?? run.summary),
        ),
      });
  }
  const workflowRuns: Record<string, string> = {};
  for (const run of shell?.ralph?.runs ?? []) {
    workflowRuns[run.id] = run.status;
    if (!previous) continue;
    const outcome = settled(previous.workflowRuns[run.id], run.status);
    if (outcome)
      events.push({
        status: outcome,
        title: `RALPH run ${stateWord(run.status)}`,
        detail: joined(run.flowName, run.summary),
      });
  }
  const errors = componentErrors(snapshot);
  for (const [component, label] of components) {
    const before = previous?.errors[component];
    const current = errors[component];
    if (current && current !== before)
      events.push({
        status: "failed",
        title: `${label} error`,
        detail: current,
      });
    else if (!current && before)
      events.push({
        status: "succeeded",
        title: `${label} recovered`,
        detail: "",
      });
  }
  const providers = unavailableProviders(snapshot);
  if (previous) {
    for (const [provider, reason] of Object.entries(providers))
      if (!(provider in previous.unavailableProviders))
        events.push({
          status: "warning",
          title: `${provider} unavailable`,
          detail: reason,
          provider,
        });
    for (const provider of Object.keys(previous.unavailableProviders))
      if (!(provider in providers))
        events.push({
          status: "succeeded",
          title: `${provider} available`,
          detail: "",
          provider,
        });
  }
  return {
    observation: {
      tasks,
      scheduledRuns,
      workflowRuns,
      errors,
      unavailableProviders: providers,
    },
    events,
  };
}

export function presenceEvent(online: boolean): ClientEvent {
  return online
    ? { status: "succeeded", title: "Client connected", detail: "" }
    : { status: "warning", title: "Client disconnected", detail: "" };
}
