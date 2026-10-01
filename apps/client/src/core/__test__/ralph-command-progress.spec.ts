import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runRalphFlow } from "../ralph.js";
import type { TaskExecutionProgress } from "../types.js";
import {
  createFlow,
  customizations,
  runtimeConfig,
} from "./ralph-test-helpers.js";

describe("RALPH command progress", () => {
  it.each(["RUN_COMMAND", "RUN_CHECK"] as const)(
    "streams %s output before completion and retains it in the block record",
    async (type) => {
      const workspace = await mkdtemp(
        join(tmpdir(), "ralph-command-progress-"),
      );
      try {
        const progress: TaskExecutionProgress[] = [];
        const result = await runRalphFlow(
          createFlow({
            blocks: [
              { id: "start", type: "START", title: "Start" },
              {
                id: "check",
                type: "UTILITY",
                title: "Verify changes",
                utility: {
                  type,
                  command:
                    "node -e \"console.log('checking'); const fs = require('fs'); const poll = setInterval(() => { if (fs.existsSync('stream-received')) { clearInterval(poll); console.error('diagnostic'); } }, 20); setTimeout(() => process.exit(9), 5000).unref()\"",
                },
              },
              { id: "end", type: "END", title: "Done" },
            ],
            edges: [
              {
                id: "start-check",
                from: "start",
                fromOutput: "SUCCESS",
                to: "check",
              },
              {
                id: "check-end",
                from: "check",
                fromOutput: "SUCCESS",
                to: "end",
              },
            ],
          }),
          { ...runtimeConfig, workspaceRoot: workspace },
          { ...customizations, workspaceRoot: workspace },
          {
            onStateChange: async (event) => {
              progress.push(event);
              if (event.actionOutput?.chunk.includes("checking"))
                await writeFile(join(workspace, "stream-received"), "received");
            },
          },
        );

        expect(result.status).toBe("completed");
        expect(progress.map((event) => event.actionOutput?.stream)).toEqual([
          "stdout",
          "stderr",
        ]);
        expect(
          progress.every(
            (event) => event.timelineEvent?.metadata?.ralphBlockId === "check",
          ),
        ).toBe(true);
        expect(
          result.blockResults.find((block) => block.blockId === "check"),
        ).toMatchObject({
          output: "SUCCESS",
          progress: [
            { kind: "action-output", content: "checking\n" },
            { kind: "action-output", content: "diagnostic\n" },
          ],
        });
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );
});
