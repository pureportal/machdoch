import {
  agentLiveStateSchema,
  type AgentLiveCapability,
  type AgentLiveFileChange,
  type AgentLiveLimit,
  type AgentLivePlanStep,
  type AgentLiveQuestion,
  type AgentLiveState,
  type AgentLiveTask,
} from "@machdoch/fleet-protocol/task-thinking";
import type { TaskPanelTone } from "@machdoch/fleet-protocol/task-thinking";

type MutableLiveState = {
  -readonly [Key in keyof AgentLiveState]: AgentLiveState[Key];
};

const LIVE_EMIT_INTERVAL_MS = 200;
const MAX_TASKS = 60;
const MAX_NOTICES = 20;
const MAX_STEERS = 20;
const MAX_FILE_CHANGES = 200;
const MAX_PLAN_STEPS = 80;

const clip = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;

/** Keeps a provider's question within the live-state limits. */
const clipQuestion = (question: AgentLiveQuestion): AgentLiveQuestion => ({
  ...question,
  id: clip(question.id, 200),
  items: question.items.slice(0, 8).map((item) => ({
    ...item,
    id: clip(item.id, 200),
    question: clip(item.question, 2_000),
    ...(item.header ? { header: clip(item.header, 120) } : {}),
    options: item.options.slice(0, 12).map((option) => ({
      label: clip(option.label, 200),
      ...(option.description ? { description: clip(option.description, 600) } : {}),
    })),
  })),
  ...(question.answers
    ? {
        answers: Object.fromEntries(
          Object.entries(question.answers).map(([id, answer]) => [clip(id, 200), clip(answer, 4_000)]),
        ),
      }
    : {}),
});

/**
 * Collects what a provider CLI reports during one run and publishes bounded,
 * throttled snapshots. Every snapshot is complete, so a dropped update never
 * leaves a consumer with a stale partial view.
 */
export class AgentLiveTracker {
  private state: MutableLiveState;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastEmitAt = 0;
  // The first flush publishes the opening state so the UI can show it at once.
  private dirty = true;
  private closed = false;
  private nextNoticeId = 1;
  private reportedInvalidState = false;

  constructor(
    init: Pick<AgentLiveState, "provider" | "transport" | "capabilities"> &
      Partial<Pick<AgentLiveState, "model" | "fastMode">>,
    private readonly publish: (state: AgentLiveState) => void,
    private readonly intervalMs = LIVE_EMIT_INTERVAL_MS,
  ) {
    this.state = {
      provider: init.provider,
      transport: init.transport,
      capabilities: [...init.capabilities],
      ...(init.model ? { model: clip(init.model, 200) } : {}),
      ...(init.fastMode !== undefined ? { fastMode: init.fastMode } : {}),
    };
  }

  snapshot(): AgentLiveState {
    return structuredClone(this.state);
  }

  setCapabilities(capabilities: readonly AgentLiveCapability[]): void {
    this.mutate((state) => {
      state.capabilities = [...new Set(capabilities)].slice(0, 8);
    });
  }

  setUsage(usage: NonNullable<AgentLiveState["usage"]>): void {
    const counts = Object.fromEntries(
      Object.entries(usage).flatMap(([key, value]) =>
        value === undefined || !Number.isFinite(value)
          ? []
          : [
              [
                key,
                // Token counts must be whole; cost keeps its cents.
                key === "costUsd"
                  ? Math.max(0, value)
                  : Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(value))),
              ],
            ],
      ),
    );
    this.mutate((state) => {
      state.usage = { ...state.usage, ...counts };
    });
  }

  setLimits(limits: readonly AgentLiveLimit[]): void {
    this.mutate((state) => {
      const byId = new Map((state.limits ?? []).map((limit) => [limit.id, limit]));
      for (const limit of limits) {
        byId.set(limit.id, {
          ...limit,
          id: clip(limit.id, 80),
          label: clip(limit.label, 120),
          usedPercent: Math.min(1_000, Math.max(0, limit.usedPercent)),
        });
      }
      state.limits = [...byId.values()].slice(-8);
    });
  }

  setPlan(plan: readonly AgentLivePlanStep[]): void {
    this.mutate((state) => {
      state.plan = plan
        .filter((step) => step.text.trim())
        .slice(0, MAX_PLAN_STEPS)
        .map((step) => ({ ...step, text: clip(step.text.trim(), 600) }));
    });
  }

  setFileChanges(changes: readonly AgentLiveFileChange[]): void {
    this.mutate((state) => {
      const byPath = new Map(
        (state.fileChanges ?? []).map((change) => [change.path, change]),
      );
      for (const change of changes) {
        if (!change.path.trim()) continue;
        byPath.set(change.path, { ...change, path: clip(change.path, 1_024) });
      }
      state.fileChanges = [...byPath.values()].slice(-MAX_FILE_CHANGES);
    });
  }

  upsertTask(task: Partial<AgentLiveTask> & Pick<AgentLiveTask, "id">): void {
    this.mutate((state) => {
      const tasks = state.tasks ?? [];
      const index = tasks.findIndex((entry) => entry.id === task.id);
      const previous = index >= 0 ? tasks[index] : undefined;
      const merged: AgentLiveTask = {
        id: clip(task.id, 200),
        kind: task.kind ?? previous?.kind ?? "other",
        description: clip(
          (task.description ?? previous?.description ?? "Background work").trim() ||
            "Background work",
          600,
        ),
        status: task.status ?? previous?.status ?? "running",
        background: task.background ?? previous?.background ?? false,
        canStop: task.canStop ?? previous?.canStop ?? false,
        ...((task.startedAt ?? previous?.startedAt) !== undefined
          ? { startedAt: task.startedAt ?? previous?.startedAt }
          : {}),
        ...((task.summary ?? previous?.summary)
          ? { summary: clip(String(task.summary ?? previous?.summary), 600) }
          : {}),
      };
      if (merged.status !== "running") merged.canStop = false;
      const next = [...tasks];
      if (index >= 0) next[index] = merged;
      else next.push(merged);
      state.tasks = next.slice(-MAX_TASKS);
    });
  }

  replaceRunningTasks(ids: ReadonlySet<string>): void {
    this.mutate((state) => {
      state.tasks = (state.tasks ?? []).map((task) =>
        task.status === "running" && !ids.has(task.id)
          ? { ...task, status: "completed", canStop: false }
          : task,
      );
    });
  }

  getTask(id: string): AgentLiveTask | undefined {
    return this.state.tasks?.find((task) => task.id === id);
  }

  setQuestion(question: AgentLiveQuestion | undefined): void {
    this.mutate((state) => {
      if (question) state.question = clipQuestion(question);
      else delete state.question;
    });
    this.flush();
  }

  getQuestion(): AgentLiveQuestion | undefined {
    return this.state.question;
  }

  recordSteer(id: string, text: string, status: "pending" | "delivered" | "failed", error?: string): void {
    this.mutate((state) => {
      const steering = [...(state.steering ?? [])];
      const index = steering.findIndex((entry) => entry.id === id);
      const entry = {
        id: clip(id, 120),
        text: clip(text, 4_000),
        status,
        ...(error ? { error: clip(error, 600) } : {}),
      };
      if (index >= 0) steering[index] = entry;
      else steering.push(entry);
      state.steering = steering.slice(-MAX_STEERS);
    });
    this.flush();
  }

  /** Marks the steering message that matches `text` and is still pending as read. */
  confirmSteer(text: string): boolean {
    const entry = this.state.steering?.find(
      (steer) => steer.status === "pending" && steer.text === clip(text, 4_000),
    );
    if (!entry) return false;
    this.recordSteer(entry.id, entry.text, "delivered");
    return true;
  }

  /** Fails steering messages the provider never read, so the user can send them again. */
  failPendingSteers(reason: string): void {
    for (const steer of this.state.steering ?? []) {
      if (steer.status === "pending") this.recordSteer(steer.id, steer.text, "failed", reason);
    }
  }

  setSuggestions(suggestions: readonly string[]): void {
    const unique = [
      ...new Set(
        suggestions
          .map((suggestion) => suggestion.replace(/\s+/gu, " ").trim())
          .filter((suggestion) => suggestion.length > 0),
      ),
    ]
      .slice(0, 5)
      .map((suggestion) => clip(suggestion, 300));
    this.mutate((state) => {
      if (unique.length > 0) state.suggestions = unique;
      else delete state.suggestions;
    });
  }

  addNotice(tone: TaskPanelTone, text: string): void {
    const normalized = text.replace(/\s+/gu, " ").trim();
    if (!normalized) return;
    this.mutate((state) => {
      const notices = state.notices ?? [];
      if (notices.at(-1)?.text === clip(normalized, 600)) return;
      state.notices = [
        ...notices,
        {
          id: `notice-${this.nextNoticeId++}`,
          tone,
          text: clip(normalized, 600),
          timestamp: Date.now(),
        },
      ].slice(-MAX_NOTICES);
    });
  }

  setFastMode(fastMode: boolean | undefined): void {
    this.mutate((state) => {
      if (fastMode === undefined) delete state.fastMode;
      else state.fastMode = fastMode;
    });
  }

  /** Publishes immediately, ignoring the throttle. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.dirty || this.closed) return;
    this.dirty = false;
    this.lastEmitAt = Date.now();
    const parsed = agentLiveStateSchema.safeParse(this.state);
    if (parsed.success) {
      this.publish(parsed.data);
    } else if (!this.reportedInvalidState) {
      // Every field is clipped on the way in, so this points at a provider
      // value the tracker does not bound yet.
      this.reportedInvalidState = true;
      console.warn(`machdoch: live run details were not published: ${parsed.error.issues[0]?.message ?? "invalid state"}`);
    }
  }

  close(): void {
    this.flush();
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private mutate(mutator: (state: MutableLiveState) => void): void {
    if (this.closed) return;
    const before = JSON.stringify(this.state);
    mutator(this.state);
    if (JSON.stringify(this.state) === before) return;
    this.dirty = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.timer || this.closed) return;
    const wait = Math.max(0, this.intervalMs - (Date.now() - this.lastEmitAt));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, wait);
    const timer = this.timer as ReturnType<typeof setTimeout> & {
      unref?: () => void;
    };
    timer.unref?.();
  }
}

