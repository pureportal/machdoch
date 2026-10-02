import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeConfig } from "../__test__/ralph-test-helpers.js";
import type {
  AgentToolDefinition,
  AgentToolExecutionResult,
} from "../_helpers/agent-tools-shared.js";
import { createLocalToolRuntime } from "./runtime.js";

const toolResult: AgentToolExecutionResult = {
  toolResult: { callId: "", name: "fixture_wait", output: "Finished" },
  sections: [],
  traceLines: [],
};

const createRuntime = (execute: AgentToolDefinition["execute"]) => {
  const controller = new AbortController();
  const onResult = vi.fn();
  const onToolResult = vi.fn();
  const onActionOutput = vi.fn();
  const runtime = createLocalToolRuntime({
    config: runtimeConfig,
    memory: {
      sessionEnabled: false,
      sessionEntries: [],
      globalEnabled: false,
      globalEntries: [],
    },
    signal: controller.signal,
    onResult,
    onToolResult,
    onActionOutput,
    scopedToolDefinitions: [
      {
        spec: {
          name: "fixture_wait",
          description: "Wait",
          inputSchema: { type: "object", additionalProperties: false },
        },
        backingTool: "utilities",
        effect: "read",
        riskLevel: "low",
        execute,
      },
    ],
  });
  return { runtime, controller, onResult, onToolResult, onActionOutput };
};

afterEach(() => vi.useRealTimers());

describe("local MCP tool shutdown", () => {
  it("drains a cooperative tool after cancellation", async () => {
    const { runtime, controller, onResult } = createRuntime(
      async (_args, context) =>
        new Promise((_resolve, reject) => {
          context.signal!.addEventListener(
            "abort",
            () => reject(context.signal!.reason),
            { once: true },
          );
        }),
    );
    const call = runtime.call("fixture_wait", {});
    const rejection = expect(call).rejects.toThrow();
    controller.abort();
    await runtime.waitForIdle();
    await rejection;
    expect(onResult).not.toHaveBeenCalled();
  });

  it("finishes shutdown when a cancelled tool does not settle", async () => {
    vi.useFakeTimers();
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    let release!: (result: AgentToolExecutionResult) => void;
    const { runtime, controller, onResult, onToolResult, onActionOutput } =
      createRuntime(async (_args, context) => {
        const result = await new Promise<AgentToolExecutionResult>(
          (resolve) => (release = resolve),
        );
        context.onOutput?.({ stream: "stdout", chunk: "Late output" });
        return result;
      });
    const call = runtime.call("fixture_wait", {});
    const settledCall = call.catch(() => undefined);
    try {
      controller.abort();
      let closed = false;
      const closing = runtime.waitForIdle().then(() => (closed = true));
      await vi.advanceTimersByTimeAsync(4_999);
      expect(closed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(closed).toBe(true);
      await closing;
      expect(diagnostic).toHaveBeenCalledWith(
        "Machdoch MCP shutdown timed out waiting for 1 tool call(s).",
      );
      release(toolResult);
      await settledCall;
      expect(onResult).not.toHaveBeenCalled();
      expect(onToolResult).not.toHaveBeenCalled();
      expect(onActionOutput).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      release(toolResult);
      await settledCall;
    }
  });

  it("keeps completed tool results and clears the shutdown timer", async () => {
    vi.useFakeTimers();
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    const { runtime, onResult, onToolResult } = createRuntime(
      async () => toolResult,
    );
    const call = runtime.call("fixture_wait", {});
    await runtime.waitForIdle();
    await expect(call).resolves.toMatchObject({
      toolResult: { output: "Finished" },
    });
    expect(onResult).toHaveBeenCalledOnce();
    expect(onToolResult).toHaveBeenCalledOnce();
    expect(diagnostic).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
