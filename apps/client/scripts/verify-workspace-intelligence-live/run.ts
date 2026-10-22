import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright-core";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadRuntimeEnvironment } from "../../src/core/env.ts";
import { createLiveVoiceSession } from "../../src/core/live-voice.ts";
import { mcpClientManager } from "../../src/core/mcp/client.ts";
import {
  getWorkspaceMcpConfigPath,
  loadMcpConfig,
} from "../../src/core/mcp/config.ts";
import {
  listMcpAppsForRun,
  runMcpAppRequest,
} from "../../src/core/mcp/apps.ts";
import { projectMcpForProvider } from "../../src/core/provider-enrollment/mcp-projector.ts";
import { runWorkspaceLibraryRequest } from "../../src/core/workspace-library/index.ts";
import type { ResearchProject } from "@machdoch/fleet-protocol/workspace-library";
import { startVerificationFleet } from "./fleet.ts";

const directory = dirname(fileURLToPath(import.meta.url));
const clientRoot = fileURLToPath(new URL("../../", import.meta.url));
const artifactBase = fileURLToPath(
  new URL("../../../../.machdoch/validation/", import.meta.url),
);
await mkdir(artifactBase, { recursive: true });
const replay = process.argv[2];
const artifacts = replay
  ? resolve(replay)
  : await mkdtemp(join(artifactBase, "workspace-intelligence-"));
assert.ok(
  dirname(artifacts) === resolve(artifactBase) &&
    basename(artifacts).startsWith("workspace-intelligence-"),
);
const root = join(artifacts, "workspace");
await mkdir(root, { recursive: true });
const execute = promisify(execFile);
const originalConfig = process.env.MACHDOCH_USER_CONFIG_DIR;
const codexProfile = join(artifacts, "codex-profile");
const environment = await loadRuntimeEnvironment();
const checks: string[] = [];
const report: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  checks,
  artifacts,
};
const pass = (name: string): void => {
  checks.push(name);
  console.log(`PASS ${name}`);
};
const restoreConfig = (): void => {
  if (originalConfig === undefined) delete process.env.MACHDOCH_USER_CONFIG_DIR;
  else process.env.MACHDOCH_USER_CONFIG_DIR = originalConfig;
};
const toml = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(toml).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .map(([key, entry]) => `${JSON.stringify(key)}=${toml(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let fleet: Awaited<ReturnType<typeof startVerificationFleet>> | undefined;
let page:
  | Awaited<ReturnType<NonNullable<typeof browser>["newPage"]>>
  | undefined;
try {
  process.env.MACHDOCH_USER_CONFIG_DIR = join(artifacts, "config");
  await runMcpAppRequest(root, { action: "set-enabled", enabled: true });
  const runId = "live-app-verification";
  if (replay) {
    const previous = JSON.parse(
      await readFile(join(artifacts, "report.json"), "utf8"),
    );
    assert.ok(
      previous.checks.includes(
        "Real Codex invocation uses the projected MCP proxy and persists its interactive result",
      ),
    );
    report.codexVersion = previous.codexVersion;
    report.reusedCodexRun = true;
  } else {
    const configPath = getWorkspaceMcpConfigPath(root);
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        servers: [
          {
            id: "live-comparison",
            enabled: true,
            transport: {
              type: "stdio",
              command: process.execPath,
              args: [join(directory, "mcp-fixture.mjs"), root],
            },
          },
        ],
      }),
    );
    const server = (await loadMcpConfig(root)).servers.find(
      (entry) => entry.id === "live-comparison",
    )!;
    const discovery = await mcpClientManager.discoverServer(root, server);
    assert.equal(discovery.tools.length, 2);
    const projection = await projectMcpForProvider("codex-cli", root, {
      appRun: { id: runId, readOnly: false },
      machdochCliLaunch: {
        command: process.execPath,
        args: [
          "--import",
          import.meta.resolve("@oxc-node/core/register"),
          join(clientRoot, "src", "cli", "main.ts"),
        ],
        cwd: clientRoot,
        environment: {
          MACHDOCH_USER_CONFIG_DIR: process.env.MACHDOCH_USER_CONFIG_DIR,
        },
      },
    });
    assert.equal(projection.servers[0]?.route, "cli-stdio-proxy");
    const projected = projection.servers[0]!.providerConfig;
    const proxy = new Client({
      name: "live-proxy-preflight",
      version: "1.0.0",
    });
    const transport = new StdioClientTransport({
      command: projected.command as string,
      args: projected.args as string[],
      cwd: projected.cwd as string,
      env: projected.env as Record<string, string>,
      stderr: "pipe",
    });
    try {
      await proxy.connect(transport);
      assert.deepEqual(
        (await proxy.listTools()).tools.map((tool) => tool.name),
        ["show_comparison"],
      );
      pass(
        "Production CLI proxy exposes the model tool and hides the app-only action",
      );
    } finally {
      await proxy.close();
    }
    const codex = environment.CODEX_CLI_PATH || "codex";
    report.codexVersion = (
      await execute(codex, ["--version"], { windowsHide: true })
    ).stdout.trim();
    assert.ok(
      process.env.CODEX_HOME,
      "Run this verification with the authenticated Codex CLI environment.",
    );
    await mkdir(codexProfile);
    await copyFile(
      join(process.env.CODEX_HOME, "auth.json"),
      join(codexProfile, "auth.json"),
    );
    const args = [
      "exec",
      "--ignore-rules",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--model",
      process.env.MACHDOCH_LIVE_TEST_MODEL || "gpt-6-luna",
      "--json",
      "--cd",
      root,
      "-c",
      'approval_policy="never"',
      "-c",
      "project_doc_max_bytes=0",
      "-c",
      'model_reasoning_effort="low"',
      "-c",
      "mcp_optional_startup_grace_ms=0",
      "-c",
      `mcp_servers=${toml(Object.fromEntries(projection.servers.map((entry) => [entry.id, entry.providerConfig])))}`,
      "Use tool discovery if needed to find the show_comparison MCP tool from the live-comparison server, then call it exactly once with title 'Aurora research'. Do not use shell commands or read files. After the tool succeeds reply with its title. The task is not complete until the real tool call succeeds.",
    ];
    const invocation = execute(codex, args, {
      cwd: root,
      windowsHide: true,
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, CODEX_HOME: codexProfile },
    });
    invocation.child.stdin?.end();
    const result = await invocation;
    await writeFile(join(artifacts, "codex.stderr.txt"), result.stderr);
    await writeFile(join(artifacts, "codex.jsonl"), result.stdout);
    assert.match(result.stdout, /show_comparison/);
  }
  const appIds = await listMcpAppsForRun(root, runId);
  assert.equal(appIds.length, 1);
  const view = await runMcpAppRequest(root, { action: "load", id: appIds[0] });
  assert.equal(
    (view as { result: { structuredContent: { title: string } } }).result
      .structuredContent.title,
    "Aurora research",
  );
  pass(
    "Real Codex invocation uses the projected MCP proxy and persists its interactive result",
  );

  const bundle = await build({
    configFile: false,
    plugins: [react()],
    logLevel: "error",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      write: false,
      cssCodeSplit: false,
      lib: {
        entry: join(directory, "browser.tsx"),
        formats: ["iife"],
        name: "WorkspaceIntelligenceVerification",
      },
    },
  });
  const output = (Array.isArray(bundle) ? bundle : [bundle]).flatMap(
    (result) => ("output" in result ? result.output : []),
  );
  const code = output
    .filter((entry) => entry.type === "chunk")
    .map((entry) => entry.code)
    .join("\n");
  const css = output
    .flatMap((entry) =>
      entry.type === "asset" && entry.fileName.endsWith(".css")
        ? [String(entry.source)]
        : [],
    )
    .join("\n");
  browser = await chromium.launch({ channel: "msedge", headless: true });
  page = await browser.newPage();
  page.setDefaultTimeout(20_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  fleet = await startVerificationFleet(root);
  const authentication = await page.request.post(
    `${fleet.origin}/api/auth/login`,
    { headers: { Origin: fleet.origin }, data: fleet.owner },
  );
  assert.equal(authentication.status(), 200);
  const endpoint = `${fleet.origin}/api/instances/${fleet.instanceId}/product/workspace`;
  assert.equal(
    (
      await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: fleet.origin },
        body: JSON.stringify({
          kind: "invoke",
          id: crypto.randomUUID(),
          command: "run_mcp_app_command",
          args: { workspaceRoot: "", input: { action: "settings" } },
        }),
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await page.request.post(endpoint, {
        headers: { Origin: fleet.origin },
        data: {
          kind: "invoke",
          id: crypto.randomUUID(),
          command: "run_mcp_app_command",
          args: { workspaceRoot: "", input: { action: "settings" } },
        },
      })
    ).status(),
    403,
  );
  pass(
    "Actual Fleet HTTP requests enforce browser authentication and CSRF before gateway dispatch",
  );
  await page.addInitScript(
    (verification) => {
      window.verification = verification;
    },
    { root, appIds, instanceId: fleet.instanceId },
  );
  await page.route(`${fleet.origin}/`, (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<html><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script>${code.replaceAll("</script", "<\\/script")}</script></body></html>`,
    }),
  );
  await page.goto(`${fleet.origin}/`);
  const app = page
    .frameLocator("iframe[title='show_comparison']")
    .frameLocator("iframe");
  await app
    .getByRole("heading", { name: "Aurora research", exact: true })
    .waitFor();
  page.once("dialog", (dialog) => dialog.accept());
  await app.getByRole("button", { name: "Use revised title" }).click();
  await app
    .getByRole("heading", { name: "Northern Lights", exact: true })
    .waitFor();
  assert.deepEqual(
    JSON.parse(await readFile(join(root, "app-action.json"), "utf8")),
    { title: "Northern Lights" },
  );
  assert.equal(
    await page
      .locator("iframe[title='show_comparison']")
      .evaluate((element) => {
        try {
          return (element as HTMLIFrameElement).contentWindow!.document.body
            .innerHTML;
        } catch {
          return "isolated";
        }
      }),
    "isolated",
  );
  pass(
    "Browser MCP App initializes, receives the model result, and persists a confirmed app-only tool action in an isolated frame",
  );
  await page.getByRole("checkbox", { name: "MCP Apps", exact: true }).uncheck();
  await page
    .locator("iframe[title='show_comparison']")
    .waitFor({ state: "detached" });
  await page.evaluate(() => {
    window.verification.stallNextApp = true;
  });
  await page.getByRole("checkbox", { name: "MCP Apps", exact: true }).check();
  await app.getByRole("heading", { name: "Startup fixture" }).waitFor();
  await page
    .getByRole("alert")
    .filter({ hasText: "did not start" })
    .waitFor({ timeout: 25_000 });
  assert.equal(
    await page.locator("iframe[title='show_comparison']").count(),
    0,
  );
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await app
    .getByRole("heading", { name: "Aurora research", exact: true })
    .waitFor();
  pass(
    "MCP Apps setting removes existing frames and an app startup timeout recovers through Retry",
  );

  await execute("git", ["init", "--quiet"], { cwd: root, windowsHide: true });
  const projectTitle = `Aurora study ${Date.now()}`;
  await writeFile(
    join(root, "evidence.md"),
    "# Aurora evidence\r\nNorthern Lights are visible.\r\n",
  );
  await page.getByRole("tab", { name: "Research", exact: true }).click();
  await page.getByRole("button", { name: "New project" }).click();
  await page
    .getByRole("textbox", { name: "Title", exact: true })
    .fill(projectTitle);
  await page
    .getByRole("textbox", { name: "Research question" })
    .fill("What is visible?");
  await page.getByRole("button", { name: "Save project" }).click();
  await page.getByRole("button", { name: new RegExp(projectTitle) }).waitFor();
  await page.getByRole("tab", { name: "Knowledge", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Search workspace knowledge" })
    .fill("Aurora");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("button", { name: /evidence\.md/ }).waitFor();
  await page.getByRole("button", { name: "Save to research" }).click();
  await page
    .getByRole("combobox", { name: "Research project" })
    .selectOption({ label: projectTitle });
  await page.getByRole("button", { name: "Save source" }).click();
  await page
    .getByRole("button", { name: "Save source" })
    .waitFor({ state: "detached" });
  const projects = (await runWorkspaceLibraryRequest(root, {
    action: "projects",
  })) as ResearchProject[];
  assert.equal(
    projects.find((project) => project.title === projectTitle)!.sources[0]!.uri,
    "evidence.md",
  );
  await page.reload();
  await page.getByRole("tab", { name: "Research", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(projectTitle) }).click();
  assert.equal(
    await page
      .getByRole("textbox", { name: "Title", exact: true })
      .first()
      .inputValue(),
    projectTitle,
  );
  pass(
    "Shared Fleet workspace UI saves Windows search evidence into research and retains it after reload",
  );
  await page
    .getByRole("textbox", { name: "Notes", exact: true })
    .fill("Keep this unsaved draft.");
  const dialogs: string[] = [];
  const dismissDiscard = async (
    dialog: import("playwright-core").Dialog,
  ): Promise<void> => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  };
  page.on("dialog", dismissDiscard);
  await page.getByRole("tab", { name: "Research", exact: true }).click();
  assert.deepEqual(dialogs, []);
  await page.getByRole("tab", { name: "Knowledge", exact: true }).click();
  assert.deepEqual(dialogs, ["Discard your unsaved changes?"]);
  assert.equal(
    await page
      .getByRole("textbox", { name: "Notes", exact: true })
      .inputValue(),
    "Keep this unsaved draft.",
  );
  page.off("dialog", dismissDiscard);
  pass(
    "Selecting the active Research tab retains dirty-state protection and cancelling navigation preserves the draft",
  );

  const skills = page.getByRole("region", { name: "Skills", exact: true });
  const skillName = `network-skill-${Date.now()}`;
  await skills.getByRole("button", { name: "New skill", exact: true }).click();
  await skills
    .getByRole("textbox", { name: "Name", exact: true })
    .fill(skillName);
  await skills
    .getByRole("textbox", { name: "Description", exact: true })
    .fill("Check source references in a synthetic research project.");
  await skills
    .getByRole("textbox", { name: "Content", exact: true })
    .fill(
      "Read the selected research sources and compare their fingerprints before editing a finding.",
    );
  await skills.getByRole("button", { name: "Save", exact: true }).click();
  await skills.getByRole("button", { name: skillName, exact: true }).waitFor();
  await skills.getByRole("switch", { name: "Enabled", exact: true }).click();
  await skills.getByRole("button", { name: "Save", exact: true }).click();
  await skills.getByRole("button", { name: "Save", exact: true }).waitFor();
  assert.equal(
    await skills
      .getByRole("button", { name: "Save", exact: true })
      .isDisabled(),
    true,
  );
  await page.reload();
  await skills.getByRole("button", { name: skillName, exact: true }).click();
  assert.equal(
    await skills
      .getByRole("switch", { name: "Enabled", exact: true })
      .getAttribute("aria-checked"),
    "false",
  );
  assert.equal(
    await skills
      .getByRole("textbox", { name: "Content", exact: true })
      .inputValue(),
    "Read the selected research sources and compare their fingerprints before editing a finding.",
  );
  pass(
    "Skills are created, disabled, and retained after reload through the authenticated Fleet instruction gateway",
  );

  restoreConfig();
  assert.ok(
    environment.OPENAI_API_KEY,
    "Configure an OpenAI API key before running live voice verification.",
  );
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${environment.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: "Change the research title to Northern Lights.",
      response_format: "pcm",
    }),
    signal: AbortSignal.timeout(45_000),
  });
  assert.ok(
    response.ok,
    `OpenAI speech generation failed (${response.status}).`,
  );
  const pcm = Buffer.from(await response.arrayBuffer());
  assert.ok(pcm.length > 4800);
  await writeFile(join(artifacts, "speech-24000hz-s16le.pcm"), pcm);
  const session = await createLiveVoiceSession("openai");
  const voiceResult = await page.evaluate(
    ({ session: voice, audio }) => window.transcribe(voice, audio),
    { session, audio: pcm.toString("base64") },
  );
  assert.match(voiceResult.text, /northern lights/iu);
  assert.ok(voiceResult.speechStarts > 0);
  assert.ok(voiceResult.audioChunks > 0);
  report.voice = voiceResult;
  pass(
    "Real OpenAI transcription receives generated speech through production AudioWorklet capture, speech detection, PCM encoding, and the browser connection",
  );
  assert.deepEqual(errors, []);
  report.fleetHttp = fleet.requests;
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.message : String(error);
  if (page) report.pageState = await page.locator("body").innerText();
  throw error;
} finally {
  restoreConfig();
  await browser?.close();
  await fleet?.stop();
  await mcpClientManager.closeAll();
  await unlink(join(codexProfile, "auth.json")).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    },
  );
  report.finishedAt = new Date().toISOString();
  await writeFile(
    join(artifacts, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(`Verification artifacts: ${artifacts}`);
}
