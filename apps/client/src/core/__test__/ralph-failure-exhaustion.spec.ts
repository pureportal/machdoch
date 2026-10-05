import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, expect, it, vi } from "vitest";
import { executeTask } from "../execution.js";
import { createRalphRunLogger, runRalphFlow } from "../ralph.js";
import {
  createExecutionResult,
  createFlow,
  customizations,
  runtimeConfig,
} from "./ralph-test-helpers.js";

vi.mock("../execution.js", () => ({ executeTask: vi.fn() }));

describe("RALPH finite failure recovery", () => {
  it("retains invalid structured output and makes a new agent attempt on resume", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-invalid-output-"));
    const config = { ...runtimeConfig, workspaceRoot: workspace };
    const flow = createFlow({
      blocks: [
        { id: "start", type: "START", title: "Start" },
        {
          id: "json",
          type: "UTILITY",
          title: "Research",
          utility: {
            type: "PROMPT_JSON",
            prompt: "Return a proof.",
            maxAttempts: 1,
            schema: {
              type: "object",
              required: ["proof"],
              additionalProperties: false,
              properties: { proof: { type: "string" } },
            },
          },
        },
        { id: "success", type: "END", title: "Success" },
      ],
      edges: [
        { id: "start-json", from: "start", fromOutput: "SUCCESS", to: "json" },
        {
          id: "json-success",
          from: "json",
          fromOutput: "SUCCESS",
          to: "success",
        },
      ],
    });
    const response = (markdown: string) =>
      createExecutionResult({
        response: {
          markdown,
          highlights: [],
          relatedFiles: [],
          verification: [],
          followUps: [],
        },
      });
    vi.mocked(executeTask).mockResolvedValue(
      response('{"error":"Search tool unavailable."}'),
    );
    try {
      const logger = await createRalphRunLogger(workspace, flow, {
        runId: "invalid-output",
      });
      const stopped = await runRalphFlow(flow, config, customizations, {
        logger,
      });
      expect(stopped.status).toBe("blocked");
      expect(stopped.summary).toContain("did not produce schema-valid JSON");
      expect(stopped.events.some((event) => event.type === "crash")).toBe(
        false,
      );
      expect(
        stopped.blockResults.find((block) => block.blockId === "json"),
      ).toMatchObject({
        output: "INVALID",
        data: {
          raw: '{"error":"Search tool unavailable."}',
          validation: { valid: false },
        },
      });
      assert(stopped.checkpoint);
      expect(stopped.checkpoint.currentBlockId).toBe("json");
      vi.mocked(executeTask).mockResolvedValue(
        response('{"proof":"retrieved"}'),
      );
      const resumed = await runRalphFlow(flow, config, customizations, {
        logger,
        checkpoint: stopped.checkpoint,
      });
      expect(resumed.status).toBe("completed");
      expect(executeTask).toHaveBeenCalledTimes(2);
      expect(
        resumed.blockResults.filter((block) => block.blockId === "start"),
      ).toHaveLength(1);
      expect(
        resumed.blockResults.filter((block) => block.blockId === "json"),
      ).toHaveLength(2);
      expect(resumed.durability?.status).toBe("healthy");
    } finally {
      vi.mocked(executeTask).mockReset();
      await rm(workspace, { recursive: true, force: true });
    }
  }, 60_000);
  it.each([1, 2])(
    "retains the cause and progress after %i retries without an ERROR route",
    async (maxRetries) => {
      const workspace = await mkdtemp(join(tmpdir(), "ralph-exhaustion-"));
      const config = { ...runtimeConfig, workspaceRoot: workspace };
      const flow = createFlow({
        blocks: [
          { id: "start", type: "START", title: "Start" },
          {
            id: "append",
            type: "UTILITY",
            title: "Append",
            utility: {
              type: "WRITE_FILE",
              path: "effects.txt",
              content: "once\n",
              append: true,
            },
          },
          {
            id: "prompt",
            type: "PROMPT",
            title: "Prompt",
            prompt: "Implement the feature.",
            settings: {
              retry: { mode: "finite", maxRetries, delaySeconds: 0 },
            },
          },
          { id: "success", type: "END", title: "Success" },
        ],
        edges: [
          {
            id: "start-append",
            from: "start",
            fromOutput: "SUCCESS",
            to: "append",
          },
          {
            id: "append-prompt",
            from: "append",
            fromOutput: "SUCCESS",
            to: "prompt",
          },
          {
            id: "prompt-success",
            from: "prompt",
            fromOutput: "SUCCESS",
            to: "success",
          },
        ],
      });
      vi.mocked(executeTask).mockResolvedValue(
        createExecutionResult({
          status: "blocked",
          summary:
            "Codex instruction enrollment failed: authentication must be a regular file.",
          reason: "Restore the authentication file and retry.",
        }),
      );
      try {
        const logger = await createRalphRunLogger(workspace, flow, {
          runId: "exhaustion",
        });
        const stopped = await runRalphFlow(flow, config, customizations, {
          logger,
          maxTransitions: 20,
        });
        expect(stopped.status, stopped.summary).toBe("blocked");
        expect(stopped.summary).toContain(
          "authentication must be a regular file",
        );
        expect(stopped.events.some((event) => event.type === "crash")).toBe(
          false,
        );
        expect(executeTask).toHaveBeenCalledTimes(maxRetries + 1);
        expect(stopped.checkpoint).toMatchObject({
          currentBlockId: "prompt",
          attemptCounts: { append: 1, prompt: maxRetries + 1 },
        });
        assert(stopped.checkpoint);
        const persisted = JSON.parse(
          await readFile(logger.paths!.recordPath, "utf8"),
        );
        expect(persisted.status).toBe("blocked");
        expect(persisted.summary).toContain(
          "authentication must be a regular file",
        );
        vi.mocked(executeTask).mockResolvedValue(
          createExecutionResult({ summary: "Feature implemented." }),
        );
        const resumed = await runRalphFlow(flow, config, customizations, {
          logger,
          maxTransitions: 20,
          checkpoint: stopped.checkpoint,
        });
        expect(resumed.status, resumed.summary).toBe("completed");
        expect(executeTask).toHaveBeenCalledTimes(maxRetries + 2);
        expect(await readFile(join(workspace, "effects.txt"), "utf8")).toBe(
          "once\n",
        );
        expect(resumed.durability?.status).toBe("healthy");
      } finally {
        vi.mocked(executeTask).mockReset();
        await rm(workspace, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
