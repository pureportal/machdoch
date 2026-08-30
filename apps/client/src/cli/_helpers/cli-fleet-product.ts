import { createHash, randomUUID } from "node:crypto";
import {
  productSnapshotSchema,
  productSnapshotVersion,
  type HostRequest,
  type HostResponse,
  type ProductCommand,
  type ProductSnapshot,
} from "@machdoch/fleet-protocol";
import { loadRuntimeConfig } from "../../core/config.js";
import { discoverCustomizations } from "../../core/customizations.js";
import { loadUserMemorySettings } from "../../core/env.js";
import {
  createTaskExecutionController,
  type TaskExecutionController,
} from "../../core/execution.js";
import {
  MAX_SESSION_MEMORY_ENTRIES,
  mergeConversationMemoryEntries,
} from "../../core/memory.js";
import {
  REASONING_MODES,
  isConfiguredModelProvider,
  type RuntimeConfig,
} from "../../core/runtime-contract.generated.js";
import type {
  ConversationMemoryEntry,
  TaskExecutionProgress,
  TaskExecutionResult,
} from "../../core/types.js";
import { createDiscoveryOptions } from "./cli-output.js";
import {
  FLEET_CLI_STATE_SCHEMA_VERSION,
  loadFleetCliState,
  saveFleetCliState,
  type FleetCliCommandRecord,
  type FleetCliMessage,
  type FleetCliSession,
  type FleetCliState,
} from "./cli-fleet-state.js";

interface FleetCliTaskSession {
  taskId: string;
  task: string;
  mode: string;
  state: string;
  message: string;
  cancellable: boolean;
  startedAt: number;
  updatedAt: number;
  progressCount: number;
  logs: Array<{
    createdAt: number;
    stream: string;
    toolName?: string;
    chunk: string;
  }>;
  timeline: Array<{
    createdAt: number;
    kind: string;
    phase: string;
    label: string;
    detail?: string;
    tone?: string;
    toolName?: string;
  }>;
}

interface ActiveFleetTask {
  sessionId: string;
  controller: TaskExecutionController;
}

interface FleetCliProductDependencies {
  loadRuntimeConfig: typeof loadRuntimeConfig;
  discoverCustomizations: typeof discoverCustomizations;
  createTaskExecutionController: typeof createTaskExecutionController;
  loadUserMemorySettings: typeof loadUserMemorySettings;
  loadState: typeof loadFleetCliState;
  saveState: typeof saveFleetCliState;
  createId: () => string;
  now: () => number;
}

type FleetProductErrorCode =
  | "invalidRequest"
  | "conflict"
  | "unavailable"
  | "internal";

class FleetProductError extends Error {
  constructor(
    readonly code: FleetProductErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const defaultDependencies: FleetCliProductDependencies = {
  loadRuntimeConfig,
  discoverCustomizations,
  createTaskExecutionController,
  loadUserMemorySettings,
  loadState: loadFleetCliState,
  saveState: saveFleetCliState,
  createId: randomUUID,
  now: Date.now,
};

const boundedText = (value: string, maximum = 12_000): string =>
  value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;

const promptPreview = (value: string): string =>
  boundedText(value.replace(/\s+/gu, " ").trim(), 240);

const sessionTitle = (prompt: string): string =>
  boundedText(prompt.replace(/\s+/gu, " ").trim(), 80) || "New chat";

const providerLabel = (provider: string): string =>
  provider
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

const commandDigest = (command: ProductCommand): string =>
  createHash("sha256").update(JSON.stringify(command)).digest("hex");

const createErrorResponse = (error: unknown): HostResponse => {
  if (error instanceof FleetProductError) {
    return {
      type: "error",
      code: error.code,
      message: boundedText(error.message),
    };
  }
  return {
    type: "error",
    code: "internal",
    message: boundedText(
      error instanceof Error ? error.message : String(error),
    ),
  };
};

const createSession = (
  config: RuntimeConfig,
  workspaceRoot: string,
  globalMemoryEnabled: boolean,
  createId: () => string,
  now: () => number,
): FleetCliSession => {
  const timestamp = now();
  return {
    id: createId(),
    title: "New chat",
    workspace: workspaceRoot,
    provider: config.provider,
    model: config.model,
    mode: config.mode,
    reasoning: config.reasoning,
    createdAt: timestamp,
    updatedAt: timestamp,
    tags: [],
    draft: "",
    promptHistory: [],
    sessionMemoryEnabled: true,
    globalMemoryEnabled,
    messages: [],
  };
};

const createInitialState = (
  config: RuntimeConfig,
  workspaceRoot: string,
  globalMemoryEnabled: boolean,
  dependencies: FleetCliProductDependencies,
): FleetCliState => {
  const session = createSession(
    config,
    workspaceRoot,
    globalMemoryEnabled,
    dependencies.createId,
    dependencies.now,
  );
  return {
    schemaVersion: FLEET_CLI_STATE_SCHEMA_VERSION,
    workspaceRoot,
    activeSessionId: session.id,
    sessions: [session],
    commands: [],
  };
};

const recoverInterruptedTasks = (
  state: FleetCliState,
  dependencies: FleetCliProductDependencies,
): boolean => {
  let changed = false;
  for (const session of state.sessions) {
    const pending = session.pendingTask;
    if (!pending) continue;
    const timestamp = dependencies.now();
    session.messages = [
      ...session.messages,
      {
        id: dependencies.createId(),
        role: "agent" as const,
        content: "The Fleet task was interrupted when the CLI service stopped.",
        createdAt: timestamp,
        taskId: pending.taskId,
      },
    ].slice(-200);
    delete session.pendingTask;
    session.updatedAt = timestamp;
    changed = true;
  }
  return changed;
};

const taskTerminalState = (result: TaskExecutionResult): string => {
  if (result.status === "cancelled") return "canceled";
  if (result.status === "executed" || result.status === "planned") {
    return "completed";
  }
  return "failed";
};

const createCommandRecord = (
  command: ProductCommand,
  commandId: string,
  createdAt: number,
  metadata: Partial<
    Pick<
      FleetCliCommandRecord,
      "taskId" | "sessionId" | "title" | "targetPreview"
    >
  > = {},
): FleetCliCommandRecord => ({
  commandId,
  digest: commandDigest(command),
  kind: command.kind,
  createdAt,
  ...(command.kind === "submit-message"
    ? { promptPreview: promptPreview(command.prompt) }
    : {}),
  ...metadata,
});

const cloneState = (state: FleetCliState): FleetCliState =>
  structuredClone(state);

export class FleetCliProductRuntime {
  private readonly activeTasks = new Map<string, ActiveFleetTask>();
  private readonly taskSessions = new Map<string, FleetCliTaskSession>();
  private readonly taskSettlements = new Map<string, Promise<void>>();
  private readonly sessionMemory = new Map<string, ConversationMemoryEntry[]>();
  private eventId: number;
  private mutationTail: Promise<void> = Promise.resolve();

  private constructor(
    private state: FleetCliState,
    private readonly dependencies: FleetCliProductDependencies,
  ) {
    this.eventId = dependencies.now();
  }

  static async create(
    workspaceRoot: string,
    dependencyOverrides: Partial<FleetCliProductDependencies> = {},
  ): Promise<FleetCliProductRuntime> {
    const dependencies = { ...defaultDependencies, ...dependencyOverrides };
    const [savedState, config, memory] = await Promise.all([
      dependencies.loadState(workspaceRoot),
      dependencies.loadRuntimeConfig(workspaceRoot),
      dependencies.loadUserMemorySettings(),
    ]);
    const state =
      savedState ??
      createInitialState(
        config,
        workspaceRoot,
        memory.globalEnabled,
        dependencies,
      );
    const recovered = recoverInterruptedTasks(state, dependencies);
    if (!savedState || recovered) await dependencies.saveState(state);
    return new FleetCliProductRuntime(state, dependencies);
  }

  async handleRequest(request: HostRequest): Promise<HostResponse> {
    try {
      switch (request.type) {
        case "getProductSnapshot":
          return {
            type: "productSnapshot",
            snapshot: await this.getSnapshot(),
          };
        case "executeProductCommand":
          return await this.executeCommand(request.command);
      }
    } catch (error) {
      return createErrorResponse(error);
    }
  }

  async shutdown(reason = "Fleet CLI service stopped."): Promise<void> {
    for (const task of this.activeTasks.values()) {
      task.controller.cancel(reason);
    }
    await Promise.allSettled([...this.taskSettlements.values()]);
  }

  private async serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release: () => void = () => undefined;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private getSession(state: FleetCliState, sessionId: string): FleetCliSession {
    const session = state.sessions.find((entry) => entry.id === sessionId);
    if (!session)
      throw new FleetProductError("invalidRequest", "Session not found.");
    return session;
  }

  private getActiveSession(state: FleetCliState): FleetCliSession {
    return this.getSession(state, state.activeSessionId);
  }

  private assertWorkspace(workspace: string | undefined): string {
    if (workspace !== undefined && workspace !== this.state.workspaceRoot) {
      throw new FleetProductError(
        "invalidRequest",
        "The workspace is not available to this Fleet CLI service.",
      );
    }
    return this.state.workspaceRoot;
  }

  private existingReceipt(
    state: FleetCliState,
    command: ProductCommand,
    commandId: string,
  ): HostResponse | null {
    const existing = state.commands.find(
      (entry) => entry.commandId === commandId,
    );
    if (!existing) return null;
    if (existing.digest !== commandDigest(command)) {
      throw new FleetProductError(
        "conflict",
        "The command id was already used for a different command.",
      );
    }
    return {
      type: "commandAccepted",
      receipt: { commandId, duplicate: true },
    };
  }

  private async commitCommand(
    command: ProductCommand,
    mutate: (
      state: FleetCliState,
      commandId: string,
      timestamp: number,
    ) =>
      | Promise<{
          record?: Partial<
            Pick<
              FleetCliCommandRecord,
              "taskId" | "sessionId" | "title" | "targetPreview"
            >
          >;
          afterCommit?: () => void;
        }>
      | {
          record?: Partial<
            Pick<
              FleetCliCommandRecord,
              "taskId" | "sessionId" | "title" | "targetPreview"
            >
          >;
          afterCommit?: () => void;
        },
  ): Promise<HostResponse> {
    return await this.serializeMutation(async () => {
      const commandId = command.commandId ?? this.dependencies.createId();
      const existing = this.existingReceipt(this.state, command, commandId);
      if (existing) return existing;
      const nextState = cloneState(this.state);
      const timestamp = this.dependencies.now();
      const outcome = await mutate(nextState, commandId, timestamp);
      nextState.commands = [
        createCommandRecord(command, commandId, timestamp, outcome.record),
        ...nextState.commands,
      ].slice(0, 100);
      await this.dependencies.saveState(nextState);
      this.state = nextState;
      this.eventId += 1;
      outcome.afterCommit?.();
      return {
        type: "commandAccepted",
        receipt: { commandId, duplicate: false },
      };
    });
  }

  private async executeCommand(command: ProductCommand): Promise<HostResponse> {
    switch (command.kind) {
      case "submit-message":
        return await this.submitMessage(command);
      case "cancel":
        return await this.cancelTask(command);
      case "retry":
      case "continue":
        return await this.repeatTask(command);
      case "create-session":
        return await this.commitCommand(command, async (state) => {
          const workspace = this.assertWorkspace(command.workspace);
          const [config, memory] = await Promise.all([
            this.dependencies.loadRuntimeConfig(workspace),
            this.dependencies.loadUserMemorySettings(),
          ]);
          const session = createSession(
            config,
            workspace,
            memory.globalEnabled,
            this.dependencies.createId,
            this.dependencies.now,
          );
          state.sessions.unshift(session);
          state.activeSessionId = session.id;
          return { record: { sessionId: session.id } };
        });
      case "activate-session":
        return await this.commitCommand(command, (state) => {
          this.getSession(state, command.sessionId);
          state.activeSessionId = command.sessionId;
          return { record: { sessionId: command.sessionId } };
        });
      case "rename-session":
        return await this.commitCommand(command, (state, _id, timestamp) => {
          const session = this.getSession(state, command.sessionId);
          session.title = command.title.trim();
          session.updatedAt = timestamp;
          return {
            record: { sessionId: session.id, title: session.title },
          };
        });
      case "tag-session":
        return await this.commitCommand(command, (state, _id, timestamp) => {
          const session = this.getSession(state, command.sessionId);
          session.tags = [...new Set(command.tags)];
          session.updatedAt = timestamp;
          return { record: { sessionId: session.id } };
        });
      case "update-draft":
        return await this.commitCommand(command, (state, _id, timestamp) => {
          const session = this.getSession(state, command.sessionId);
          session.draft = command.prompt;
          session.updatedAt = timestamp;
          return { record: { sessionId: session.id } };
        });
      case "clear-session-history":
        return await this.commitCommand(command, (state, _id, timestamp) => {
          const session = this.getSession(state, command.sessionId);
          if (session.pendingTask) {
            throw new FleetProductError(
              "conflict",
              "The session has a running task.",
            );
          }
          session.messages = [];
          session.promptHistory = [];
          session.updatedAt = timestamp;
          return { record: { sessionId: session.id } };
        });
      case "set-session-model":
        return await this.setSessionModel(command);
      case "set-session-mode":
        return await this.commitCommand(command, (state, _id, timestamp) => {
          const session = this.getSession(state, command.sessionId);
          session.mode = command.mode;
          session.updatedAt = timestamp;
          return { record: { sessionId: session.id } };
        });
      case "clear-session-mode":
        return await this.resetSessionMode(command, "mode");
      case "set-session-reasoning":
        return await this.commitCommand(command, (state, _id, timestamp) => {
          const session = this.getSession(state, command.sessionId);
          session.reasoning = command.reasoning;
          session.updatedAt = timestamp;
          return { record: { sessionId: session.id } };
        });
      case "clear-session-reasoning":
        return await this.resetSessionMode(command, "reasoning");
      case "set-session-workspace":
        return await this.commitCommand(command, (state, _id, timestamp) => {
          const session = this.getSession(state, command.sessionId);
          session.workspace = this.assertWorkspace(command.workspace);
          session.updatedAt = timestamp;
          return { record: { sessionId: session.id } };
        });
      case "clear-session-workspace":
        throw new FleetProductError(
          "invalidRequest",
          "A Fleet CLI session must keep its configured workspace.",
        );
      case "set-session-memory":
        return await this.commitCommand(command, (state, _id, timestamp) => {
          const session = this.getSession(state, command.sessionId);
          session.sessionMemoryEnabled = command.enabled;
          session.updatedAt = timestamp;
          return { record: { sessionId: session.id } };
        });
      case "archive-session":
      case "pin-session":
      case "duplicate-session":
      case "branch-session":
      case "delete-session":
        return await this.changeSessionLifecycle(command);
      case "set-global-memory":
      case "set-ui-control":
      case "remove-attachment":
      case "clear-attachments":
      case "apply-context-pack":
      case "delete-context-pack":
      case "save-message-context-pack":
      case "speak-message":
      case "stop-speaking":
      case "set-prompt-enhancement-mode":
      case "set-interview":
      case "cancel-prompt-enhancement":
      case "scheduler-trigger":
      case "scheduler-pause":
      case "scheduler-resume":
      case "scheduler-delete":
      case "scheduler-retry-run":
      case "scheduler-cancel-run":
      case "generate-media":
      case "cancel-media-run":
        throw new FleetProductError(
          "unavailable",
          "This operation is not available in the Fleet CLI service.",
        );
    }
  }

  private async setSessionModel(
    command: Extract<ProductCommand, { kind: "set-session-model" }>,
  ): Promise<HostResponse> {
    if (!isConfiguredModelProvider(command.provider)) {
      throw new FleetProductError(
        "invalidRequest",
        "Model provider is invalid.",
      );
    }
    const provider = command.provider;
    return await this.commitCommand(command, (state, _id, timestamp) => {
      const session = this.getSession(state, command.sessionId);
      session.provider = provider;
      session.model = command.model;
      session.updatedAt = timestamp;
      return { record: { sessionId: session.id } };
    });
  }

  private async resetSessionMode(
    command: Extract<
      ProductCommand,
      { kind: "clear-session-mode" | "clear-session-reasoning" }
    >,
    setting: "mode" | "reasoning",
  ): Promise<HostResponse> {
    return await this.commitCommand(command, async (state, _id, timestamp) => {
      const config = await this.dependencies.loadRuntimeConfig(
        this.state.workspaceRoot,
      );
      const session = this.getSession(state, command.sessionId);
      if (setting === "mode") session.mode = config.mode;
      else session.reasoning = config.reasoning;
      session.updatedAt = timestamp;
      return { record: { sessionId: session.id } };
    });
  }

  private async changeSessionLifecycle(
    command: Extract<
      ProductCommand,
      {
        kind:
          | "archive-session"
          | "pin-session"
          | "duplicate-session"
          | "branch-session"
          | "delete-session";
      }
    >,
  ): Promise<HostResponse> {
    return await this.commitCommand(command, async (state, _id, timestamp) => {
      const session = this.getSession(state, command.sessionId);
      if (session.pendingTask && command.kind !== "pin-session") {
        throw new FleetProductError(
          "conflict",
          "The session has a running task.",
        );
      }
      if (command.kind === "archive-session") {
        if (session.archivedAt) delete session.archivedAt;
        else session.archivedAt = timestamp;
        session.updatedAt = timestamp;
      } else if (command.kind === "pin-session") {
        if (session.pinnedAt) delete session.pinnedAt;
        else session.pinnedAt = timestamp;
        session.updatedAt = timestamp;
      } else if (
        command.kind === "duplicate-session" ||
        command.kind === "branch-session"
      ) {
        const copy = cloneState({
          ...state,
          sessions: [session],
        }).sessions[0];
        if (!copy)
          throw new FleetProductError("internal", "Session copy failed.");
        copy.id = this.dependencies.createId();
        copy.title = `${session.title} copy`;
        copy.createdAt = timestamp;
        copy.updatedAt = timestamp;
        copy.draft = "";
        delete copy.archivedAt;
        delete copy.pinnedAt;
        delete copy.pendingTask;
        if (command.kind === "branch-session") {
          copy.messages = [...session.messages];
        }
        state.sessions.unshift(copy);
        state.activeSessionId = copy.id;
        return { record: { sessionId: copy.id } };
      } else {
        state.sessions = state.sessions.filter(
          (entry) => entry.id !== session.id,
        );
        if (state.sessions.length === 0) {
          const [config, memory] = await Promise.all([
            this.dependencies.loadRuntimeConfig(state.workspaceRoot),
            this.dependencies.loadUserMemorySettings(),
          ]);
          state.sessions.push(
            createSession(
              config,
              state.workspaceRoot,
              memory.globalEnabled,
              this.dependencies.createId,
              this.dependencies.now,
            ),
          );
        }
        if (state.activeSessionId === session.id) {
          state.activeSessionId =
            state.sessions[0]?.id ?? state.activeSessionId;
        }
      }
      return { record: { sessionId: session.id } };
    });
  }

  private async loadSessionRuntimeConfig(
    session: FleetCliSession,
  ): Promise<RuntimeConfig> {
    return await this.dependencies.loadRuntimeConfig(
      session.workspace,
      session.mode,
      session.model,
      session.provider === "unconfigured" ? undefined : session.provider,
      undefined,
      session.reasoning,
    );
  }

  private assertRuntimeAvailable(config: RuntimeConfig): void {
    const providerAvailable = config.providerAvailability.some(
      (entry) => entry.provider === config.provider && entry.configured,
    );
    if (config.offline) {
      throw new FleetProductError(
        "unavailable",
        "Offline mode is enabled for this workspace.",
      );
    }
    if (config.provider === "unconfigured" || !providerAvailable) {
      throw new FleetProductError(
        "unavailable",
        "No configured model provider is available.",
      );
    }
  }

  private async prepareTask(
    session: FleetCliSession,
    prompt: string,
    taskId: string,
  ): Promise<TaskExecutionController> {
    const config = await this.loadSessionRuntimeConfig(session);
    this.assertRuntimeAvailable(config);
    const customizations = await this.dependencies.discoverCustomizations(
      session.workspace,
      createDiscoveryOptions(config.compatibility.discoverGithubCustomizations),
    );
    const memory = await this.dependencies.loadUserMemorySettings();
    const history = session.messages.map((message) => ({
      role:
        message.role === "user" ? ("user" as const) : ("assistant" as const),
      content: message.content,
      createdAt: message.createdAt,
    }));
    return this.dependencies.createTaskExecutionController(
      prompt,
      config,
      customizations,
      {
        runId: taskId,
        conversationContext: {
          workspace: { selection: "selected", root: session.workspace },
          history,
          sessionMemoryEnabled: session.sessionMemoryEnabled,
          sessionMemory: this.sessionMemory.get(session.id) ?? [],
          globalMemoryEnabled: session.globalMemoryEnabled,
          globalMemory: memory.entries,
          uiControlEnabled: false,
        },
        onStateChange: (progress) => this.recordTaskProgress(taskId, progress),
        onActionOutput: (output) => {
          const task = this.taskSessions.get(taskId);
          if (!task) return;
          task.logs = [
            ...task.logs,
            {
              createdAt: this.dependencies.now(),
              stream: output.stream,
              toolName: output.toolName,
              chunk: boundedText(output.chunk),
            },
          ].slice(-100);
          task.updatedAt = this.dependencies.now();
          task.progressCount += 1;
          this.eventId += 1;
        },
      },
    );
  }

  private async submitMessage(
    command: Extract<ProductCommand, { kind: "submit-message" }>,
  ): Promise<HostResponse> {
    if (command.promptEnhancementMode !== "off" || command.interviewEnabled) {
      throw new FleetProductError(
        "unavailable",
        "Prompt enhancement and interviews are not available in the Fleet CLI service.",
      );
    }
    return await this.submitTask(command, command.sessionId, command.prompt);
  }

  private async submitTask(
    command: Extract<
      ProductCommand,
      { kind: "submit-message" | "retry" | "continue" }
    >,
    sessionId: string,
    prompt: string,
  ): Promise<HostResponse> {
    return await this.commitCommand(command, async (state, _id, timestamp) => {
      const currentSession = this.getSession(this.state, sessionId);
      if (currentSession.pendingTask) {
        throw new FleetProductError(
          "conflict",
          "The session has a running task.",
        );
      }
      const taskId = this.dependencies.createId();
      const controller = await this.prepareTask(currentSession, prompt, taskId);
      const session = this.getSession(state, sessionId);
      session.messages = [
        ...session.messages,
        {
          id: this.dependencies.createId(),
          role: "user" as const,
          content: prompt,
          createdAt: timestamp,
          taskId,
        },
      ].slice(-200);
      session.pendingTask = {
        taskId,
        prompt,
        startedAt: timestamp,
      };
      session.promptHistory = [
        ...session.promptHistory.filter((entry) => entry !== prompt),
        prompt,
      ].slice(-30);
      session.draft = "";
      session.updatedAt = timestamp;
      if (session.title === "New chat") session.title = sessionTitle(prompt);
      const taskSession: FleetCliTaskSession = {
        taskId,
        task: prompt,
        mode: session.mode,
        state: "starting",
        message: "Starting task",
        cancellable: true,
        startedAt: timestamp,
        updatedAt: timestamp,
        progressCount: 0,
        logs: [],
        timeline: [],
      };
      return {
        record: { taskId, sessionId: session.id },
        afterCommit: () => this.startTask(session.id, taskSession, controller),
      };
    });
  }

  private startTask(
    sessionId: string,
    taskSession: FleetCliTaskSession,
    controller: TaskExecutionController,
  ): void {
    this.activeTasks.set(taskSession.taskId, { sessionId, controller });
    this.taskSessions.set(taskSession.taskId, taskSession);
    this.eventId += 1;
    const settlement = controller
      .execute()
      .then((result) => this.completeTask(taskSession.taskId, result))
      .catch((error: unknown) => this.failTask(taskSession.taskId, error))
      .finally(() => {
        this.taskSettlements.delete(taskSession.taskId);
      });
    this.taskSettlements.set(taskSession.taskId, settlement);
  }

  private recordTaskProgress(
    taskId: string,
    progress: TaskExecutionProgress,
  ): void {
    const task = this.taskSessions.get(taskId);
    if (!task) return;
    const timestamp = this.dependencies.now();
    task.state = progress.state;
    task.message = boundedText(progress.message);
    task.cancellable = progress.cancellable;
    task.updatedAt = timestamp;
    task.progressCount += 1;
    if (progress.timelineEvent) {
      task.timeline = [
        ...task.timeline,
        {
          createdAt: timestamp,
          kind: progress.timelineEvent.kind,
          phase: progress.timelineEvent.phase,
          label: boundedText(progress.timelineEvent.label),
          ...(progress.timelineEvent.detail
            ? { detail: boundedText(progress.timelineEvent.detail) }
            : {}),
          ...(progress.timelineEvent.tone
            ? { tone: progress.timelineEvent.tone }
            : {}),
          ...(progress.timelineEvent.toolName
            ? { toolName: progress.timelineEvent.toolName }
            : {}),
        },
      ].slice(-100);
    }
    this.eventId += 1;
  }

  private async completeTask(
    taskId: string,
    result: TaskExecutionResult,
  ): Promise<void> {
    await this.serializeMutation(async () => {
      const active = this.activeTasks.get(taskId);
      if (!active) return;
      const nextState = cloneState(this.state);
      const session = this.getSession(nextState, active.sessionId);
      if (session.pendingTask?.taskId !== taskId) return;
      const timestamp = this.dependencies.now();
      const content = boundedText(
        result.response?.markdown.trim() || result.summary.trim(),
      );
      session.messages = [
        ...session.messages,
        {
          id: this.dependencies.createId(),
          role: "agent" as const,
          content,
          createdAt: timestamp,
          taskId,
        },
      ].slice(-200);
      delete session.pendingTask;
      session.updatedAt = timestamp;
      const updates =
        result.memoryUpdates
          ?.filter((update) => update.scope === "session")
          .map((update) => update.entry) ?? [];
      if (updates.length > 0) {
        this.sessionMemory.set(
          session.id,
          mergeConversationMemoryEntries(
            this.sessionMemory.get(session.id) ?? [],
            updates,
            MAX_SESSION_MEMORY_ENTRIES,
          ),
        );
      }
      await this.dependencies.saveState(nextState);
      this.state = nextState;
      this.activeTasks.delete(taskId);
      const task = this.taskSessions.get(taskId);
      if (task) {
        task.state = taskTerminalState(result);
        task.message = boundedText(result.summary);
        task.cancellable = false;
        task.updatedAt = timestamp;
        task.progressCount += 1;
      }
      this.eventId += 1;
    });
  }

  private async failTask(taskId: string, error: unknown): Promise<void> {
    await this.serializeMutation(async () => {
      const active = this.activeTasks.get(taskId);
      if (!active) return;
      const nextState = cloneState(this.state);
      const session = this.getSession(nextState, active.sessionId);
      if (session.pendingTask?.taskId !== taskId) return;
      const timestamp = this.dependencies.now();
      const message = boundedText(
        error instanceof Error ? error.message : "The Fleet task failed.",
      );
      session.messages = [
        ...session.messages,
        {
          id: this.dependencies.createId(),
          role: "agent" as const,
          content: message,
          createdAt: timestamp,
          taskId,
        },
      ].slice(-200);
      delete session.pendingTask;
      session.updatedAt = timestamp;
      await this.dependencies.saveState(nextState);
      this.state = nextState;
      this.activeTasks.delete(taskId);
      const task = this.taskSessions.get(taskId);
      if (task) {
        task.state = "failed";
        task.message = message;
        task.cancellable = false;
        task.updatedAt = timestamp;
        task.progressCount += 1;
      }
      this.eventId += 1;
    });
  }

  private async cancelTask(
    command: Extract<ProductCommand, { kind: "cancel" }>,
  ): Promise<HostResponse> {
    const active = this.activeTasks.get(command.taskId);
    if (!active) {
      throw new FleetProductError("invalidRequest", "Task not found.");
    }
    return await this.commitCommand(command, () => ({
      record: { taskId: command.taskId, sessionId: active.sessionId },
      afterCommit: () => active.controller.cancel("Fleet task cancelled."),
    }));
  }

  private async repeatTask(
    command: Extract<ProductCommand, { kind: "retry" | "continue" }>,
  ): Promise<HostResponse> {
    const session = this.state.sessions.find((entry) =>
      entry.messages.some(
        (message) =>
          message.taskId === command.taskId && message.role === "user",
      ),
    );
    const message = session?.messages.find(
      (entry) => entry.taskId === command.taskId && entry.role === "user",
    );
    if (!session || !message) {
      throw new FleetProductError("invalidRequest", "Task not found.");
    }
    const prompt =
      command.kind === "retry"
        ? message.content
        : "Continue the previous task.";
    return await this.submitTask(command, session.id, prompt);
  }

  private createMessageSnapshot(
    message: FleetCliMessage,
  ): NonNullable<ProductSnapshot["shell"]>["visibleMessages"][number] {
    const active = message.taskId
      ? this.activeTasks.has(message.taskId)
      : false;
    return {
      id: message.id,
      role: message.role,
      content: boundedText(message.content),
      createdAt: message.createdAt,
      ...(message.taskId ? { taskId: message.taskId } : {}),
      presentation: "message",
      attachments: [],
      actions: {
        canRetry:
          message.role === "agent" && !active && Boolean(message.taskId),
        canContinue:
          message.role === "agent" && !active && Boolean(message.taskId),
        canSaveAsContextPack: false,
        canSpeak: false,
        isSpeaking: false,
      },
    };
  }

  private async getSnapshot(): Promise<ProductSnapshot> {
    await this.mutationTail;
    const state = this.state;
    const activeSession = this.getActiveSession(state);
    const config = await this.loadSessionRuntimeConfig(activeSession);
    const configuredProviders = config.providerAvailability.filter(
      (entry) => entry.configured,
    );
    const providerAvailable = config.providerAvailability.some(
      (entry) => entry.provider === activeSession.provider && entry.configured,
    );
    const running = Boolean(activeSession.pendingTask);
    const timestamp = this.dependencies.now();
    const snapshot = {
      enabled: true,
      serverTime: timestamp,
      eventId: this.eventId,
      sessions: [...this.taskSessions.values()]
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, 128),
      commands: state.commands.map(
        ({ digest: _digest, ...command }) => command,
      ),
      shell: {
        version: productSnapshotVersion,
        capturedAt: timestamp,
        activeSessionId: activeSession.id,
        sessions: state.sessions.map((session) => ({
          id: session.id,
          title: session.title,
          status: session.pendingTask ? "running" : "ready",
          workspace: session.workspace,
          provider: session.provider,
          model: session.model,
          mode: session.mode,
          effectiveMode: session.mode,
          reasoning: session.reasoning,
          effectiveReasoning: session.reasoning,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          ...(session.archivedAt ? { archivedAt: session.archivedAt } : {}),
          ...(session.pinnedAt ? { pinnedAt: session.pinnedAt } : {}),
          tags: session.tags,
          messageCount: session.messages.length,
          promptHistoryCount: session.promptHistory.length,
          attachmentCount: 0,
          ...(session.pendingTask
            ? { runningTaskId: session.pendingTask.taskId }
            : {}),
          canRename: true,
          canDelete: !session.pendingTask,
          canArchive: !session.pendingTask,
          canPin: true,
          canDuplicate: !session.pendingTask,
          canBranch: !session.pendingTask,
        })),
        workspaces: [
          {
            root: state.workspaceRoot,
            label:
              state.workspaceRoot
                .split(/[\\/]+/u)
                .filter(Boolean)
                .at(-1) ?? state.workspaceRoot,
            sessionCount: state.sessions.length,
          },
        ],
        visibleMessages: activeSession.messages
          .slice(-80)
          .map((message) => this.createMessageSnapshot(message)),
        composer: {
          sessionId: activeSession.id,
          draft: activeSession.draft,
          provider: activeSession.provider,
          providerLabel: providerLabel(activeSession.provider),
          model: activeSession.model,
          modelLabel: activeSession.model,
          modelCatalogLoading: false,
          modelCatalog: config.providerAvailability.map((entry) => ({
            provider: entry.provider,
            label: providerLabel(entry.provider),
            available: entry.configured,
            models:
              entry.provider === activeSession.provider
                ? [{ id: activeSession.model, label: activeSession.model }]
                : [],
          })),
          mode: activeSession.mode,
          defaultMode: config.mode,
          reasoning: activeSession.reasoning,
          defaultReasoning: config.reasoning,
          reasoningOptions: [...REASONING_MODES],
          promptEnhancementMode: "off" as const,
          interviewEnabled: false,
          interviewAvailable: false,
          workspace: activeSession.workspace,
          workspaceLabel:
            activeSession.workspace
              .split(/[\\/]+/u)
              .filter(Boolean)
              .at(-1) ?? activeSession.workspace,
          canSend: !running && providerAvailable && !config.offline,
          ...(!providerAvailable
            ? {
                sendDisabledReason:
                  "No configured model provider is available.",
              }
            : config.offline
              ? { sendDisabledReason: "Offline mode is enabled." }
              : {}),
          isExecuting: running,
          sessionMemoryEnabled: activeSession.sessionMemoryEnabled,
          globalMemoryAvailable: false,
          globalMemoryEnabled: activeSession.globalMemoryEnabled,
          uiControlAvailable: false,
          uiControlEnabled: false,
          uiControlDescription: "",
          attachments: [],
          chooserProviders: configuredProviders.map((entry) => entry.provider),
          matchedContextPackIds: [],
        },
        runtime: {
          loading: false,
          hasAnyProvider: configuredProviders.length > 0,
          providerStatuses: config.providerAvailability.map((entry) => ({
            provider: entry.provider,
            available: entry.configured,
            ...(!entry.configured ? { reason: "Not configured." } : {}),
          })),
          mode: activeSession.mode,
          reasoning: activeSession.reasoning,
          webSearch: {
            available: config.webSearch.providerAvailability.some(
              (entry) => entry.configured,
            ),
          },
        },
        contextPacks: [],
        promptHistory: activeSession.promptHistory,
      },
    };
    const parsed = productSnapshotSchema.safeParse(snapshot);
    if (!parsed.success) {
      throw new FleetProductError(
        "internal",
        `Fleet CLI product state is invalid: ${parsed.error.issues[0]?.message ?? "unknown validation error"}`,
      );
    }
    return parsed.data;
  }
}
