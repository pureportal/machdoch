import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { AppControlSnapshot } from "@machdoch/media-studio/tauri/ui/app-control/app-control-contract.js";
import { createAppControlToolDefinitions } from "./app-control-tool-definitions.js";
import { createAppControlPromptSection } from "./app-control-prompt.js";
import type { ConversationMemoryRuntime } from "./agent-tools-shared.js";

const originalAddress = process.env.MACHDOCH_RUN_CONTROL_ADDRESS;
const originalToken = process.env.MACHDOCH_RUN_CONTROL_TOKEN;

const memory = (appControl: boolean): ConversationMemoryRuntime => ({
  ...(appControl ? { appControl: true } : {}),
  sessionEnabled: false,
  sessionEntries: [],
  globalEnabled: false,
  globalEntries: [],
});

const restoreEnvironment = (): void => {
  for (const [key, value] of [
    ["MACHDOCH_RUN_CONTROL_ADDRESS", originalAddress],
    ["MACHDOCH_RUN_CONTROL_TOKEN", originalToken],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

afterEach(restoreEnvironment);

const startBridge = async (
  respond: (request: Record<string, unknown>) => unknown,
): Promise<{ server: Server; requests: Record<string, unknown>[] }> => {
  const requests: Record<string, unknown>[] = [];
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let input = "";
    socket.on("data", (chunk: string) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(input.slice(0, newline)) as Record<
        string,
        unknown
      >;
      requests.push(request);
      socket.end(`${JSON.stringify(respond(request))}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected a TCP test address.");
  process.env.MACHDOCH_RUN_CONTROL_ADDRESS = `127.0.0.1:${address.port}`;
  process.env.MACHDOCH_RUN_CONTROL_TOKEN = "test-token";
  return { server, requests };
};

describe.sequential("Machdoch app control tools", () => {
  it("are offered only to Quick Chat runs with a desktop bridge", () => {
    process.env.MACHDOCH_RUN_CONTROL_ADDRESS = "127.0.0.1:1";
    process.env.MACHDOCH_RUN_CONTROL_TOKEN = "test-token";
    expect(createAppControlToolDefinitions(memory(false))).toEqual([]);
    expect(
      createAppControlToolDefinitions(memory(true)).map(({ spec, effect }) => [
        spec.name,
        effect,
      ]),
    ).toEqual([
      ["get_machdoch_view", "read"],
      ["run_machdoch_action", "write"],
    ]);
    delete process.env.MACHDOCH_RUN_CONTROL_ADDRESS;
    expect(createAppControlToolDefinitions(memory(true))).toEqual([]);
  });

  it("forwards actions with the run mode and returns the outcome", async () => {
    const { server, requests } = await startBridge(() => ({
      ok: true,
      result: { result: { added: true }, location: ["Media Studio", "Basic"] },
    }));
    const tool = createAppControlToolDefinitions(memory(true))[1]!;
    const result = await tool.execute(
      { action: "media.add_lora", input: { addonId: "lora-1" } },
      { workspaceRoot: "C:/workspace", mode: "machdoch", memory: memory(true) },
    );
    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(requests[0]).toEqual({
      token: "test-token",
      action: "appControl",
      workspaceRoot: "C:/workspace",
      appControl: {
        kind: "run",
        actionId: "media.add_lora",
        input: { addonId: "lora-1" },
        mode: "machdoch",
      },
    });
    expect(JSON.parse(result.toolResult.output)).toEqual({
      result: { added: true },
      location: ["Media Studio", "Basic"],
    });
    expect(result.toolResult.isError).toBeUndefined();
  });

  it("reports bridge failures as tool errors", async () => {
    const { server } = await startBridge(() => ({
      ok: false,
      error: "The Machdoch window did not answer in time.",
    }));
    const tool = createAppControlToolDefinitions(memory(true))[0]!;
    const result = await tool.execute(
      {},
      { workspaceRoot: "C:/workspace", memory: memory(true) },
    );
    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(result.toolResult.isError).toBe(true);
    expect(result.toolResult.output).toContain("did not answer in time");
  });
});

describe("createAppControlPromptSection", () => {
  const view: AppControlSnapshot = {
    location: ["Media Studio", "Basic", "Image"],
    workspaceRoot: "C:/art",
    state: { media: { model: { name: "SDXL Base" } } },
    actions: [
      {
        id: "media.search_civitai",
        description: "Search Civitai.",
        effect: "read",
        input: {
          type: "object",
          properties: {
            query: { type: "string" },
            type: { type: "string", enum: ["LORA", "Checkpoint"] },
          },
          required: ["query"],
        },
      },
      {
        id: "media.add_lora",
        description: "Add a LoRA.",
        effect: "write",
        input: {
          type: "object",
          properties: {
            addonId: { type: "string" },
            strength: { type: "number", minimum: 0, maximum: 2 },
          },
          required: ["addonId"],
        },
      },
    ],
  };

  it("describes the view, its state, and compact action signatures", () => {
    const section = createAppControlPromptSection(view, "machdoch");
    expect(section).toContain(
      "The user sent this message from: Media Studio › Basic › Image.",
    );
    expect(section).toContain(
      "never to files or folders that share the name",
    );
    expect(section).toContain('"name":"SDXL Base"');
    expect(section).toContain("View workspace: C:/art");
    expect(section).toContain(
      '- media.search_civitai(query: string, type?: "LORA"|"Checkpoint"): Search Civitai.',
    );
    expect(section).toContain(
      "- media.add_lora(addonId: string, strength?: number 0..2) [changes]: Add a LoRA.",
    );
  });

  it("lists only read actions in ask mode", () => {
    const section = createAppControlPromptSection(view, "ask");
    expect(section).toContain("read-only");
    expect(section).toContain("media.search_civitai");
    expect(section).not.toContain("media.add_lora");
  });

  it("asks for the live view when none was captured", () => {
    expect(createAppControlPromptSection(undefined, "machdoch")).toContain(
      "Call get_machdoch_view to see what the user is looking at",
    );
  });
});
