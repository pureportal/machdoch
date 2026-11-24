import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { AppControlSnapshot } from "@machdoch/media-studio/tauri/ui/app-control/app-control-contract.js";
import { createMediaStudioToolDefinitions } from "./media-studio-tool-definitions.js";
import type { ConversationMemoryRuntime } from "./agent-tools-shared.js";

const originalAddress = process.env.MACHDOCH_RUN_CONTROL_ADDRESS;
const originalToken = process.env.MACHDOCH_RUN_CONTROL_TOKEN;

const memory: ConversationMemoryRuntime = {
  sessionEnabled: false,
  sessionEntries: [],
  globalEnabled: false,
  globalEntries: [],
};

const action = (id: string) => ({
  id,
  description: id,
  effect: "write" as const,
  input: { type: "object" as const, properties: {} },
});

const chatView: AppControlSnapshot = {
  location: ["Chat"],
  workspaceRoot: null,
  state: { app: { view: "chat" } },
  actions: [action("app.open_view")],
};

const mediaView: AppControlSnapshot = {
  location: ["Media Studio", "Basic"],
  workspaceRoot: null,
  state: {
    app: { view: "media" },
    media: { target: "mesh" },
    "media-basic": { generation: { ready: true } },
  },
  actions: [action("app.open_view"), action("media.run_generation")],
};

afterEach(() => {
  for (const [key, value] of [
    ["MACHDOCH_RUN_CONTROL_ADDRESS", originalAddress],
    ["MACHDOCH_RUN_CONTROL_TOKEN", originalToken],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

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
      const request = JSON.parse(input.slice(0, newline)) as Record<string, unknown>;
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

const closeBridge = (server: Server): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));

const appControlOf = (request: Record<string, unknown>) =>
  request.appControl as Record<string, unknown>;

describe("Media Studio tools", () => {
  it("are offered to every chat with a desktop bridge", () => {
    delete process.env.MACHDOCH_RUN_CONTROL_ADDRESS;
    expect(createMediaStudioToolDefinitions()).toEqual([]);
    process.env.MACHDOCH_RUN_CONTROL_ADDRESS = "127.0.0.1:1";
    process.env.MACHDOCH_RUN_CONTROL_TOKEN = "test-token";
    expect(
      createMediaStudioToolDefinitions().map(({ spec, effect }) => [spec.name, effect]),
    ).toEqual([
      ["get_media_studio", "read"],
      ["run_media_studio_action", "write"],
    ]);
  });

  it("opens Media Studio before running a media action", async () => {
    let opened = false;
    const { server, requests } = await startBridge((request) => {
      const appControl = appControlOf(request);
      if (appControl.kind === "snapshot")
        return { ok: true, result: opened ? mediaView : chatView };
      if (appControl.actionId === "app.open_view") {
        opened = true;
        return { ok: true, result: { result: { view: "Media Studio" }, location: [] } };
      }
      return {
        ok: true,
        result: { result: { runId: "run-1", status: "succeeded" }, location: ["Media Studio"] },
      };
    });
    const tool = createMediaStudioToolDefinitions()[1]!;
    const result = await tool.execute(
      { action: "media.run_generation", input: {} },
      { workspaceRoot: "C:/workspace", mode: "machdoch", memory },
    );
    await closeBridge(server);

    expect(requests.map(appControlOf)).toEqual([
      { kind: "snapshot" },
      { kind: "run", actionId: "app.open_view", input: { view: "media" }, mode: "machdoch" },
      { kind: "snapshot" },
      { kind: "run", actionId: "media.run_generation", input: {}, mode: "machdoch" },
    ]);
    expect(JSON.parse(result.toolResult.output)).toEqual({
      result: { runId: "run-1", status: "succeeded" },
      location: ["Media Studio"],
    });
  });

  it("returns only Media Studio state and actions", async () => {
    const { server, requests } = await startBridge(() => ({ ok: true, result: mediaView }));
    const tool = createMediaStudioToolDefinitions()[0]!;
    const result = await tool.execute({}, { workspaceRoot: "C:/workspace", memory });
    await closeBridge(server);

    expect(requests).toHaveLength(1);
    expect(JSON.parse(result.toolResult.output)).toEqual({
      location: ["Media Studio", "Basic"],
      state: {
        media: { target: "mesh" },
        "media-basic": { generation: { ready: true } },
      },
      actions: [action("media.run_generation")],
    });
  });

  it("reports a view that cannot open as a tool error", async () => {
    const { server } = await startBridge((request) =>
      appControlOf(request).kind === "snapshot"
        ? { ok: true, result: chatView }
        : { ok: false, error: "The user has unsaved changes." },
    );
    const tool = createMediaStudioToolDefinitions()[0]!;
    const result = await tool.execute({}, { workspaceRoot: "C:/workspace", memory });
    await closeBridge(server);

    expect(result.toolResult.isError).toBe(true);
    expect(result.toolResult.output).toContain("unsaved changes");
  });
});
