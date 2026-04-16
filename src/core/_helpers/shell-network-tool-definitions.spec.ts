/// <reference types="vitest/globals" />

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();

  return {
    ...actual,
    spawn: spawnMock,
  };
});

import { EventEmitter } from "node:events";
import {
  resolveShellCommandInvocation,
  startDetachedShellCommand,
} from "./shell-network-tool-definitions.ts";

afterEach(() => {
  spawnMock.mockReset();
});

describe("resolveShellCommandInvocation", () => {
  it("adds a non-interactive basic-parsing bootstrap on Windows", () => {
    const invocation = resolveShellCommandInvocation(
      "Invoke-WebRequest https://example.com",
      "win32",
    );

    expect(invocation.shellExecutable).toBe("powershell.exe");
    expect(invocation.shellArgs.slice(0, 3)).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-Command",
    ]);
    expect(invocation.shellArgs[3]).toContain(
      "Invoke-WebRequest:UseBasicParsing",
    );
    expect(invocation.shellArgs[3]).toContain(
      "Invoke-RestMethod:UseBasicParsing",
    );
    expect(invocation.shellArgs[3]).toContain(
      "Invoke-WebRequest https://example.com",
    );
  });

  it("keeps non-Windows shell execution unchanged", () => {
    expect(resolveShellCommandInvocation("echo hello", "linux")).toEqual({
      shellExecutable: "sh",
      shellArgs: ["-lc", "echo hello"],
    });
  });

  it("launches detached commands with ignored stdio and unrefs the child", async () => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      unref: ReturnType<typeof vi.fn>;
    };

    child.pid = 4242;
    child.unref = vi.fn();
    spawnMock.mockReturnValue(child);

    const launchPromise = startDetachedShellCommand(
      "notepad README.md",
      "c:/Development/machdoch",
      "win32",
    );

    child.emit("spawn");

    await expect(launchPromise).resolves.toBe(4242);
    expect(spawnMock).toHaveBeenCalledWith(
      "powershell.exe",
      expect.arrayContaining(["-NoProfile", "-NonInteractive", "-Command"]),
      expect.objectContaining({
        cwd: "c:/Development/machdoch",
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }),
    );
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it("surfaces detached launch failures", async () => {
    const child = new EventEmitter() as EventEmitter & {
      pid?: number;
      unref: ReturnType<typeof vi.fn>;
    };

    child.unref = vi.fn();
    spawnMock.mockReturnValue(child);

    const launchPromise = startDetachedShellCommand(
      "missing-command",
      "c:/Development/machdoch",
      "linux",
    );

    child.emit("error", new Error("spawn sh ENOENT"));

    await expect(launchPromise).rejects.toThrow("spawn sh ENOENT");
    expect(child.unref).not.toHaveBeenCalled();
  });
});
