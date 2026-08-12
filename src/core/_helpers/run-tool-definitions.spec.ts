import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createRunToolDefinitions } from "./run-tool-definitions.js";

const originalAddress = process.env.MACHDOCH_RUN_CONTROL_ADDRESS;
const originalToken = process.env.MACHDOCH_RUN_CONTROL_TOKEN;

afterEach(() => {
  if (originalAddress === undefined) {
    delete process.env.MACHDOCH_RUN_CONTROL_ADDRESS;
  } else {
    process.env.MACHDOCH_RUN_CONTROL_ADDRESS = originalAddress;
  }
  if (originalToken === undefined) {
    delete process.env.MACHDOCH_RUN_CONTROL_TOKEN;
  } else {
    process.env.MACHDOCH_RUN_CONTROL_TOKEN = originalToken;
  }
});

describe.sequential("workspace run tools", () => {
  it("registers only when the desktop control bridge is available", () => {
    delete process.env.MACHDOCH_RUN_CONTROL_ADDRESS;
    delete process.env.MACHDOCH_RUN_CONTROL_TOKEN;
    expect(createRunToolDefinitions()).toEqual([]);
  });

  it("reads live status through the authenticated loopback bridge", async () => {
    const token = "test-token";
    let request: Record<string, unknown> | null = null;
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      let input = "";
      socket.on("data", (chunk: string) => {
        input += chunk;
        const newline = input.indexOf("\n");
        if (newline < 0) return;
        request = JSON.parse(input.slice(0, newline)) as Record<
          string,
          unknown
        >;
        socket.end(
          `${JSON.stringify({
            ok: true,
            result: {
              workspaceRoot: "C:/workspace",
              primaryConfigurationId: "fullstack",
              configurations: [],
            },
          })}\n`,
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP test address.");
    }
    process.env.MACHDOCH_RUN_CONTROL_ADDRESS = `127.0.0.1:${address.port}`;
    process.env.MACHDOCH_RUN_CONTROL_TOKEN = token;
    const tool = createRunToolDefinitions().find(
      (definition) => definition.spec.name === "get_workspace_run_status",
    );
    if (!tool) throw new Error("Expected the status tool.");

    const result = await tool.execute(
      {},
      {
        workspaceRoot: "C:/workspace",
        memory: {
          sessionEnabled: false,
          sessionEntries: [],
          globalEnabled: false,
          globalEntries: [],
        },
      },
    );
    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(request).toMatchObject({
      token,
      action: "status",
      workspaceRoot: "C:/workspace",
    });
    expect(result.toolResult.output).toContain(
      '"primaryConfigurationId": "fullstack"',
    );
  });

  it("marks lifecycle operations as state-changing run tools", () => {
    process.env.MACHDOCH_RUN_CONTROL_ADDRESS = "127.0.0.1:1";
    process.env.MACHDOCH_RUN_CONTROL_TOKEN = "test-token";
    const definitions = createRunToolDefinitions();

    expect(
      definitions
        .filter((definition) => definition.effect === "write")
        .map((definition) => definition.spec.name),
    ).toEqual([
      "start_workspace_run",
      "stop_workspace_run",
      "restart_workspace_run",
    ]);
    expect(
      definitions.every((definition) => definition.backingTool === "run"),
    ).toBe(true);
  });
});
