import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { executeTask } from "../execution.js";
import { runRalphFlow } from "../ralph.js";
import { getRalphStarterFlow } from "../ralph-starter-flows.js";
import {
  createExecutionResult,
  customizations,
  runtimeConfig,
} from "./ralph-test-helpers.js";

vi.mock("../execution.js", () => ({ executeTask: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const execute = promisify(execFile);

it.each([false, true])(
  "requires actual in-scope changes before recording completion (outside scope: %s)",
  async (outsideScope) => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-feature-scope-"));
    try {
      await writeFile(
        join(workspace, "app.js"),
        "module.exports = { feature: false };\n",
      );
      await writeFile(join(workspace, ".gitignore"), ".machdoch/\n");
      for (const argumentsList of [
        ["init"],
        ["add", "app.js", ".gitignore"],
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@localhost",
          "commit",
          "-m",
          "Baseline",
        ],
      ])
        await execute("git", argumentsList, { cwd: workspace });
      const variables = {
        continuous: "false",
        featureId: "feature-scope",
        featureRequest: "Enable the feature in app.js",
        acceptanceCriteria: "The feature flag is true",
        previousGoal: "Keep browser-local data",
        implementationScope: "app.js",
        enableOnlineResearch: "false",
        enableVisualReview: "false",
        verificationCommand: `node -e "require('node:assert/strict').equal(require('./app.js').feature, true); console.log('1 test passed')"`,
      };
      const checklist = {
        featureId: variables.featureId,
        requestKey: JSON.stringify([
          variables.featureRequest,
          variables.acceptanceCriteria,
          variables.previousGoal,
        ]),
        request: variables.featureRequest,
        previousGoal: variables.previousGoal,
        research: "Local repository evidence",
        acceptanceCriteria: [variables.acceptanceCriteria],
        status: "planned",
        tasks: [
          {
            id: "enable-feature",
            title: "Enable feature",
            status: "planned",
            batchKey: "feature",
            dependencies: [],
            likelyFiles: ["app.js"],
            size: "small",
            acceptanceCriteria: [variables.acceptanceCriteria],
            priority: 100,
          },
        ],
      };
      vi.mocked(executeTask).mockImplementation(async (task) => {
        let response = "Feature brief";
        if (task.includes("Structured JSON utility block: Create Checklist"))
          response = JSON.stringify(checklist);
        else if (task.includes("Block: Implement Checklist Items")) {
          await writeFile(
            join(workspace, "app.js"),
            "module.exports = { feature: true };\n",
          );
          if (outsideScope)
            await writeFile(
              join(workspace, "unrelated.js"),
              "module.exports = {};\n",
            );
          response = "Implemented feature";
        } else if (task.includes("Structured JSON utility block:"))
          response = JSON.stringify({
            decision: "DONE",
            confidence: 1,
            summary: "Verified feature",
            evidence: ["Passing feature check"],
            remainingWork: [],
          });
        return createExecutionResult({
          response: {
            markdown: response,
            highlights: [],
            relatedFiles: [],
            verification: [],
            followUps: [],
          },
        });
      });
      const result = await runRalphFlow(
        getRalphStarterFlow("full-feature-implementation")!.flow,
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        { variableValues: variables },
      );
      const scope = result.blockResults.find(
        (block) => block.blockId === "scope-change-guard",
      );
      expect(scope?.output, result.summary).toBe(
        outsideScope ? "OUT_OF_SCOPE" : "IN_SCOPE",
      );
      expect(scope?.data).toMatchObject({
        guardedFiles: outsideScope ? ["app.js", "unrelated.js"] : ["app.js"],
        allowedPaths: ["app.js"],
        enforcement: "blocking",
      });
      expect(
        result.blockResults.some(
          (block) => block.blockId === "record-done-outcome",
        ),
      ).toBe(!outsideScope);
      expect(result.outcome?.verified, result.summary).toBe(!outsideScope);
      const journal = await readFile(
        join(
          workspace,
          ".machdoch",
          "feature-implementation",
          "outcomes.jsonl",
        ),
        "utf8",
      );
      expect(journal.includes('"outcome":"DONE"')).toBe(!outsideScope);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  },
  120_000,
);
