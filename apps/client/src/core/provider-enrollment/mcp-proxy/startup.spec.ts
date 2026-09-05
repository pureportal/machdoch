import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  discover: vi.fn(),
  close: vi.fn(),
  servers: vi.fn(),
}));
vi.mock("../../mcp/client.js", () => ({
  mcpClientManager: { discoverServer: mocks.discover, closeAll: mocks.close },
}));
vi.mock("../../mcp/config.js", () => ({
  loadMcpConfig: async () => ({}),
  loadUserMcpConfig: async () => ({}),
  listEnabledMcpServers: mocks.servers,
}));
vi.mock("../stdio-server-lifecycle.js", () => ({
  runManagedStdioServer: async (
    factory: (signal: AbortSignal) => Promise<unknown>,
    options: { cleanup: () => Promise<void> },
  ) => {
    try {
      await factory(new AbortController().signal);
    } finally {
      await options.cleanup();
    }
  },
}));

import { runMcpStdioProxy } from "./server.js";

describe("aggregate proxy startup", () => {
  beforeEach(() => {
    mocks.discover.mockReset();
    mocks.close.mockReset();
    mocks.close.mockResolvedValue(undefined);
    mocks.servers.mockReturnValue(
      Array.from({ length: 12 }, (_, i) => ({
        id: `server-${i}`,
        tasks: "disabled",
      })),
    );
  });

  it("starts no more than four upstream discoveries at once", async () => {
    let active = 0;
    let maximum = 0;
    mocks.discover.mockImplementation(async () => {
      active++;
      maximum = Math.max(active, maximum);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return { tools: [], resources: [], resourceTemplates: [], prompts: [] };
    });
    await runMcpStdioProxy("C:/workspace");
    expect(maximum).toBe(4);
    expect(active).toBe(0);
    expect(mocks.discover).toHaveBeenCalledTimes(12);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("cancels active discoveries after a failure and stops starting more servers", async () => {
    let active = 0;
    let cancel = () => {};
    const cancelled = new Promise<void>((resolve) => {
      cancel = resolve;
    });
    mocks.discover.mockImplementation(
      async (_workspace: string, server: { id: string }) => {
        active++;
        try {
          if (server.id === "server-0") throw new Error("catalog failed");
          await cancelled;
          throw new Error("cancelled by shutdown");
        } finally {
          active--;
        }
      },
    );
    mocks.close.mockImplementation(async () => {
      cancel();
    });
    await expect(runMcpStdioProxy("C:/workspace")).rejects.toThrow(
      "catalog failed",
    );
    expect(mocks.discover).toHaveBeenCalledTimes(4);
    expect(mocks.close).toHaveBeenCalledTimes(2);
    expect(active).toBe(0);
  });
});
