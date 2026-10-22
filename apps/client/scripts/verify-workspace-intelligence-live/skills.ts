import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadRuntimeEnvironment } from "../../src/core/env.ts";
import { saveManagedSkill } from "../../src/core/managed-skills.ts";
import { createManagedSkillCatalog } from "../../src/core/managed-skill-delivery.ts";
import { createManagedSkillToolDefinitions } from "../../src/core/_helpers/managed-skill-tool-definitions.ts";
import { startLocalMcpHost } from "../../src/core/local-mcp/http.ts";
import { loadRuntimeConfig } from "../../src/core/config.ts";
import { createInstructionResolutionFixture } from "../../src/core/__test__/instruction-test-helpers.ts";
import { createInstructionDeliveryPlan } from "../../src/core/instruction-system/delivery.ts";
import { probeProviderCli } from "../../src/core/provider-enrollment/capability-registry.ts";
import { createCliInstructionCapabilityFromProbe } from "../../src/core/provider-enrollment/instruction-delivery-preflight.ts";
import { materializeCliEnrollment } from "../../src/core/provider-enrollment/materializer.ts";

const artifactsBase = new URL(
  "../../../../.machdoch/validation/",
  import.meta.url,
);
await mkdir(artifactsBase, { recursive: true });
const artifacts = await mkdtemp(
  join(fileURLToPath(artifactsBase), "native-skills-"),
);
const workspaceRoot = join(artifacts, "workspace");
await mkdir(workspaceRoot);
const environment = await loadRuntimeEnvironment();
const originalConfig = process.env.MACHDOCH_USER_CONFIG_DIR;
process.env.MACHDOCH_USER_CONFIG_DIR = join(artifacts, "config");
const report: Record<string, unknown> = {
  artifacts,
  startedAt: new Date().toISOString(),
};
let enrollment:
  | Awaited<ReturnType<typeof materializeCliEnrollment>>
  | undefined;
let host: Awaited<ReturnType<typeof startLocalMcpHost>> | undefined;
try {
  const expected = `verified-${randomUUID()}`;
  const skill = await saveManagedSkill({
    name: "verification-evidence",
    description:
      "Read the verification evidence marker from the bundled reference file.",
    content:
      "Read references/evidence.json relative to this skill directory. Return only its marker value. Do not invent the marker.",
    enabled: true,
  });
  await mkdir(join(dirname(skill.path), "references"));
  await writeFile(
    join(dirname(skill.path), "references", "evidence.json"),
    JSON.stringify({ marker: expected }),
  );
  await saveManagedSkill({
    name: "verification-disabled",
    description: "Disabled verification skill.",
    content: "Never activate this disabled skill.",
    enabled: false,
  });
  const executable = environment.CODEX_CLI_PATH || "codex";
  const model = process.env.MACHDOCH_LIVE_TEST_MODEL || "gpt-6-luna";
  const resolution = createInstructionResolutionFixture({
    providerId: "codex-cli",
    surface: "cli",
    model,
    body: "Use the explicitly requested skill. Read its instructions and referenced resources before answering.",
  });
  const probe = await probeProviderCli("codex-cli", executable);
  report.codexVersion = probe.version;
  const deliveryPlan = createInstructionDeliveryPlan(resolution, {
    capability: createCliInstructionCapabilityFromProbe(resolution, probe),
  });
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  host = await startLocalMcpHost({
    config: await loadRuntimeConfig(workspaceRoot, "ask", model, "codex-cli"),
    memory: {
      sessionEnabled: false,
      sessionEntries: [],
      globalEnabled: false,
      globalEntries: [],
    },
    scopedToolDefinitions: createManagedSkillToolDefinitions(),
    onToolCall: (call) =>
      calls.push({ name: call.name, arguments: call.arguments }),
  });
  enrollment = await materializeCliEnrollment({
    provider: "codex-cli",
    executable,
    workspaceRoot,
    runId: randomUUID(),
    resolution,
    deliveryPlan,
    runtimeSystemInstructions: `Complete the skill verification using only the synthetic files supplied for this task. Read skills and resources with the Machdoch read_managed_skill tool.\n${await createManagedSkillCatalog()}`,
    localMcp: host.endpoint,
    localMcpOnly: true,
    machdochCliLaunch: {
      command: process.execPath,
      args: [
        "--import",
        import.meta.resolve("@oxc-node/core/register"),
        fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url)),
      ],
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      environment: {
        MACHDOCH_USER_CONFIG_DIR: process.env.MACHDOCH_USER_CONFIG_DIR,
      },
    },
  });
  const files = enrollment.manifest.renderedFiles.filter(
    (file) => file.role === "skill-resource",
  );
  assert.equal(files.length, 2);
  assert.ok(files.every((file) => file.path.includes("verification-evidence")));
  report.materializedFiles = files.map((file) => ({
    path: file.path,
    digest: file.digest,
  }));
  const projected = enrollment.mcpProjection.servers.find(
    (server) => server.id === "machdoch",
  )!.providerConfig;
  const client = new Client({ name: "skill-verification", version: "1.0.0" });
  try {
    await client.connect(
      new StdioClientTransport({
        command: projected.command as string,
        args: projected.args as string[],
        cwd: projected.cwd as string,
        env: projected.env as Record<string, string>,
        stderr: "pipe",
      }),
    );
    assert.ok(
      (await client.listTools()).tools.some(
        (tool) => tool.name === "read_managed_skill",
      ),
    );
  } finally {
    await client.close();
  }
  const invocation = promisify(execFile)(
    executable,
    [
      "exec",
      "--ignore-rules",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--json",
      "--cd",
      workspaceRoot,
      "--model",
      model,
      ...enrollment.args,
      "-c",
      'approval_policy="never"',
      "-c",
      'model_reasoning_effort="low"',
      "-c",
      "skills.bundled.enabled=false",
      "-c",
      "model_context_window=128000",
      "Use $verification-evidence and return the marker from its reference file. Do not search outside that skill's directory. Read the skill before using it.",
    ],
    {
      windowsHide: true,
      cwd: workspaceRoot,
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, ...enrollment.env },
    },
  );
  invocation.child.stdin?.end();
  const result = await invocation;
  await writeFile(join(artifacts, "codex.jsonl"), result.stdout);
  await writeFile(join(artifacts, "codex.stderr.txt"), result.stderr);
  const events = result.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  const answer = events
    .filter(
      (event) =>
        event.type === "item.completed" && event.item?.type === "agent_message",
    )
    .at(-1)?.item?.text;
  assert.equal(answer, expected);
  const toolEvents = events.filter(
    (event) =>
      event.type === "item.completed" && event.item?.type !== "agent_message",
  );
  assert.ok(JSON.stringify(toolEvents).includes("SKILL.md"));
  assert.ok(JSON.stringify(toolEvents).includes("evidence.json"));
  assert.ok(
    calls.some(
      (call) =>
        call.name === "read_managed_skill" &&
        call.arguments.name === "verification-evidence" &&
        call.arguments.path === "references/evidence.json",
    ),
  );
  report.toolCalls = calls;
  report.answer = answer;
  report.contextWindowTokens = 128000;
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  if (enrollment) report.cleanup = await enrollment.dispose();
  await host?.close();
  if (originalConfig === undefined) delete process.env.MACHDOCH_USER_CONFIG_DIR;
  else process.env.MACHDOCH_USER_CONFIG_DIR = originalConfig;
  report.finishedAt = new Date().toISOString();
  await writeFile(
    join(artifacts, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(`Native skill verification: ${artifacts}`);
}
