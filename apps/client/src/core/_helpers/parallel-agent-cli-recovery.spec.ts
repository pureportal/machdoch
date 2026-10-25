import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createParallelAgentTestOptions,
  executeParallelWorkers as execute,
  parallelWorker as worker,
} from "../__test__/parallel-agent-test-helpers.js";
import { createInstructionResolutionFixture } from "../__test__/instruction-test-helpers.js";
import { createInstructionDeliveryPlan } from "../instruction-system/index.js";
import { createLocalToolRuntime } from "../local-mcp/runtime.js";
import { maybeExecuteModelDrivenTask } from "../agent-runtime.js";
import type { TaskExecutionResult } from "../types.js";
import { maybeExecuteExternalAgentProviderTask } from "./external-agent-provider.js";
import {
  createParallelAgentSessionTool,
  type ParallelAgentSessionOptions,
} from "./parallel-agent-sessions.js";

vi.mock("./external-agent-provider.js", () => ({
  maybeExecuteExternalAgentProviderTask: vi.fn(),
}));

type Params = Parameters<typeof maybeExecuteExternalAgentProviderTask>[0];
const providers = ["codex-cli", "claude-cli", "copilot-cli"] as const;
const workspaces: string[] = [];
afterEach(async () => {
  vi.mocked(maybeExecuteExternalAgentProviderTask).mockReset();
  await Promise.all(
    workspaces
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const createOptions = async (
  provider: (typeof providers)[number],
): Promise<ParallelAgentSessionOptions> => {
  const options = await createParallelAgentTestOptions("machdoch");
  workspaces.push(options.config.workspaceRoot);
  const instructionResolution = createInstructionResolutionFixture({
    providerId: provider,
    surface: "cli",
    model: "test-model",
  });
  return {
    ...options,
    config: {
      ...options.config,
      provider,
      providerAvailability: [{ provider, configured: true }],
    },
    taskContext: { ...options.taskContext, instructionResolution },
    instructionDeliveryPlan: createInstructionDeliveryPlan(
      instructionResolution,
    ),
    preparedConversationContext: {
      wasQueued: false,
      workspace: { selection: "selected", root: options.config.workspaceRoot },
      sections: [],
      memory: {
        sessionEnabled: false,
        sessionEntries: [],
        globalEnabled: false,
        globalEntries: [],
      },
      uiControlEnabled: false,
    },
  };
};

const runtimeFor = (params: Params) =>
  createLocalToolRuntime({
    config: params.config,
    memory: params.preparedConversationContext.memory,
    scopedToolDefinitions: params.scopedWorkerToolDefinitions!,
    signal: params.signal!,
    onToolCall: params.onScopedWorkerToolCall!,
    onToolResult: params.onScopedWorkerToolResult!,
  });

const completed = (params: Params): TaskExecutionResult => ({
  task: params.task,
  mode: params.config.mode,
  status: "executed",
  summary: "Verified result",
  executedTools: [],
  outputSections: [],
});

it.each(providers)(
  "%s recovers rejected arguments and failed edits with accurate counts",
  async (provider) => {
    const options = await createOptions(provider);
    await writeFile(join(options.config.workspaceRoot, "notes.txt"), "Notes");
    vi.mocked(maybeExecuteExternalAgentProviderTask).mockImplementation(
      async (params) => {
        const runtime = runtimeFor(params);
        if (params.config.mode === "ask") {
          expect(
            (
              await runtime.call("read_file", {
                path: "notes.txt",
                startLine: 0,
                endLine: 1,
              })
            ).toolResult.isError,
          ).toBe(true);
          expect(
            (
              await runtime.call("read_file", {
                path: "notes.txt",
                startLine: 1,
                endLine: 1,
              })
            ).toolResult.isError,
          ).toBeFalsy();
        } else {
          expect(
            (
              await runtime.call("replace_in_file", {
                path: "report.txt",
                oldText: "missing",
                newText: "updated",
                replaceAll: false,
              })
            ).toolResult.isError,
          ).toBe(true);
          expect(
            (
              await runtime.call("create_file", {
                path: "report.txt",
                content: "Report",
              })
            ).toolResult.isError,
          ).toBeFalsy();
        }
        return completed(params);
      },
    );
    const tool = createParallelAgentSessionTool(options);
    const result = await execute(tool, [
      worker("reader", { readPaths: ["notes.txt"] }),
      worker("writer", { access: "write", writePaths: ["report.txt"] }),
    ]);
    expect(result.toolResult.isError, result.toolResult.output).toBe(false);
    expect(tool.hasWorkerFailure()).toBe(false);
    expect(JSON.parse(result.toolResult.output)).toMatchObject([
      {
        id: "reader",
        status: "completed",
        toolCalls: 2,
        toolErrors: [{ name: "read_file" }],
      },
      {
        id: "writer",
        status: "completed",
        toolCalls: 2,
        toolErrors: [{ name: "replace_in_file" }],
      },
    ]);
  },
);

it.each(providers)(
  "%s stops at the tool limit even when the provider keeps running",
  async (provider) => {
    const options = await createOptions(provider);
    vi.mocked(maybeExecuteExternalAgentProviderTask).mockImplementation(
      async (params) => {
        const runtime = runtimeFor(params);
        for (let index = 0; index < 25; index += 1) {
          await runtime
            .call("list_directory", { path: ".", maxEntries: 100 })
            .catch(() => undefined);
        }
        return await new Promise<never>(() => undefined);
      },
    );
    const tool = createParallelAgentSessionTool(options);
    const result = await execute(tool, [worker("first"), worker("second")]);
    expect(result.toolResult.isError).toBe(true);
    for (const entry of JSON.parse(result.toolResult.output)) {
      expect(entry).toMatchObject({
        status: "failed",
        toolCalls: 24,
        error: expect.stringContaining("tool limit"),
      });
      expect(entry.toolErrors).toHaveLength(24);
    }
  },
);

it.each(providers)(
  "%s preserves tool evidence and the answer when the provider reports failure",
  async (provider) => {
    const options = await createOptions(provider);
    vi.mocked(maybeExecuteExternalAgentProviderTask).mockImplementation(
      async (params) => {
        await runtimeFor(params).call("list_directory", {
          path: ".",
          maxEntries: 60,
        });
        return {
          ...completed(params),
          status: "failed",
          summary: "Partial finding",
          reason: "Provider exited with code 1",
        };
      },
    );
    const result = await execute(createParallelAgentSessionTool(options), [
      worker("first"),
      worker("second"),
    ]);
    expect(result.toolResult.isError).toBe(true);
    for (const entry of JSON.parse(result.toolResult.output)) {
      expect(entry).toMatchObject({
        status: "failed",
        answer: "Partial finding",
        toolCalls: 1,
        error: "Provider exited with code 1",
      });
    }
  },
);

it.each(
  providers.flatMap((provider) =>
    [false, true].flatMap((retry) =>
      (["executed", "blocked", "failed", "scope-violation"] as const).map(
        (parentStatus) => ({ provider, retry, parentStatus }),
      ),
    ),
  ),
)(
  "$provider preserves the parent's $parentStatus outcome after worker failures (retry: $retry)",
  async ({ provider, retry, parentStatus }) => {
    const options = await createOptions(provider);
    let failWorkers = true;
    vi.mocked(maybeExecuteExternalAgentProviderTask).mockImplementation(
      async (params) => {
        if (params.scopedWorkerToolDefinitions !== undefined) {
          if (failWorkers && parentStatus === "scope-violation") {
            await runtimeFor(params).call("read_file", {
              path: "outside.txt",
              startLine: 1,
              endLine: 1,
            });
          }
          return failWorkers
            ? {
                ...completed(params),
                status: "failed",
                reason: "Temporary provider failure",
              }
            : completed(params);
        }
        const parallel = params.additionalToolDefinitions?.find(
          (definition) => definition.spec.name === "run_parallel_agents",
        );
        expect(parallel).toBeDefined();
        const plan = {
          workers: [
            worker("first", { readPaths: ["first.txt"] }),
            worker("second", { readPaths: ["second.txt"] }),
          ],
        };
        const context = {
          workspaceRoot: options.config.workspaceRoot,
          memory: params.preparedConversationContext.memory,
        };
        expect(
          (await parallel!.execute(plan, context)).toolResult.isError,
        ).toBe(true);
        if (retry) {
          failWorkers = false;
          expect(
            (await parallel!.execute(plan, context)).toolResult.isError,
          ).toBe(false);
        }
        return {
          ...completed(params),
          status:
            parentStatus === "scope-violation" ? "executed" : parentStatus,
          ...(parentStatus === "executed"
            ? {}
            : { reason: "Required work remains incomplete" }),
          response: {
            markdown: "Verified result",
            highlights: [],
            relatedFiles: [],
            verification: [],
            followUps: [],
          },
        };
      },
    );
    const result = await maybeExecuteModelDrivenTask({
      task: options.task,
      config: options.config,
      taskContext: options.taskContext,
      contextSections: [],
      instructionDeliveryPlan: options.instructionDeliveryPlan!,
      conversationContext: { history: [], parallelAgentMode: "machdoch" },
    });
    expect(result?.status, result?.summary).toBe(
      parentStatus === "scope-violation" ? "failed" : parentStatus,
    );
    if (parentStatus === "scope-violation") {
      expect(result?.reason).toContain("violated its declared file scope");
      expect(result?.metadata?.parallelWorkerFailure).toBe(true);
      return;
    }
    expect(result?.metadata?.parallelWorkerFailure).toBe(!retry);
    expect(result?.summary).toBe("Verified result");
    expect(result?.response?.markdown).toBe("Verified result");
    if (parentStatus !== "executed")
      expect(result?.reason).toBe("Required work remains incomplete");
  },
);
