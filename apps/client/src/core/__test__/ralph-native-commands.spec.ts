import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, toNamespacedPath } from "node:path";
import { describe, expect, it } from "vitest";
import { runRalphFlow } from "../ralph.js";
import {
  createFlow,
  customizations,
  runtimeConfig,
} from "./ralph-test-helpers.js";

describe("RALPH native verification commands", () => {
  it("executes the detected native runner from a namespaced workspace path", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph native commands "));
    try {
      await mkdir(join(workspace, "src-tauri"));
      await mkdir(join(workspace, "scripts"));
      await writeFile(
        join(workspace, "src-tauri", "Cargo.toml"),
        '[package]\nname = "native-check"\nversion = "0.1.0"\n',
      );
      await writeFile(
        join(workspace, "scripts", "run-cargo.mjs"),
        "console.log(JSON.stringify(process.argv.slice(2)));\n",
      );
      const result = await runRalphFlow(
        createFlow({
          blocks: [
            { id: "start", type: "START", title: "Start" },
            {
              id: "detect",
              type: "UTILITY",
              title: "Detect Commands",
              utility: {
                type: "DETECT_PROJECT_COMMANDS",
                rootPath: "src-tauri",
              },
            },
            {
              id: "check",
              type: "UTILITY",
              title: "Check Compilation",
              utility: {
                type: "RUN_CHECK",
                command: "{{data:detect:focusedVerificationCommand}}",
                cwd: "{{data:detect:rootPath}}",
              },
            },
            { id: "end", type: "END", title: "Done" },
          ],
          edges: [
            {
              id: "start-detect",
              from: "start",
              fromOutput: "SUCCESS",
              to: "detect",
            },
            {
              id: "detect-check",
              from: "detect",
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
        { ...runtimeConfig, workspaceRoot: toNamespacedPath(workspace) },
        { ...customizations, workspaceRoot: workspace },
      );

      expect(result.status).toBe("completed");
      expect(
        result.blockResults.find((block) => block.blockId === "check"),
      ).toMatchObject({
        output: "SUCCESS",
        data: {
          exitCode: 0,
          stdout: '["check","--locked"]',
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
