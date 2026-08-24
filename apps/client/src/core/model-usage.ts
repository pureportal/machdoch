import { AsyncLocalStorage } from "node:async_hooks";
import type {
  AgentModelRequestAttempt,
  AgentModelRequestAttemptHandler,
  AgentModelStreamUsage,
  AgentModelToolResult,
  AgentModelToolSpec,
  AgentModelTurn,
  TaskExecutionResult,
  TaskExecutionTokenUsage,
  TaskModelCallStage,
  TaskModelRequestAttemptUsage,
  TaskModelUsageCall,
  TaskModelUsageReport,
  TaskModelUsageTotals,
} from "./types.js";
import type { ModelProvider } from "./runtime-contract.generated.js";

const taskModelUsageStorage = new AsyncLocalStorage<TaskModelUsageRecorder>();
const providerHttpRequestStorage = new AsyncLocalStorage<
  (attempt: Omit<AgentModelRequestAttempt, "attempt">) => void
>();

const utf8ByteLength = (value: string): number =>
  Buffer.byteLength(value, "utf8");

const serializedByteLength = (value: unknown): number => {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 0 : utf8ByteLength(serialized);
};

const positiveInteger = (value: number | undefined): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;

const normalizeUsage = (
  usage: AgentModelStreamUsage | undefined,
): TaskExecutionTokenUsage | undefined => {
  if (!usage) {
    return undefined;
  }

  const normalized: TaskExecutionTokenUsage = {};
  const fields = [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "cachedInputTokens",
    "cacheReadInputTokens",
    "cacheWriteInputTokens",
    "toolUseInputTokens",
    "reasoningTokens",
  ] as const;

  for (const field of fields) {
    const value = positiveInteger(usage[field]);
    if (value !== undefined) {
      normalized[field] = value;
    }
  }

  if (
    normalized.totalTokens === undefined &&
    normalized.inputTokens !== undefined &&
    normalized.outputTokens !== undefined
  ) {
    normalized.totalTokens = normalized.inputTokens + normalized.outputTokens;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
};

const createAttemptUsage = (
  attempt: AgentModelRequestAttempt,
): TaskModelRequestAttemptUsage => ({
  attempt: attempt.attempt,
  durationMs: Math.max(0, Math.trunc(attempt.elapsedMs)),
  status: attempt.ok ? "completed" : "failed",
  ...(attempt.errorName ? { errorName: attempt.errorName } : {}),
});

export const createObservedProviderFetch = (
  provider: ModelProvider,
): typeof globalThis.fetch => {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const observedFetch: typeof globalThis.fetch = async (input, init) => {
    const recordAttempt = providerHttpRequestStorage.getStore();
    if (!recordAttempt) {
      return await nativeFetch(input, init);
    }

    const startedAt = Date.now();
    try {
      const response = await nativeFetch(input, init);
      recordAttempt({
        provider,
        operation: "sdkHttpRequest",
        elapsedMs: Date.now() - startedAt,
        ok: response.ok,
        ...(response.ok ? {} : { errorName: `HTTP_${response.status}` }),
      });
      return response;
    } catch (error) {
      recordAttempt({
        provider,
        operation: "sdkHttpRequest",
        elapsedMs: Date.now() - startedAt,
        ok: false,
        errorName: error instanceof Error ? error.name : "FetchError",
      });
      throw error;
    }
  };

  return observedFetch;
};

export interface ObservedModelCall {
  stage: TaskModelCallStage;
  provider: ModelProvider;
  model: string;
  executionPath?: "api" | "cli";
  operation: string;
  requestPayload?: unknown;
  requestBytes?: number;
  toolDefinitions?: readonly AgentModelToolSpec[];
  toolResults?: readonly AgentModelToolResult[];
  modelCallCount?: number;
  modelCallCountReported?: boolean;
}

interface CompletedObservedModelCall extends ObservedModelCall {
  status: "completed" | "failed";
  durationMs: number;
  responseBytes: number;
  attempts: AgentModelRequestAttempt[];
  usage?: AgentModelStreamUsage;
  providerRequestCount?: number;
  providerRequestCountReported?: boolean;
  retryCount?: number;
  retryCountReported?: boolean;
}

interface PendingObservedModelCall {
  call: ObservedModelCall;
  startedAt: number;
}

const createDefaultAttempt = (
  durationMs: number,
  status: CompletedObservedModelCall["status"],
): AgentModelRequestAttempt => ({
  provider: "unreported",
  operation: "unreported",
  attempt: 1,
  elapsedMs: durationMs,
  ok: status === "completed",
});

export class TaskModelUsageRecorder {
  private readonly calls: TaskModelUsageCall[] = [];
  private readonly pendingCalls = new Map<number, PendingObservedModelCall>();
  private nextPendingCallId = 1;

  beginObservedCall(call: ObservedModelCall, startedAt: number): number {
    const callId = this.nextPendingCallId;
    this.nextPendingCallId += 1;
    this.pendingCalls.set(callId, { call, startedAt });
    return callId;
  }

  finishObservedCall(callId: number, call: CompletedObservedModelCall): void {
    if (!this.pendingCalls.delete(callId)) {
      return;
    }

    this.record(call);
  }

  record(call: CompletedObservedModelCall): void {
    const attempts =
      call.attempts.length > 0
        ? call.attempts
        : [createDefaultAttempt(call.durationMs, call.status)];
    const normalizedUsage = normalizeUsage(call.usage);
    const modelCallCount = Math.max(1, Math.trunc(call.modelCallCount ?? 1));
    const modelCallCountReported = call.modelCallCountReported ?? true;
    const retryCount = Math.max(
      0,
      Math.trunc(call.retryCount ?? Math.max(0, attempts.length - 1)),
    );

    this.calls.push({
      sequence: this.calls.length + 1,
      stage: call.stage,
      provider: call.provider,
      model: call.model,
      executionPath: call.executionPath ?? "api",
      operation: call.operation,
      status: call.status,
      modelCallCount,
      modelCallCountReported,
      providerRequestCount: Math.max(
        attempts.length,
        Math.trunc(call.providerRequestCount ?? modelCallCount + retryCount),
      ),
      providerRequestCountReported:
        call.providerRequestCountReported ??
        (modelCallCountReported && (call.retryCountReported ?? true)),
      durationMs: Math.max(0, Math.trunc(call.durationMs)),
      requestBytes: Math.max(
        0,
        Math.trunc(
          call.requestBytes ?? serializedByteLength(call.requestPayload),
        ),
      ),
      responseBytes: Math.max(0, Math.trunc(call.responseBytes)),
      toolDefinitionBytes: serializedByteLength(call.toolDefinitions ?? []),
      toolResultBytes: serializedByteLength(call.toolResults ?? []),
      attempts: attempts.map(createAttemptUsage),
      retryCount,
      retryCountReported: call.retryCountReported ?? true,
      usageReported: normalizedUsage !== undefined,
      ...(normalizedUsage ? { usage: normalizedUsage } : {}),
    });
  }

  createReport(): TaskModelUsageReport {
    for (const pending of this.pendingCalls.values()) {
      this.record({
        ...pending.call,
        status: "failed",
        durationMs: Date.now() - pending.startedAt,
        responseBytes: 0,
        attempts: [],
        retryCountReported: false,
      });
    }
    this.pendingCalls.clear();

    const totals: TaskModelUsageTotals = {
      callCount: this.calls.length,
      modelCallCount: 0,
      providerRequestCount: 0,
      apiCallCount: 0,
      cliCallCount: 0,
      auxiliaryCallCount: 0,
      retryCount: 0,
      modelCallTelemetryUnavailableCallCount: 0,
      providerRequestTelemetryUnavailableCallCount: 0,
      retryTelemetryUnavailableCallCount: 0,
      failedCallCount: 0,
      failedRequestCount: 0,
      usageReportedCallCount: 0,
      usageUnavailableCallCount: 0,
      requestBytes: 0,
      responseBytes: 0,
      toolDefinitionBytes: 0,
      toolResultBytes: 0,
      aggregateCallDurationMs: 0,
    };
    const tokenFields = [
      "inputTokens",
      "outputTokens",
      "totalTokens",
      "cachedInputTokens",
      "cacheReadInputTokens",
      "cacheWriteInputTokens",
      "toolUseInputTokens",
      "reasoningTokens",
    ] as const;

    for (const call of this.calls) {
      totals.modelCallCount += call.modelCallCount;
      totals.providerRequestCount += call.providerRequestCount;
      totals.modelCallTelemetryUnavailableCallCount +=
        call.modelCallCountReported ? 0 : 1;
      totals.providerRequestTelemetryUnavailableCallCount +=
        call.providerRequestCountReported ? 0 : 1;
      totals.apiCallCount += call.executionPath === "api" ? 1 : 0;
      totals.cliCallCount += call.executionPath === "cli" ? 1 : 0;
      totals.auxiliaryCallCount +=
        call.stage === "executor" || call.stage === "external-agent" ? 0 : 1;
      totals.retryCount += call.retryCount;
      totals.retryTelemetryUnavailableCallCount += call.retryCountReported
        ? 0
        : 1;
      totals.failedCallCount += call.status === "failed" ? 1 : 0;
      totals.failedRequestCount += call.attempts.filter(
        (attempt) => attempt.status === "failed",
      ).length;
      totals.usageReportedCallCount += call.usageReported ? 1 : 0;
      totals.usageUnavailableCallCount += call.usageReported ? 0 : 1;
      totals.requestBytes += call.requestBytes;
      totals.responseBytes += call.responseBytes;
      totals.toolDefinitionBytes += call.toolDefinitionBytes;
      totals.toolResultBytes += call.toolResultBytes;
      totals.aggregateCallDurationMs += call.durationMs;

      for (const field of tokenFields) {
        const value = call.usage?.[field];
        if (value !== undefined) {
          totals[field] = (totals[field] ?? 0) + value;
        }
      }
    }

    return {
      version: 1,
      calls: this.calls.map((call) => structuredClone(call)),
      totals,
    };
  }
}

export const getActiveTaskModelUsageRecorder = ():
  | TaskModelUsageRecorder
  | undefined => taskModelUsageStorage.getStore();

export const observeAgentModelCall = async (
  call: ObservedModelCall,
  execute: (
    onRequestAttempt: AgentModelRequestAttemptHandler | undefined,
  ) => Promise<AgentModelTurn>,
): Promise<AgentModelTurn> => {
  const recorder = getActiveTaskModelUsageRecorder();
  if (!recorder) {
    return await execute(undefined);
  }

  const attempts: AgentModelRequestAttempt[] = [];
  const httpAttempts: AgentModelRequestAttempt[] = [];
  const startedAt = Date.now();
  const observedCallId = recorder.beginObservedCall(call, startedAt);
  const onRequestAttempt: AgentModelRequestAttemptHandler = (attempt) => {
    attempts.push({ ...attempt });
  };
  const recordHttpAttempt = (
    attempt: Omit<AgentModelRequestAttempt, "attempt">,
  ): void => {
    httpAttempts.push({ ...attempt, attempt: httpAttempts.length + 1 });
  };
  const getReportedAttempts = (): AgentModelRequestAttempt[] =>
    httpAttempts.length > 0 ? httpAttempts : attempts;

  try {
    const turn = await providerHttpRequestStorage.run(
      recordHttpAttempt,
      async () => await execute(onRequestAttempt),
    );
    const reportedAttempts = getReportedAttempts();
    recorder.finishObservedCall(observedCallId, {
      ...call,
      status: "completed",
      durationMs: Date.now() - startedAt,
      responseBytes: serializedByteLength({
        text: turn.text,
        toolCalls: turn.toolCalls,
        stopReason: turn.stopReason,
      }),
      attempts: reportedAttempts,
      retryCountReported: reportedAttempts.length > 0,
      ...(turn.usage ? { usage: turn.usage } : {}),
    });
    return turn;
  } catch (error) {
    const reportedAttempts = getReportedAttempts();
    recorder.finishObservedCall(observedCallId, {
      ...call,
      status: "failed",
      durationMs: Date.now() - startedAt,
      responseBytes: 0,
      attempts: reportedAttempts,
      retryCountReported: reportedAttempts.length > 0,
    });
    throw error;
  }
};

export const recordExternalAgentModelCall = (
  call: ObservedModelCall & {
    status: "completed" | "failed";
    durationMs: number;
    responseBytes: number;
    retryCount?: number;
    modelCallCountReported?: boolean;
    retryCountReported?: boolean;
    usage?: AgentModelStreamUsage;
  },
): void => {
  const recorder = getActiveTaskModelUsageRecorder();
  if (!recorder) {
    return;
  }

  const attempts = Array.from(
    { length: Math.max(1, Math.trunc((call.retryCount ?? 0) + 1)) },
    (_, index): AgentModelRequestAttempt => ({
      provider: call.provider,
      operation: call.operation,
      attempt: index + 1,
      elapsedMs: index === (call.retryCount ?? 0) ? call.durationMs : 0,
      ok: index === (call.retryCount ?? 0) && call.status === "completed",
    }),
  );

  recorder.record({
    ...call,
    attempts,
    providerRequestCount:
      Math.max(1, Math.trunc(call.modelCallCount ?? 1)) +
      Math.max(0, Math.trunc(call.retryCount ?? 0)),
    providerRequestCountReported:
      (call.modelCallCountReported ?? true) &&
      (call.retryCountReported ?? false),
    retryCount: call.retryCount ?? 0,
    retryCountReported: call.retryCountReported ?? false,
  });
};

export const isTaskModelUsageReport = (
  value: unknown,
): value is TaskModelUsageReport => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const report = value as Partial<TaskModelUsageReport>;
  return report.version === 1 && Array.isArray(report.calls);
};

export const attachTaskModelUsageReport = (
  result: TaskExecutionResult,
  report: TaskModelUsageReport,
): TaskExecutionResult => ({
  ...result,
  metadata: {
    ...(result.metadata ?? {}),
    modelUsage: report,
  },
});

export const runWithTaskModelUsageRecording = async (
  execute: () => Promise<TaskExecutionResult>,
): Promise<TaskExecutionResult> => {
  if (getActiveTaskModelUsageRecorder()) {
    return await execute();
  }

  const recorder = new TaskModelUsageRecorder();

  return await taskModelUsageStorage.run(recorder, async () => {
    const result = await execute();
    return attachTaskModelUsageReport(result, recorder.createReport());
  });
};
