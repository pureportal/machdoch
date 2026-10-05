import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { executeTask } from "../execution.js";
import { runRalphFlow, type RalphFlowBlock } from "../ralph.js";
import { getRalphStarterFlow } from "../ralph-starter-flows.js";
import {
  createExecutionResult,
  createFlow,
  customizations,
  runtimeConfig,
} from "./ralph-test-helpers.js";

vi.mock("../execution.js", () => ({ executeTask: vi.fn() }));

afterEach(() => vi.resetAllMocks());

const reviewResult = (decision: "DONE" | "CONTINUE") =>
  createExecutionResult({
    response: {
      markdown: JSON.stringify({
        decision,
        confidence: 1,
        summary:
          decision === "DONE"
            ? "Feature verified"
            : "Keyboard support is missing",
        evidence: ["Inspected the integrated feature and passing checks"],
        remainingWork: decision === "DONE" ? [] : ["Add keyboard support"],
      }),
      highlights: [],
      relatedFiles: [],
      verification: [],
      followUps: [],
    },
  });

const createCompletionFlow = (workspace: string) => {
  const template = getRalphStarterFlow("full-feature-implementation")!.flow;
  const ids = new Set([
    "read-completed-checklist",
    "count-feature-review",
    "verify-complete-feature",
    "validate-feature",
    "repair-feature-gaps",
  ]);
  const blocks = template.blocks
    .filter((block) => ids.has(block.id))
    .map((block): RalphFlowBlock => {
      const { parentGroupId: _parentGroupId, ...standalone } = block;
      if (standalone.type !== "UTILITY") return standalone;
      if (standalone.id === "read-completed-checklist") {
        return {
          ...standalone,
          utility: { ...standalone.utility, path: "checklist.json" },
        };
      }
      if (standalone.id === "count-feature-review") {
        return {
          ...standalone,
          utility: {
            ...standalone.utility,
            counterName: "feature-review",
            maxAttempts: 2,
          },
        };
      }
      if (standalone.id === "verify-complete-feature") {
        const { fallbackCommand: _fallbackCommand, ...utility } =
          standalone.utility;
        return {
          ...standalone,
          utility: {
            ...utility,
            command: "node -e \"console.log('1 test passed')\"",
            cwd: workspace,
            timeoutSeconds: 120,
          },
        };
      }
      return standalone;
    });
  const targets = [
    "record-done-outcome",
    "record-deferred-outcome",
    "record-invalid-outcome",
  ];
  return createFlow({
    blocks: [
      { id: "start", type: "START", title: "Start" },
      ...blocks,
      ...targets.map((id): RalphFlowBlock => ({ id, type: "END", title: id })),
    ],
    edges: [
      {
        id: "start-completion",
        from: "start",
        fromOutput: "SUCCESS",
        to: "read-completed-checklist",
      },
      ...template.edges
        .filter((edge) => ids.has(edge.from))
        .map((edge) =>
          edge.to === "resolve-feature-scope"
            ? { ...edge, to: "record-done-outcome" }
            : edge,
        ),
    ],
  });
};

it("repairs whole-feature gaps and repeats verification before allowing the done route", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ralph-feature-completion-"));
  try {
    const checklist = {
      acceptanceCriteria: ["Keyboard support"],
      research: "https://example.com/docs",
      tasks: [{ id: "search", status: "completed" }],
    };
    await writeFile(
      join(workspace, "checklist.json"),
      JSON.stringify(checklist),
    );
    vi.mocked(executeTask)
      .mockResolvedValueOnce(reviewResult("CONTINUE"))
      .mockResolvedValueOnce(createExecutionResult())
      .mockResolvedValueOnce(reviewResult("DONE"));
    const routedTargets: string[] = [];
    const result = await runRalphFlow(
      createCompletionFlow(workspace),
      { ...runtimeConfig, workspaceRoot: workspace },
      customizations,
      {
        onEvent: (event) => {
          if (event.type === "edge-route") routedTargets.push(event.to);
        },
      },
    );
    expect(result.status, result.summary).toBe("completed");
    expect(routedTargets.at(-1), JSON.stringify(result.blockResults)).toBe(
      "record-done-outcome",
    );
    expect(
      routedTargets.filter((id) => id === "verify-complete-feature"),
    ).toHaveLength(2);
    expect(
      routedTargets.filter((id) => id === "repair-feature-gaps"),
    ).toHaveLength(1);
    expect(executeTask).toHaveBeenCalledTimes(3);
    expect(
      JSON.parse(await readFile(join(workspace, "checklist.json"), "utf8")),
    ).toEqual(checklist);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}, 120_000);

it("preserves the feature review budget across a checkpoint and defers repeated gaps", async () => {
  const workspace = await mkdtemp(
    join(tmpdir(), "ralph-feature-review-budget-"),
  );
  try {
    await writeFile(
      join(workspace, "checklist.json"),
      JSON.stringify({ tasks: [{ status: "completed" }] }),
    );
    vi.mocked(executeTask).mockImplementation(async () =>
      reviewResult("CONTINUE"),
    );
    const flow = createCompletionFlow(workspace);
    const config = { ...runtimeConfig, workspaceRoot: workspace };
    const controller = new AbortController();
    const stopped = await runRalphFlow(flow, config, customizations, {
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "edge-route" && event.from === "repair-feature-gaps")
          controller.abort();
      },
    });
    expect(stopped.status, JSON.stringify(stopped.blockResults)).toBe(
      "stopped",
    );
    const routedTargets: string[] = [];
    const resumed = await runRalphFlow(flow, config, customizations, {
      checkpoint: stopped.checkpoint!,
      onEvent: (event) => {
        if (event.type === "edge-route") routedTargets.push(event.to);
      },
    });
    expect(resumed.status, resumed.summary).toBe("completed");
    expect(routedTargets.at(-1)).toBe("record-deferred-outcome");
    expect(routedTargets).not.toContain("record-done-outcome");
    expect(
      resumed.blockResults.filter(
        (result) => result.blockId === "validate-feature",
      ),
    ).toHaveLength(2);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}, 120_000);
