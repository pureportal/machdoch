import { describe, expect, it, vi } from "vitest";
import { loadRuntimeConfig } from "../config.js";
import { runExternalAgentCommand } from "./external-agent-provider.js";

describe("native Codex goal process streaming", () => {
  it.each(["completed", "failed"])(
    "preserves %s results through large real stdout frames",
    async (status) => {
      const source = String.raw`
      import { createInterface } from "node:readline";
      import { once } from "node:events";
      const send = async (event) => {
        const line = JSON.stringify(event) + "\n";
        for (let offset = 0; offset < line.length; offset += 32767) {
          if (!process.stdout.write(line.slice(offset, offset + 32767)))
            await once(process.stdout, "drain");
        }
      };
      for await (const line of createInterface({ input: process.stdin })) {
        const request = JSON.parse(line);
        if (request.method === "initialize") await send({ id: request.id, result: {} });
        if (request.method === "thread/start") await send({ id: request.id, result: { thread: { id: "thread-1" } } });
        if (request.method === "turn/start") await send({ id: request.id, result: { turn: { id: "turn-1" } } });
        if (request.method !== "thread/goal/set") continue;
        await send({ id: request.id, result: { goal: { status: request.params.status } } });
        if (request.params.status !== "active") continue;
        await send({ method: "item/completed", params: { threadId: "thread-1", item: { id: "test-1", type: "commandExecution", aggregatedOutput: "x".repeat(3000000) + "All tests passed.", exitCode: 0 } } });
        await send({ method: "thread/tokenUsage/updated", params: { threadId: "thread-1", tokenUsage: { total: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 10, reasoningOutputTokens: 5 } } } });
        await send({ method: "item/completed", params: { threadId: "thread-1", item: { id: "answer", type: "agentMessage", text: "Work is saved and verified." } } });
        await send({ method: "thread/goal/updated", params: { threadId: "thread-1", goal: { status: "complete" } } });
        await send({ method: "turn/completed", params: { turn: { items: Array.from({ length: 1500 }, () => ({ text: "x".repeat(2000) })), status: process.argv[1], error: { message: "Goal verification failed." }, id: "turn-1" }, threadId: "thread-1" } });
        process.stdout.write("invalid late data\n");
      }
    `;
      const config = await loadRuntimeConfig(process.cwd());
      const onOutput = vi.fn();
      const result = await runExternalAgentCommand(
        process.execPath,
        ["--input-type=module", "-e", source, status],
        undefined,
        config,
        "codex-cli",
        {},
        undefined,
        onOutput,
        true,
        {
          objective: "Verify the work",
          prompt: "Verify the work",
          imagePaths: [],
        },
      );
      expect(result).toMatchObject({
        exitCode: status === "completed" ? 0 : 1,
        stdout: "Work is saved and verified.",
        modelCallCount: 1,
        toolCallCount: 1,
        toolEvidence: expect.stringContaining("All tests passed."),
        usage: { totalTokens: 120, cachedInputTokens: 10 },
      });
      expect(result.failureMessage).toBe(
        status === "failed" ? "Goal verification failed." : undefined,
      );
      expect(result.stdoutBytes).toBeGreaterThan(6_000_000);
      expect(result.toolEvidence!.length).toBeLessThanOrEqual(32_000);
      expect(onOutput).toHaveBeenCalled();
      expect(result.providerShutdownRecovery).toBeUndefined();
    },
  );
});
