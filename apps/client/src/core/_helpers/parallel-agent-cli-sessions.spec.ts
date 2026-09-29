import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createInstructionResolutionFixture } from "../__test__/instruction-test-helpers.js";
import { createInstructionDeliveryPlan } from "../instruction-system/index.js";
import type { RuntimeConfig } from "../runtime-contract.generated.js";
import type { TaskExecutionResult } from "../types.js";
import { maybeExecuteExternalAgentProviderTask } from "./external-agent-provider.js";
import { createParallelAgentSessionTool } from "./parallel-agent-sessions.js";

vi.mock("./external-agent-provider.js", () => ({
  maybeExecuteExternalAgentProviderTask: vi.fn(),
}));

let workspaceRoot: string | undefined;

afterEach(async () => {
  vi.mocked(maybeExecuteExternalAgentProviderTask).mockReset();
  if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
  workspaceRoot = undefined;
});

it.each(["codex-cli", "claude-cli", "copilot-cli"] as const)(
  "spawns scoped Machdoch workers through %s",
  async (provider) => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "machdoch-cli-workers-"));
    const model = provider === "claude-cli" ? "claude-opus-4-6" : "gpt-6-sol";
    const config = {
      workspaceRoot,
      mode: "machdoch",
      provider,
      model,
      reasoning: "default",
      contextWindow: "default",
      offline: false,
      compatibility: { discoverGithubCustomizations: false },
      providerAvailability: [{ provider, configured: true }],
      webSearch: { activeProvider: "none", providerAvailability: [] },
      reviewModel: { mode: "base" },
      internalTaskModel: { provider, model, reasoning: "default" },
    } satisfies RuntimeConfig;
    const instructionResolution = createInstructionResolutionFixture({
      providerId: provider,
      surface: "cli",
      model,
    });
    vi.mocked(maybeExecuteExternalAgentProviderTask).mockImplementation(
      async (params) => {
        if (params.config.mode === "machdoch") {
          const createFile = params.scopedWorkerToolDefinitions?.find(
            (tool) => tool.spec.name === "create_file",
          );
          const result = await createFile?.execute(
            { path: "report.txt", content: "Worker report" },
            {
              workspaceRoot: workspaceRoot!,
              memory: {
                sessionEnabled: false,
                sessionEntries: [],
                globalEnabled: false,
                globalEntries: [],
              },
            },
          );
          expect(result?.toolResult.isError).toBeFalsy();
        }
        return {
          task: params.task,
          mode: params.config.mode,
          status: "executed",
          summary: "Worker completed.",
          executedTools: [],
          outputSections: [],
        } satisfies TaskExecutionResult;
      },
    );
    const tool = createParallelAgentSessionTool({
      config,
      task: "Inspect the workspace",
      taskContext: {
        task: "Inspect the workspace",
        effectiveTask: "Inspect the workspace",
        taskContextText: "",
        workspacePaths: [],
        suggestedTools: [],
        executionRole: "executor",
        applicableInstructions: [],
        instructionResolution,
      },
      instructionDeliveryPlan: createInstructionDeliveryPlan(
        instructionResolution,
      ),
      preparedConversationContext: {
        wasQueued: false,
        workspace: { selection: "selected", root: workspaceRoot },
        sections: [],
        memory: {
          sessionEnabled: false,
          sessionEntries: [],
          globalEnabled: false,
          globalEntries: [],
        },
        uiControlEnabled: false,
      },
      mode: "machdoch",
    });

    const plan = {
      workers: [
        {
          id: "reader",
          objective: "Read notes",
          access: "read-only",
          readPaths: ["notes.txt"],
          writePaths: [],
        },
        {
          id: "writer",
          objective: "Write report",
          access: "write",
          readPaths: [],
          writePaths: ["report.txt"],
        },
      ],
    };
    const context = {
      workspaceRoot,
      memory: {
        sessionEnabled: false,
        sessionEntries: [],
        globalEnabled: false,
        globalEntries: [],
      },
    };
    const outcome = await tool.definition.execute(plan, context);

    expect(outcome.toolResult.isError, outcome.toolResult.output).toBe(false);
    const calls = vi.mocked(maybeExecuteExternalAgentProviderTask).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls.map(([params]) => params.config.mode)).toEqual([
      "ask",
      "machdoch",
    ]);
    expect(
      calls.map(
        ([params]) => params.preparedConversationContext.parallelAgentMode,
      ),
    ).toEqual(["disabled", "disabled"]);
    expect(
      calls.map(([params]) =>
        params.scopedWorkerToolDefinitions?.map((tool) => tool.spec.name),
      ),
    ).toEqual([["read_file"], ["read_file", "create_file", "replace_in_file"]]);
    expect(JSON.parse(outcome.toolResult.output)).toEqual([
      expect.objectContaining({
        id: "reader",
        status: "completed",
        toolCalls: 0,
      }),
      expect.objectContaining({
        id: "writer",
        status: "completed",
        toolCalls: 1,
      }),
    ]);

    vi.mocked(maybeExecuteExternalAgentProviderTask).mockImplementation(
      async (params) => {
        if (params.config.mode === "machdoch") {
          const createFile = params.scopedWorkerToolDefinitions?.find(
            (tool) => tool.spec.name === "create_file",
          );
          const failed = await createFile?.execute(
            { path: "report.txt", content: "Overwritten" },
            {
              workspaceRoot: workspaceRoot!,
              memory: {
                sessionEnabled: false,
                sessionEntries: [],
                globalEnabled: false,
                globalEntries: [],
              },
            },
          );
          expect(failed?.toolResult.isError).toBe(true);
        }
        return {
          task: params.task,
          mode: params.config.mode,
          status: "executed",
          summary: "Worker completed.",
          executedTools: [],
          outputSections: [],
        } satisfies TaskExecutionResult;
      },
    );
    const failedEdit = await tool.definition.execute(plan, context);
    expect(failedEdit.toolResult.isError).toBe(true);
    expect(JSON.parse(failedEdit.toolResult.output)).toEqual([
      expect.objectContaining({ id: "reader", status: "completed" }),
      expect.objectContaining({
        id: "writer",
        status: "failed",
        answer: expect.stringContaining("failed tool call"),
      }),
    ]);

    vi.mocked(maybeExecuteExternalAgentProviderTask).mockImplementation(
      async (params) =>
        ({
          task: params.task,
          mode: params.config.mode,
          status: "executed",
          summary: "Worker completed without calling a tool.",
          executedTools: [],
          outputSections: [],
        }) satisfies TaskExecutionResult,
    );
    const missingEdit = await tool.definition.execute(plan, context);
    expect(missingEdit.toolResult.isError).toBe(true);
    expect(JSON.parse(missingEdit.toolResult.output)).toEqual([
      expect.objectContaining({ id: "reader", status: "completed" }),
      expect.objectContaining({
        id: "writer",
        status: "failed",
        answer: expect.stringContaining("did not complete a scoped file edit"),
      }),
    ]);

    vi.mocked(maybeExecuteExternalAgentProviderTask).mockImplementation(
      async (params) => {
        if (params.config.mode === "ask") {
          params.onScopedWorkerToolResult?.("read_file", {
            toolResult: {
              callId: "invalid-read",
              name: "read_file",
              isError: true,
              output: "Invalid tool arguments.",
            },
            sections: [],
            traceLines: [],
          });
        } else {
          const replaceFile = params.scopedWorkerToolDefinitions?.find(
            (entry) => entry.spec.name === "replace_in_file",
          );
          const edited = await replaceFile?.execute(
            {
              path: "report.txt",
              oldText: "Worker report",
              newText: "Updated report",
              replaceAll: false,
            },
            { ...context, workspaceRoot: workspaceRoot! },
          );
          expect(edited?.toolResult.isError).toBeFalsy();
        }
        return {
          task: params.task,
          mode: params.config.mode,
          status: "executed",
          summary: "Worker completed.",
          executedTools: [],
          outputSections: [],
        } satisfies TaskExecutionResult;
      },
    );
    const invalidRead = await tool.definition.execute(plan, context);
    expect(invalidRead.toolResult.isError).toBe(true);
    expect(JSON.parse(invalidRead.toolResult.output)).toEqual([
      expect.objectContaining({
        id: "reader",
        status: "failed",
        answer: expect.stringContaining("Invalid tool arguments"),
      }),
      expect.objectContaining({ id: "writer", status: "completed" }),
    ]);

    let writerReady!: () => void;
    const writerStarted = new Promise<void>((resolve) => {
      writerReady = resolve;
    });
    let writerCancelled = false;
    vi.mocked(maybeExecuteExternalAgentProviderTask).mockImplementation(
      async (params) => {
        if (params.config.mode === "machdoch") {
          writerReady();
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error("Not cancelled")),
              1_000,
            );
            params.signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timeout);
                writerCancelled = true;
                resolve();
              },
              { once: true },
            );
          });
        } else {
          await writerStarted;
          const readFile = params.scopedWorkerToolDefinitions?.find(
            (entry) => entry.spec.name === "read_file",
          );
          await expect(
            readFile?.execute(
              { path: "report.txt", startLine: 1, endLine: 1 },
              { ...context, workspaceRoot: workspaceRoot! },
            ),
          ).rejects.toThrow("unclaimed path");
        }
        return {
          task: params.task,
          mode: params.config.mode,
          status: "executed",
          summary: "Worker completed.",
          executedTools: [],
          outputSections: [],
        } satisfies TaskExecutionResult;
      },
    );
    const scopeViolation = await tool.definition.execute(plan, context);
    expect(scopeViolation.toolResult.isError).toBe(true);
    expect(writerCancelled).toBe(true);
    expect(JSON.parse(scopeViolation.toolResult.output)).toEqual([
      expect.objectContaining({ id: "reader", status: "failed" }),
      expect.objectContaining({ id: "writer", status: "failed" }),
    ]);
  },
);
