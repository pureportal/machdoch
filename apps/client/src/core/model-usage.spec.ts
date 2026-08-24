import { describe, expect, it, vi } from "vitest";
import {
  createObservedProviderFetch,
  observeAgentModelCall,
  recordExternalAgentModelCall,
  runWithTaskModelUsageRecording,
} from "./model-usage.js";
import type { TaskExecutionResult, TaskModelUsageReport } from "./types.js";

const createResult = (): TaskExecutionResult => ({
  task: "Inspect usage",
  mode: "machdoch",
  status: "executed",
  summary: "Done",
  executedTools: [],
  outputSections: [],
});

describe("task model usage recording", () => {
  it("counts SDK-managed HTTP retries without changing their retry policy", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock;

    try {
      const observedFetch = createObservedProviderFetch("openai");
      const result = await runWithTaskModelUsageRecording(async () => {
        await observeAgentModelCall(
          {
            stage: "executor",
            provider: "openai",
            model: "gpt-5.5",
            operation: "startExecutorCycle",
          },
          async (onRequestAttempt) => {
            await observedFetch("https://provider.invalid/v1/responses");
            await observedFetch("https://provider.invalid/v1/responses");
            onRequestAttempt?.({
              provider: "openai",
              operation: "startTurn",
              attempt: 1,
              elapsedMs: 5,
              ok: true,
            });
            return {
              text: "done",
              toolCalls: [],
              usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
            };
          },
        );
        return createResult();
      });
      const report = result.metadata?.modelUsage as TaskModelUsageReport;

      expect(report.calls[0]).toMatchObject({
        providerRequestCount: 2,
        providerRequestCountReported: true,
        retryCount: 1,
        retryCountReported: true,
      });
      expect(report.calls[0]?.attempts).toEqual([
        expect.objectContaining({ status: "failed", errorName: "HTTP_429" }),
        expect.objectContaining({ status: "completed" }),
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reports a complete representative API task across primary and auxiliary stages", async () => {
    vi.useFakeTimers();

    try {
      const stages = [
        {
          stage: "conversation-summary" as const,
          operation: "summarizeConversationHistory",
          durationMs: 12,
          requestBytes: 400,
          usage: { inputTokens: 120, outputTokens: 15, totalTokens: 135 },
        },
        {
          stage: "executor" as const,
          operation: "startExecutorCycle",
          durationMs: 40,
          requestBytes: 100_000,
          usage: {
            inputTokens: 1_000,
            outputTokens: 120,
            totalTokens: 1_120,
            cachedInputTokens: 600,
            cacheReadInputTokens: 600,
          },
          retry: true,
        },
        {
          stage: "validator" as const,
          operation: "runAutopilotMonitorPass",
          durationMs: 18,
          requestBytes: 20_000,
          usage: { inputTokens: 220, outputTokens: 30, totalTokens: 250 },
        },
        {
          stage: "memory-consolidation" as const,
          operation: "extractMemoryCandidates",
          durationMs: 10,
          requestBytes: 3_000,
          usage: { inputTokens: 140, outputTokens: 20, totalTokens: 160 },
        },
      ];

      const result = await runWithTaskModelUsageRecording(async () => {
        for (const stage of stages) {
          await observeAgentModelCall(
            {
              stage: stage.stage,
              provider: "openai",
              model: "gpt-5.4",
              operation: stage.operation,
              requestBytes: stage.requestBytes,
            },
            async (onRequestAttempt) => {
              if (stage.retry) {
                onRequestAttempt?.({
                  provider: "openai",
                  operation: stage.operation,
                  attempt: 1,
                  elapsedMs: 8,
                  ok: false,
                  errorName: "RateLimitError",
                });
              }
              onRequestAttempt?.({
                provider: "openai",
                operation: stage.operation,
                attempt: stage.retry ? 2 : 1,
                elapsedMs: stage.durationMs,
                ok: true,
              });
              await vi.advanceTimersByTimeAsync(stage.durationMs);
              return { text: "done", toolCalls: [], usage: stage.usage };
            },
          );
        }

        return createResult();
      });
      const report = result.metadata?.modelUsage as TaskModelUsageReport;

      expect(report.totals).toMatchObject({
        callCount: 4,
        modelCallCount: 4,
        providerRequestCount: 5,
        apiCallCount: 4,
        auxiliaryCallCount: 3,
        retryCount: 1,
        failedRequestCount: 1,
        usageReportedCallCount: 4,
        usageUnavailableCallCount: 0,
        inputTokens: 1_480,
        outputTokens: 185,
        totalTokens: 1_665,
        cacheReadInputTokens: 600,
        requestBytes: 123_400,
        aggregateCallDurationMs: 80,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("aggregates API stages, retry attempts, payloads, and provider usage", async () => {
    const result = await runWithTaskModelUsageRecording(async () => {
      await observeAgentModelCall(
        {
          stage: "executor",
          provider: "openai",
          model: "gpt-5.4",
          operation: "startExecutorCycle",
          requestPayload: { prompt: "hello" },
          toolDefinitions: [
            {
              name: "read_file",
              description: "Read a file",
              inputSchema: { type: "object" },
            },
          ],
        },
        async (onRequestAttempt) => {
          onRequestAttempt?.({
            provider: "openai",
            operation: "startTurn",
            attempt: 1,
            elapsedMs: 10,
            ok: false,
            errorName: "RateLimitError",
          });
          onRequestAttempt?.({
            provider: "openai",
            operation: "startTurn",
            attempt: 2,
            elapsedMs: 20,
            ok: true,
          });
          return {
            text: "done",
            toolCalls: [],
            usage: {
              inputTokens: 100,
              outputTokens: 25,
              totalTokens: 125,
              cachedInputTokens: 60,
              cacheReadInputTokens: 60,
              cacheWriteInputTokens: 10,
              toolUseInputTokens: 8,
              reasoningTokens: 5,
            },
          };
        },
      );
      return createResult();
    });
    const report = result.metadata?.modelUsage as TaskModelUsageReport;

    expect(report.calls).toHaveLength(1);
    expect(report.calls[0]).toMatchObject({
      stage: "executor",
      retryCount: 1,
      retryCountReported: true,
      usageReported: true,
    });
    expect(report.totals).toMatchObject({
      callCount: 1,
      modelCallCount: 1,
      providerRequestCount: 2,
      retryCount: 1,
      failedRequestCount: 1,
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 125,
      cacheReadInputTokens: 60,
      cacheWriteInputTokens: 10,
      toolUseInputTokens: 8,
      reasoningTokens: 5,
      usageUnavailableCallCount: 0,
    });
    expect(report.totals.requestBytes).toBeGreaterThan(0);
    expect(report.totals.toolDefinitionBytes).toBeGreaterThan(0);
  });

  it("marks missing CLI telemetry as unavailable instead of zero", async () => {
    const result = await runWithTaskModelUsageRecording(async () => {
      recordExternalAgentModelCall({
        stage: "external-agent",
        provider: "copilot-cli",
        model: "auto",
        executionPath: "cli",
        operation: "executeExternalAgentCli",
        status: "completed",
        durationMs: 50,
        requestBytes: 1_000,
        responseBytes: 100,
        modelCallCountReported: false,
        retryCountReported: false,
      });
      return createResult();
    });
    const report = result.metadata?.modelUsage as TaskModelUsageReport;

    expect(report.calls[0]).toMatchObject({
      executionPath: "cli",
      usageReported: false,
      modelCallCountReported: false,
      providerRequestCountReported: false,
      retryCountReported: false,
    });
    expect(report.totals).toMatchObject({
      cliCallCount: 1,
      usageUnavailableCallCount: 1,
      modelCallTelemetryUnavailableCallCount: 1,
      providerRequestTelemetryUnavailableCallCount: 1,
      retryTelemetryUnavailableCallCount: 1,
      requestBytes: 1_000,
      responseBytes: 100,
    });
  });

  it("counts each internal CLI inference and its reported retries", async () => {
    const result = await runWithTaskModelUsageRecording(async () => {
      recordExternalAgentModelCall({
        stage: "external-agent",
        provider: "claude-cli",
        model: "sonnet",
        executionPath: "cli",
        operation: "executeExternalAgentCli",
        status: "completed",
        durationMs: 50,
        requestBytes: 1_000,
        responseBytes: 100,
        modelCallCount: 4,
        retryCount: 2,
        retryCountReported: true,
        usage: { inputTokens: 500, outputTokens: 60, totalTokens: 560 },
      });
      return createResult();
    });
    const report = result.metadata?.modelUsage as TaskModelUsageReport;

    expect(report.calls[0]).toMatchObject({
      modelCallCount: 4,
      providerRequestCount: 6,
      modelCallCountReported: true,
      providerRequestCountReported: true,
      retryCount: 2,
    });
    expect(report.totals).toMatchObject({
      modelCallCount: 4,
      providerRequestCount: 6,
      retryCount: 2,
    });
  });

  it("marks retry telemetry unavailable when an injected adapter does not report attempts", async () => {
    const result = await runWithTaskModelUsageRecording(async () => {
      await observeAgentModelCall(
        {
          stage: "conversation-summary",
          provider: "google",
          model: "gemini-2.5-pro",
          operation: "summarizeConversationHistory",
          requestBytes: 100,
        },
        async () => ({
          text: "summary",
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        }),
      );
      return createResult();
    });
    const report = result.metadata?.modelUsage as TaskModelUsageReport;

    expect(report.calls[0]).toMatchObject({
      stage: "conversation-summary",
      retryCountReported: false,
    });
    expect(report.totals).toMatchObject({
      providerRequestCount: 1,
      providerRequestTelemetryUnavailableCallCount: 1,
      retryTelemetryUnavailableCallCount: 1,
      auxiliaryCallCount: 1,
    });
  });

  it("reports an auxiliary call that is still settling when task completion is recorded", async () => {
    let finishCall: (() => void) | undefined;
    let pendingCall: Promise<unknown> | undefined;

    const result = await runWithTaskModelUsageRecording(async () => {
      pendingCall = observeAgentModelCall(
        {
          stage: "memory-consolidation",
          provider: "openai",
          model: "gpt-5.4",
          operation: "extractMemoryCandidates",
          requestBytes: 100,
        },
        async () =>
          await new Promise((resolve) => {
            finishCall = () => resolve({ text: "late", toolCalls: [] });
          }),
      );
      await Promise.resolve();
      return createResult();
    });
    const report = result.metadata?.modelUsage as TaskModelUsageReport;

    expect(report.calls[0]).toMatchObject({
      stage: "memory-consolidation",
      status: "failed",
      usageReported: false,
      retryCountReported: false,
    });
    expect(report.totals).toMatchObject({
      callCount: 1,
      failedCallCount: 1,
      usageUnavailableCallCount: 1,
      retryTelemetryUnavailableCallCount: 1,
    });

    finishCall?.();
    await pendingCall;
    expect(report.calls).toHaveLength(1);
  });
});
