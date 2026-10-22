import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { FleetCliProductRuntime } from "../../src/cli/_helpers/cli-fleet-product.ts";
import { loadFleetCliState } from "../../src/cli/_helpers/cli-fleet-state.ts";
import { loadRuntimeEnvironment } from "../../src/core/env.ts";
import { createTaskExecutionController } from "../../src/core/execution.ts";
import { getWorkspaceMcpConfigPath } from "../../src/core/mcp/config.ts";
import { mcpClientManager } from "../../src/core/mcp/client.ts";
import type { TaskExecutionResult } from "../../src/core/types.ts";

const directory = dirname(fileURLToPath(import.meta.url));
assert.equal(
  process.argv.length,
  2,
  "Run the correction verifier without CLI proxy arguments.",
);
const originalEntry = process.argv[1];
process.argv[1] = fileURLToPath(
  new URL("../../src/cli/main.ts", import.meta.url),
);
const artifactBase = fileURLToPath(
  new URL("../../../../.machdoch/validation/", import.meta.url),
);
await mkdir(artifactBase, { recursive: true });
const artifacts = await mkdtemp(join(artifactBase, "live-correction-"));
const workspace = join(artifacts, "workspace");
const environment = await loadRuntimeEnvironment();
const originalConfig = process.env.MACHDOCH_USER_CONFIG_DIR;
const originalCodexPath = process.env.CODEX_CLI_PATH;
process.env.MACHDOCH_USER_CONFIG_DIR = join(artifacts, "config");
if (environment.CODEX_CLI_PATH)
  process.env.CODEX_CLI_PATH = environment.CODEX_CLI_PATH;
const report: Record<string, unknown> = {
  artifacts,
  startedAt: new Date().toISOString(),
};
const executions: {
  task: string;
  startedAt: number;
  finishedAt?: number;
  result?: TaskExecutionResult;
}[] = [];
let runtime: FleetCliProductRuntime | undefined;
try {
  await mkdir(join(workspace, ".machdoch"), { recursive: true });
  await writeFile(
    join(workspace, ".machdoch", "config.json"),
    JSON.stringify({
      provider: "codex-cli",
      model: process.env.MACHDOCH_LIVE_TEST_MODEL || "gpt-6-luna",
      defaultMode: "ask",
      reasoning: "low",
      workspaceMemoryEnabled: false,
    }),
  );
  const marker = randomUUID();
  await writeFile(
    join(workspace, "revision.json"),
    JSON.stringify({ title: "Northern Lights", marker }),
  );
  const mcpPath = getWorkspaceMcpConfigPath(workspace);
  await mkdir(dirname(mcpPath), { recursive: true });
  await writeFile(
    mcpPath,
    JSON.stringify({
      schemaVersion: 1,
      servers: [
        {
          id: "correction-verification",
          enabled: true,
          timeoutMs: 180000,
          transport: {
            type: "stdio",
            command: process.execPath,
            args: [join(directory, "correction-fixture.mjs"), workspace],
          },
        },
      ],
    }),
  );
  runtime = await FleetCliProductRuntime.create(workspace, {
    createTaskExecutionController: (task, config, customizations, options) => {
      const execution: (typeof executions)[number] = {
        task,
        startedAt: Date.now(),
      };
      executions.push(execution);
      const controller = createTaskExecutionController(
        task,
        config,
        customizations,
        { ...options, executionRole: "generator" },
      );
      return {
        signal: controller.signal,
        cancel: controller.cancel,
        execute: async () => {
          const result = await controller.execute();
          execution.result = result;
          execution.finishedAt = Date.now();
          return result;
        },
      };
    },
  });
  const initial = await runtime.handleRequest({ type: "getProductSnapshot" });
  assert.equal(initial.type, "productSnapshot");
  if (initial.type !== "productSnapshot")
    throw new Error("Missing product snapshot.");
  const sessionId = initial.snapshot.shell?.activeSessionId;
  assert.ok(sessionId);
  const first = await runtime.handleRequest({
    type: "executeProductCommand",
    command: {
      kind: "submit-message",
      sessionId,
      prompt:
        "Original task: call the correction-verification MCP tool wait_for_revision, then report its result. This tool waits for a research revision. Do not use shell commands or any other tools.",
      promptEnhancementMode: "off",
      interviewEnabled: false,
    },
  });
  assert.equal(first.type, "commandAccepted");
  const startedDeadline = Date.now() + 120000;
  while (!existsSync(join(workspace, "waiting.json"))) {
    if (executions[0]?.finishedAt)
      throw new Error(
        `Original task ended before its tool call: ${executions[0].result?.summary}`,
      );
    assert.ok(
      Date.now() < startedDeadline,
      "Codex did not begin the pending tool call in time.",
    );
    await delay(100);
  }
  const prompt =
    "Correction: stop waiting for the original revision. Use the correction-verification MCP tool read_revised_title now. Return only the title and marker that it supplies. Do not call wait_for_revision again or use shell commands.";
  const correction = {
    kind: "submit-message",
    commandId: randomUUID(),
    sessionId,
    prompt,
    runningAction: "stop-and-send",
    promptEnhancementMode: "off",
    interviewEnabled: false,
  } as const;
  const corrected = await runtime.handleRequest({
    type: "executeProductCommand",
    command: correction,
  });
  assert.equal(corrected.type, "commandAccepted");
  assert.equal(executions.length, 2);
  assert.equal(executions[0]?.result?.status, "cancelled");
  assert.ok(executions[0]!.finishedAt! <= executions[1]!.startedAt);
  const duplicate = await runtime.handleRequest({
    type: "executeProductCommand",
    command: correction,
  });
  assert.ok(
    duplicate.type === "commandAccepted" && duplicate.receipt.duplicate,
  );
  const finishedDeadline = Date.now() + 120000;
  while ((await loadFleetCliState(workspace))?.sessions[0]?.pendingTask) {
    assert.ok(
      Date.now() < finishedDeadline,
      "Corrected task did not finish in time.",
    );
    await delay(100);
  }
  const state = await loadFleetCliState(workspace);
  const messages = state!.sessions[0]!.messages;
  const final = messages.at(-1)!;
  assert.equal(final.role, "agent");
  assert.ok(
    final.content.includes("Northern Lights") && final.content.includes(marker),
    final.content,
  );
  assert.equal(executions.length, 2);
  assert.deepEqual(
    messages.map((message) => message.role),
    ["user", "agent", "user", "agent"],
  );
  report.messages = messages;
  report.duplicate = duplicate;
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  await runtime?.shutdown();
  await mcpClientManager.closeAll();
  process.argv[1] = originalEntry;
  report.executions = executions;
  report.finishedAt = new Date().toISOString();
  if (originalConfig === undefined) delete process.env.MACHDOCH_USER_CONFIG_DIR;
  else process.env.MACHDOCH_USER_CONFIG_DIR = originalConfig;
  if (originalCodexPath === undefined) delete process.env.CODEX_CLI_PATH;
  else process.env.CODEX_CLI_PATH = originalCodexPath;
  await writeFile(
    join(artifacts, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(`Live correction verification: ${artifacts}`);
}
