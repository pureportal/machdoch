import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runManagedStdioServer } from "./stdio-server-lifecycle.js";

const createServer = () =>
  new Server({ name: "lifecycle-test", version: "1" }, { capabilities: {} });

describe("CLI stdio lifecycle", () => {
  it("closes upstream processes and removes listeners when the parent closes stdin", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const server = createServer();
    const close = vi.spyOn(server, "close");
    const cleanup = vi.fn(async () => {});
    const signalListeners = process.listenerCount("SIGTERM");
    const running = runManagedStdioServer(() => server, {
      stdin,
      stdout,
      cleanup,
    });
    await vi.waitFor(() =>
      expect(stdin.listenerCount("data")).toBeGreaterThan(0),
    );
    stdin.end();
    await running;
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(stdin.listenerCount("data")).toBe(0);
    expect(stdin.listenerCount("end")).toBe(0);
    expect(stdout.listenerCount("error")).toBe(0);
    expect(process.listenerCount("SIGTERM")).toBe(signalListeners);
    stdout.destroy();
  });

  it("coalesces parent output errors and closes servers created after cancellation", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let finish = (_server: Server) => {};
    let signal: AbortSignal | undefined;
    const startup = new Promise<Server>((resolve) => {
      finish = resolve;
    });
    const server = createServer();
    const close = vi.spyOn(server, "close");
    const connect = vi.spyOn(server, "connect");
    const cleanup = vi.fn(async () => {});
    const running = runManagedStdioServer(
      (incoming) => {
        signal = incoming;
        return startup;
      },
      { stdin, stdout, cleanup },
    );
    stdout.emit("error", new Error("parent disconnected"));
    stdout.emit("error", new Error("another pending write failed"));
    expect(signal?.aborted).toBe(true);
    finish(server);
    await running;
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(connect).not.toHaveBeenCalled();
    stdin.destroy();
    stdout.destroy();
  });

  it("cleans up upstream servers after discovery or transport startup fails", async () => {
    for (const stage of ["discovery", "connect"]) {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const cleanup = vi.fn(async () => {});
      const server = createServer();
      const close = vi.spyOn(server, "close");
      vi.spyOn(server, "connect").mockRejectedValue(
        new Error("connect failed"),
      );
      await expect(
        runManagedStdioServer(
          () => {
            if (stage === "discovery") throw new Error("discovery failed");
            return server;
          },
          { stdin, stdout, cleanup },
        ),
      ).rejects.toThrow(`${stage} failed`);
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(stage === "connect" ? 1 : 0);
      expect(stdin.listenerCount("error")).toBe(0);
      stdin.destroy();
      stdout.destroy();
    }
  });

  it("skips startup when the parent pipe is already closed", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    stdin.destroy();
    const factory = vi.fn(createServer);
    const cleanup = vi.fn(async () => {});
    await runManagedStdioServer(factory, { stdin, stdout, cleanup });
    expect(factory).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
    stdout.destroy();
  });
});
