import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Progress } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFlow, runtimeConfig } from "../__test__/ralph-test-helpers.js";
import type { AgentToolDefinition } from "../_helpers/agent-tools-shared.js";
import { saveManagedSkill } from "../managed-skills.js";
import {
  createLocalToolRuntime,
  type LocalToolRuntimeOptions,
} from "./runtime.js";
import { createLocalMcpServer } from "./server.js";

let root: string;
const cleanup: Array<() => Promise<void>> = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "machdoch-local-mcp-capabilities-"));
  vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", join(root, "user"));
  vi.stubEnv("MACHDOCH_RUN_CONTROL_TOKEN", "");
  vi.stubEnv("MACHDOCH_RUN_CONTROL_ADDRESS", "");
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

const connect = async (
  options: Partial<LocalToolRuntimeOptions> & {
    mode?: "ask" | "machdoch";
  } = {},
) => {
  const { mode = "machdoch", ...runtimeOptions } = options;
  const runtime = createLocalToolRuntime({
    config: {
      ...runtimeConfig,
      provider: "unconfigured" as const,
      workspaceRoot: root,
      mode,
    },
    memory: {
      sessionEnabled: false,
      sessionEntries: [],
      globalEnabled: false,
      globalEntries: [],
    },
    ...runtimeOptions,
  });
  const server = createLocalMcpServer(runtime);
  const client = new Client({ name: "capabilities-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanup.push(
    () => server.close(),
    () => client.close(),
  );
  return client;
};

const workflow = createFlow({
  id: "release-notes",
  name: "Release notes",
  description: "Draft release notes.",
  variables: [
    { name: "version", type: "text", required: true },
    { name: "audience", type: "text", required: true, default: "users" },
  ],
  blocks: [
    { id: "start", type: "START", title: "Start" },
    {
      id: "draft",
      type: "PROMPT",
      title: "Draft",
      prompt: "Draft notes for {{version}} aimed at {{audience}}.",
    },
    { id: "end", type: "END", title: "End", status: "success" },
  ],
  edges: [
    { id: "draft-edge", from: "start", fromOutput: "SUCCESS", to: "draft" },
    { id: "finish", from: "draft", fromOutput: "SUCCESS", to: "end" },
  ],
});

const saveWorkflow = async (client: Client) => {
  const saved = await client.callTool({
    name: "save_workflow",
    arguments: { flow: workflow },
  });
  expect(saved.isError, JSON.stringify(saved.content)).not.toBe(true);
};

describe("Machdoch MCP resources", () => {
  it("lists, reads, and completes skills and workflows", async () => {
    await saveManagedSkill({
      name: "release-review",
      description: "Review a release.",
      content: "# Release review\n\nCheck the changelog.",
      enabled: true,
    });
    const client = await connect();
    await saveWorkflow(client);

    expect(client.getServerCapabilities()).toMatchObject({
      resources: {},
      prompts: {},
      completions: {},
    });
    const { resources } = await client.listResources();
    expect(resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          uri: "machdoch://skills/release-review",
          description: "Review a release.",
          mimeType: "text/markdown",
        }),
        expect.objectContaining({
          uri: "machdoch://workflows/release-notes",
          title: "Workflow: Release notes",
          mimeType: "application/json",
        }),
      ]),
    );
    expect(resources.some((entry) => entry.uri === "machdoch://state")).toBe(
      false,
    );

    const skill = await client.readResource({
      uri: "machdoch://skills/release-review",
    });
    expect(skill.contents).toEqual([
      {
        uri: "machdoch://skills/release-review",
        mimeType: "text/markdown",
        text: "# Release review\n\nCheck the changelog.",
      },
    ]);
    const flow = await client.readResource({
      uri: "machdoch://workflows/release-notes",
    });
    const text = flow.contents[0] && "text" in flow.contents[0]
      ? flow.contents[0].text
      : "";
    expect(JSON.parse(text)).toMatchObject({
      flow: { id: "release-notes" },
      fingerprint: expect.any(String),
    });

    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((entry) => entry.uriTemplate)).toEqual(
      expect.arrayContaining([
        "machdoch://skills/{name}",
        "machdoch://workflows/{id}",
        "machdoch://workflow-runs/{runId}",
        "machdoch://research-projects/{id}",
      ]),
    );
    const completion = await client.complete({
      ref: { type: "ref/resource", uri: "machdoch://workflows/{id}" },
      argument: { name: "id", value: "rel" },
    });
    expect(completion.completion).toEqual({
      values: ["release-notes"],
      total: 1,
      hasMore: false,
    });
  });

  it("rejects unknown and missing resources", async () => {
    const client = await connect();
    await expect(
      client.readResource({ uri: "machdoch://unknown/item" }),
    ).rejects.toThrow("Unknown resource");
    await expect(
      client.readResource({ uri: "machdoch://skills/a/b" }),
    ).rejects.toThrow("Unknown resource");
    await expect(
      client.readResource({ uri: "machdoch://skills/missing" }),
    ).rejects.toThrow("missing or disabled");
  });
});

describe("Machdoch MCP prompts", () => {
  it("turns saved workflows into prompts with their variables", async () => {
    const client = await connect();
    await saveWorkflow(client);

    const { prompts } = await client.listPrompts();
    expect(prompts).toEqual([
      {
        name: "workflow_release-notes",
        title: "Release notes",
        description: "Draft release notes.",
        arguments: [
          { name: "audience", required: false },
          { name: "version", required: true },
        ],
      },
    ]);
    await expect(
      client.getPrompt({ name: "workflow_release-notes", arguments: {} }),
    ).rejects.toThrow("Provide version.");
    await expect(
      client.getPrompt({ name: "workflow_missing" }),
    ).rejects.toThrow("Unknown prompt");

    const prompt = await client.getPrompt({
      name: "workflow_release-notes",
      arguments: { version: "2.0.0", audience: " " },
    });
    const message = prompt.messages[0];
    expect(message?.role).toBe("user");
    const text = message?.content.type === "text" ? message.content.text : "";
    expect(text).toContain("`run_workflow`");
    expect(
      JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)),
    ).toEqual({ id: "release-notes", variables: { version: "2.0.0" } });
  });

  it("omits workflow prompts in ask mode", async () => {
    const client = await connect({ mode: "ask" });
    expect(client.getServerCapabilities()?.prompts).toBeUndefined();
    expect(client.getServerCapabilities()?.resources).toEqual({});
  });
});

describe("Machdoch MCP progress", () => {
  const streamingTool: AgentToolDefinition = {
    spec: {
      name: "fixture_stream",
      description: "Stream output.",
      inputSchema: { type: "object", additionalProperties: false },
    },
    backingTool: "utilities",
    effect: "read",
    riskLevel: "low",
    async execute(_args, context) {
      await context.onOutput?.({ stream: "stdout", chunk: "first\n" });
      await context.onOutput?.({ stream: "stderr", chunk: "second\n" });
      return {
        toolResult: { callId: "", name: "fixture_stream", output: "Done" },
        sections: [],
        traceLines: [],
      };
    },
  };

  it("streams tool output to the host and as progress notifications", async () => {
    const onActionOutput = vi.fn();
    const client = await connect({
      scopedToolDefinitions: [streamingTool],
      onActionOutput,
    });
    const progress: Progress[] = [];
    const result = await client.callTool(
      { name: "fixture_stream", arguments: {} },
      undefined,
      { onprogress: (entry) => progress.push(entry) },
    );

    expect(result.content).toEqual([{ type: "text", text: "Done" }]);
    expect(progress).toEqual([
      { progress: 1, message: "first\n" },
      { progress: 2, message: "second\n" },
    ]);
    expect(onActionOutput.mock.calls.map(([output]) => output)).toEqual([
      { toolName: "fixture_stream", stream: "stdout", chunk: "first\n" },
      { toolName: "fixture_stream", stream: "stderr", chunk: "second\n" },
    ]);
  });

  it("exposes only tools for scoped runtimes without catalog tools", async () => {
    const client = await connect({ scopedToolDefinitions: [streamingTool] });
    expect(client.getServerCapabilities()).toEqual({ tools: {} });
  });
});
