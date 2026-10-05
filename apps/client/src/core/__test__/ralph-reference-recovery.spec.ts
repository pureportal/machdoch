import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createRalphRunLogger, runRalphFlow } from "../ralph.js";
import { featureImplementationChecklistLoopStarterFlow } from "../ralph-starter-flows/feature-implementation-checklist-loop.js";
import {
  createFlow,
  customizations,
  runtimeConfig,
} from "./ralph-test-helpers.js";

it("retains research and a previous goal across a durable checkpoint before downstream work", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ralph-reference-recovery-"));
  try {
    const research =
      "Primary source: https://example.com/docs/search\nPreserve keyboard support and filters.";
    const previousGoal = "Existing account management\nKeep audit history.";
    await writeFile(
      join(workspace, "checklist.json"),
      JSON.stringify({ research }),
    );
    const reader =
      featureImplementationChecklistLoopStarterFlow.flow.blocks.find(
        (block) => block.id === "read-selected-checklist",
      );
    if (reader?.type !== "UTILITY")
      throw new Error("Missing checklist reader.");
    const { parentGroupId: _parentGroupId, ...standaloneReader } = reader;
    const flow = createFlow({
      variables: [{ name: "previousGoal", type: "text", required: true }],
      blocks: [
        { id: "start", type: "START", title: "Start" },
        {
          ...standaloneReader,
          utility: { ...reader.utility, path: "checklist.json" },
        },
        {
          id: "use-references",
          type: "UTILITY",
          title: "Use References",
          utility: {
            type: "WRITE_FILE",
            path: "downstream.txt",
            content:
              "{{previousGoal:text}}\n{{data:read-selected-checklist:json.research}}",
          },
        },
        { id: "end", type: "END", title: "Done" },
      ],
      edges: [
        {
          id: "start-read",
          from: "start",
          fromOutput: "SUCCESS",
          to: reader.id,
        },
        {
          id: "read-use",
          from: reader.id,
          fromOutput: "SUCCESS",
          to: "use-references",
        },
        {
          id: "use-end",
          from: "use-references",
          fromOutput: "SUCCESS",
          to: "end",
        },
      ],
    });
    const logger = await createRalphRunLogger(workspace, flow);
    const controller = new AbortController();
    const config = { ...runtimeConfig, workspaceRoot: workspace };
    const stopped = await runRalphFlow(flow, config, customizations, {
      logger,
      variableValues: { previousGoal },
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "edge-route" && event.from === reader.id)
          controller.abort();
      },
    });
    expect(stopped.status, stopped.summary).toBe("stopped");
    expect(stopped.checkpoint?.currentBlockId).toBe("use-references");
    await expect(
      readFile(join(workspace, "downstream.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const resumed = await runRalphFlow(flow, config, customizations, {
      logger,
      checkpoint: stopped.checkpoint!,
    });
    expect(resumed.status, resumed.summary).toBe("completed");
    expect(await readFile(join(workspace, "downstream.txt"), "utf8")).toBe(
      `${previousGoal}\n${research}`,
    );
    expect(
      resumed.blockResults.filter((block) => block.blockId === reader.id),
    ).toHaveLength(1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
