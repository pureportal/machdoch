import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createParallelAgentTestOptions,
  executeParallelWorkers as execute,
  parallelWorker as worker,
} from "../__test__/parallel-agent-test-helpers.js";
import type {
  AgentModelAdapter,
  AgentModelToolCall,
} from "@machdoch/model-runtime/types";
import { createParallelAgentSessionTool } from "./parallel-agent-sessions.js";

const workspaces: string[] = [];
afterEach(async () => {
  await Promise.all(
    workspaces
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
const createOptions = async () => {
  const options = await createParallelAgentTestOptions();
  workspaces.push(options.config.workspaceRoot);
  return options;
};

it.each([
  {
    name: "list_directory",
    invalid: { path: ".", maxEntries: 61 },
    valid: { path: ".", maxEntries: 60 },
  },
  {
    name: "search_workspace",
    invalid: { query: "notes", isRegex: false, maxResults: 26 },
    valid: { query: "notes", isRegex: false, maxResults: 25 },
  },
])(
  "allows correction of rejected $name arguments and preserves the error",
  async ({ name, invalid, valid }) => {
    const options = await createOptions();
    await writeFile(join(options.config.workspaceRoot, "notes.txt"), "notes");
    const tool = createParallelAgentSessionTool({
      ...options,
      createWorkerAdapter: async (): Promise<AgentModelAdapter> => {
        let pass = 0;
        return {
          startTurn: async () => ({
            text: "",
            toolCalls: [{ id: "bad", name, arguments: invalid }],
          }),
          continueTurn: async ({ toolResults }) => {
            pass += 1;
            expect(Boolean(toolResults[0]?.isError)).toBe(pass === 1);
            return pass === 1
              ? {
                  text: "",
                  toolCalls: [{ id: "fixed", name, arguments: valid }],
                }
              : { text: "Verified notes", toolCalls: [] };
          },
        };
      },
    });
    const result = await execute(tool, [worker("first"), worker("second")]);
    expect(result.toolResult.isError).toBe(false);
    expect(tool.hasWorkerFailure()).toBe(false);
    for (const entry of JSON.parse(result.toolResult.output)) {
      expect(entry).toMatchObject({
        status: "completed",
        toolCalls: 2,
        answer: "Verified notes",
        toolErrors: [{ name, output: expect.stringContaining("must be <=") }],
      });
    }
  },
);

it("retains partial findings and tool counts after a continuation fails", async () => {
  const options = await createOptions();
  const tool = createParallelAgentSessionTool({
    ...options,
    createWorkerAdapter: async () => ({
      startTurn: async () => ({
        text: "Partial finding",
        toolCalls: [
          {
            id: "list",
            name: "list_directory",
            arguments: { path: ".", maxEntries: 60 },
          },
        ],
      }),
      continueTurn: async () => {
        throw new Error("Connection lost");
      },
    }),
  });
  const result = await execute(tool, [worker("first"), worker("second")]);
  expect(result.toolResult.isError).toBe(true);
  expect(JSON.parse(result.toolResult.output)).toMatchObject([
    {
      status: "failed",
      answer: "Partial finding",
      toolCalls: 1,
      error: "Connection lost",
    },
    {
      status: "failed",
      answer: "Partial finding",
      toolCalls: 1,
      error: "Connection lost",
    },
  ]);
});

it("requires a final answer after tool calls instead of reusing interim narration", async () => {
  const options = await createOptions();
  const tool = createParallelAgentSessionTool({
    ...options,
    createWorkerAdapter: async () => ({
      startTurn: async () => ({
        text: "Checking",
        toolCalls: [
          {
            id: "list",
            name: "list_directory",
            arguments: { path: ".", maxEntries: 60 },
          },
        ],
      }),
      continueTurn: async () => ({ text: " ", toolCalls: [] }),
    }),
  });
  const result = await execute(tool, [worker("first"), worker("second")]);
  expect(result.toolResult.isError).toBe(true);
  expect(JSON.parse(result.toolResult.output)[0]).toMatchObject({
    answer: "Checking",
    error: "Worker first returned no result.",
    toolCalls: 1,
  });
});

it("clears a failed objective only after the same plan successfully reruns", async () => {
  const options = await createOptions();
  let fail = true;
  const tool = createParallelAgentSessionTool({
    ...options,
    createWorkerAdapter: async () => ({
      startTurn: async ({ userPrompt }) => {
        if (fail && userPrompt.includes("Inspect first"))
          throw new Error("Provider unavailable");
        return { text: "Finding", toolCalls: [] };
      },
      continueTurn: async () => ({ text: "", toolCalls: [] }),
    }),
  });
  await execute(tool, [worker("first"), worker("second")]);
  expect(tool.hasWorkerFailure()).toBe(true);
  expect(tool.getCompletionBlocker()).toBeUndefined();
  fail = false;
  await execute(tool, [
    worker("first", { objective: "Different objective" }),
    worker("second"),
  ]);
  expect(tool.hasWorkerFailure()).toBe(true);
  await execute(tool, [worker("first"), worker("second")]);
  expect(tool.hasWorkerFailure()).toBe(false);
});

it("counts only attempted calls when a batch exceeds the limit", async () => {
  const options = await createOptions();
  const calls: AgentModelToolCall[] = Array.from(
    { length: 25 },
    (_, index) => ({
      id: String(index),
      name: "list_directory",
      arguments: { path: ".", maxEntries: 0 },
    }),
  );
  const tool = createParallelAgentSessionTool({
    ...options,
    createWorkerAdapter: async () => ({
      startTurn: async () => ({ text: "", toolCalls: calls }),
      continueTurn: async () => ({ text: "Unexpected", toolCalls: [] }),
    }),
  });
  const result = await execute(tool, [worker("first"), worker("second")]);
  expect(result.toolResult.isError).toBe(true);
  for (const entry of JSON.parse(result.toolResult.output)) {
    expect(entry.toolCalls).toBe(24);
    expect(entry.toolErrors).toHaveLength(24);
    expect(entry.error).toContain("tool limit");
  }
});

it("enforces declared read paths even when every worker is read-only", async () => {
  const options = await createOptions();
  await writeFile(join(options.config.workspaceRoot, "outside.txt"), "Secret");
  let continuations = 0;
  const tool = createParallelAgentSessionTool({
    ...options,
    createWorkerAdapter: async () => ({
      startTurn: async () => ({
        text: "",
        toolCalls: [
          {
            id: "read",
            name: "read_file",
            arguments: { path: "outside.txt", startLine: 1, endLine: 1 },
          },
        ],
      }),
      continueTurn: async () => {
        continuations += 1;
        return { text: "Unexpected", toolCalls: [] };
      },
    }),
  });
  const result = await execute(tool, [
    worker("first", { readPaths: ["first.txt"] }),
    worker("second", { readPaths: ["second.txt"] }),
  ]);
  expect(result.toolResult.isError).toBe(true);
  expect(tool.hasWorkerFailure()).toBe(true);
  expect(continuations).toBe(0);
  expect(tool.getCompletionBlocker()).toContain(
    "violated its declared file scope",
  );
  expect(result.toolResult.output).not.toContain("Secret");
});

it("rejects overlapping worker groups without starting extra sessions", async () => {
  const options = await createOptions();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = 0;
  let allStarted!: () => void;
  const ready = new Promise<void>((resolve) => {
    allStarted = resolve;
  });
  const tool = createParallelAgentSessionTool({
    ...options,
    createWorkerAdapter: async () => ({
      startTurn: async () => {
        started += 1;
        if (started === 2) allStarted();
        await held;
        return { text: "Finding", toolCalls: [] };
      },
      continueTurn: async () => ({ text: "", toolCalls: [] }),
    }),
  });
  const first = execute(tool, [worker("first"), worker("second")]);
  try {
    await ready;
    expect(tool.hasWorkerFailure()).toBe(true);
    expect(tool.getCompletionBlocker()).toContain("still running");
    const second = await execute(tool, [worker("first"), worker("second")]);
    expect(second.toolResult.isError).toBe(true);
    expect(second.toolResult.output).toContain("already running");
    expect(started).toBe(2);
  } finally {
    release();
    await first;
  }
  expect(tool.hasWorkerFailure()).toBe(false);
  expect(tool.getCompletionBlocker()).toBeUndefined();
});

it("reports successful writes when a worker fails after modifying its file", async () => {
  const options = await createOptions();
  const tool = createParallelAgentSessionTool({
    ...options,
    mode: "machdoch",
    createWorkerAdapter: async () => {
      let path = "";
      return {
        startTurn: async ({ userPrompt }) => {
          path = userPrompt.includes("Inspect first")
            ? "first.txt"
            : "second.txt";
          return {
            text: `Editing ${path}`,
            toolCalls: [
              {
                id: "write",
                name: "create_file",
                arguments: { path, content: "Written" },
              },
            ],
          };
        },
        continueTurn: async () => {
          if (path === "first.txt") throw new Error("Provider disconnected");
          return { text: "Verified second.txt", toolCalls: [] };
        },
      };
    },
  });
  const result = await execute(tool, [
    worker("first", { access: "write", writePaths: ["first.txt"] }),
    worker("second", { access: "write", writePaths: ["second.txt"] }),
  ]);
  expect(result.toolResult.isError).toBe(true);
  expect(JSON.parse(result.toolResult.output)).toMatchObject([
    {
      id: "first",
      status: "failed",
      toolCalls: 1,
      successfulWrites: 1,
      answer: "Editing first.txt",
      error: "Provider disconnected",
    },
    { id: "second", status: "completed", successfulWrites: 1 },
  ]);
  expect(
    await readFile(join(options.config.workspaceRoot, "first.txt"), "utf8"),
  ).toBe("Written");
});
