import { EventEmitter } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createRalphManagedServerCommandFingerprint,
  startRalphManagedServer,
  stopRalphManagedServer,
  readRalphManagedServerOwnership,
  isRalphManagedServerOwnershipAlive,
  stopRalphManagedServerOwnership,
  type RalphManagedServerHandle,
} from "./ralph-managed-server.helper.ts";

const createChild = (pid = 42): ChildProcess => {
  return Object.assign(new EventEmitter(), {
    pid,
    exitCode: null,
    signalCode: null,
    killed: false,
    kill: vi.fn(() => true),
  }) as unknown as ChildProcess;
};

describe("Ralph managed server lifecycle", () => {
  it("stops a process when cancellation arrives during startup", async () => {
    const controller = new AbortController();
    const child = createChild(75);
    const spawnMock = vi.fn(() => {
      queueMicrotask(() => {
        controller.abort(new Error("Run cancelled during startup"));
        child.emit("spawn");
      });
      return child;
    }) as unknown as typeof spawn;
    const killProcessGroup = vi.fn(() => child.emit("exit", 0, null));

    await expect(
      startRalphManagedServer(
        {
          command: "serve",
          cwd: "/workspace",
          signal: controller.signal,
        },
        { platform: "linux", spawn: spawnMock, killProcessGroup },
      ),
    ).rejects.toThrow("Run cancelled during startup");
    expect(killProcessGroup).toHaveBeenCalledWith(75, "SIGTERM");
  });

  it("settles Windows shutdown even when taskkill never emits an event", async () => {
    vi.useFakeTimers();
    try {
      const child = createChild(76);
      const killers: ChildProcess[] = [];
      const spawnMock = vi.fn(() => {
        const killer = createChild(77);
        killers.push(killer);
        return killer;
      }) as unknown as typeof spawn;
      const request = stopRalphManagedServer(
        {
          child,
          pid: 76,
          exited: new Promise(() => {}),
          hasExited: () => false,
        },
        {
          platform: "win32",
          spawn: spawnMock,
          killProcessGroup: vi.fn(),
          shutdownTimeoutMs: 10,
        },
      );
      const assertion = expect(request).rejects.toThrow("timed out");
      await vi.runAllTimersAsync();
      await assertion;
      expect(killers).toHaveLength(2);
      expect(
        killers.every(
          (killer) => vi.mocked(killer.kill).mock.calls.length === 1,
        ),
      ).toBe(true);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps ownership evidence when an adopted Windows process cannot be stopped", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ralph-owner-failure-"));
    try {
      const registryPath = join(directory, "server.json");
      await writeFile(registryPath, "ownership");
      const killer = createChild(78);
      const spawnMock = vi.fn(() => {
        queueMicrotask(() => killer.emit("exit", 1, null));
        return killer;
      }) as unknown as typeof spawn;
      await expect(
        stopRalphManagedServerOwnership(
          {
            ownerId: "run-1",
            pid: 76,
            commandFingerprint: "fingerprint",
            command: "serve",
            cwd: directory,
            startedAt: new Date().toISOString(),
          },
          registryPath,
          { platform: "win32", spawn: spawnMock, killProcessGroup: vi.fn() },
        ),
      ).rejects.toThrow("exit code 1");
      await expect(readFile(registryPath, "utf8")).resolves.toBe("ownership");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fingerprints command and working directory as separate fields", () => {
    expect(createRalphManagedServerCommandFingerprint("c", "a\0b")).not.toBe(
      createRalphManagedServerCommandFingerprint("b\0c", "a"),
    );
  });

  it("starts a configured command through the platform shell", async () => {
    const child = createChild();
    const spawnMock = vi.fn(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    }) as unknown as typeof spawn;

    const handle = await startRalphManagedServer(
      {
        command: "pnpm preview",
        cwd: "C:/workspace",
      },
      {
        platform: "win32",
        spawn: spawnMock,
        killProcessGroup: vi.fn(),
      },
    );

    expect(handle.pid).toBe(42);
    expect(spawnMock).toHaveBeenCalledWith(
      "powershell.exe",
      expect.arrayContaining([
        "-Command",
        expect.stringContaining("pnpm preview"),
      ]),
      expect.objectContaining({
        cwd: "C:/workspace",
        detached: false,
        stdio: "ignore",
        windowsHide: true,
      }),
    );
  });

  it("terminates the detached process group on non-Windows platforms", async () => {
    const child = createChild(73);
    const killProcessGroup = vi.fn();
    const handle: RalphManagedServerHandle = {
      child,
      pid: 73,
      exited: Promise.resolve({ code: null, signal: null }),
      hasExited: () => false,
    };

    await stopRalphManagedServer(handle, {
      platform: "linux",
      spawn: vi.fn() as unknown as typeof spawn,
      killProcessGroup,
    });

    expect(killProcessGroup).toHaveBeenCalledWith(73, "SIGTERM");
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("force kills a non-exiting managed server tree after the grace period", async () => {
    const child = createChild(74);
    const killProcessGroup = vi.fn();
    const handle: RalphManagedServerHandle = {
      child,
      pid: 74,
      exited: new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>(() => undefined),
      hasExited: () => false,
    };

    await stopRalphManagedServer(handle, {
      platform: "linux",
      spawn: vi.fn() as unknown as typeof spawn,
      killProcessGroup,
      shutdownTimeoutMs: 0,
    });

    expect(killProcessGroup.mock.calls).toEqual([
      [74, "SIGTERM"],
      [74, "SIGKILL"],
    ]);
  });

  it("uses taskkill for the full process tree on Windows", async () => {
    const child = createChild(91);
    const killer = createChild(92);
    const spawnMock = vi.fn(() => {
      queueMicrotask(() => killer.emit("exit", 0, null));
      return killer;
    }) as unknown as typeof spawn;
    const handle: RalphManagedServerHandle = {
      child,
      pid: 91,
      exited: Promise.resolve({ code: null, signal: null }),
      hasExited: () => false,
    };

    await stopRalphManagedServer(handle, {
      platform: "win32",
      spawn: spawnMock,
      killProcessGroup: vi.fn(),
    });

    expect(spawnMock).toHaveBeenCalledWith("taskkill", ["/PID", "91", "/T"], {
      stdio: "ignore",
      windowsHide: true,
    });
  });

  it("persists command ownership so only the expected managed build is reused", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ralph-managed-owner-"));
    try {
      const child = createChild(101);
      const spawnMock = vi.fn(() => {
        queueMicrotask(() => child.emit("spawn"));
        return child;
      }) as unknown as typeof spawn;
      const registryPath = join(directory, "server.json");

      const handle = await startRalphManagedServer(
        {
          command: "pnpm preview",
          cwd: directory,
          ownerId: "run-1",
          registryPath,
        },
        {
          platform: "win32",
          spawn: spawnMock,
          killProcessGroup: vi.fn(),
        },
      );

      await expect(
        readRalphManagedServerOwnership(registryPath),
      ).resolves.toMatchObject({
        ownerId: "run-1",
        pid: 101,
        command: "pnpm preview",
        cwd: directory,
      });
      expect(handle.registryPath).toBe(registryPath);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("verifies PID liveness and can terminate an adopted owned process", async () => {
    const ownership = {
      ownerId: "crashed-run",
      pid: 202,
      commandFingerprint: "fingerprint",
      command: "pnpm preview",
      cwd: "C:/workspace",
      startedAt: new Date().toISOString(),
    };
    expect(isRalphManagedServerOwnershipAlive(ownership, vi.fn())).toBe(true);
    expect(
      isRalphManagedServerOwnershipAlive(ownership, () => {
        throw new Error("ESRCH");
      }),
    ).toBe(false);

    const directory = await mkdtemp(join(tmpdir(), "ralph-adopted-server-"));
    try {
      const registryPath = join(directory, "server.json");
      const killer = createChild(203);
      const spawnMock = vi.fn(() => {
        queueMicrotask(() => killer.emit("exit", 0, null));
        return killer;
      }) as unknown as typeof spawn;
      await stopRalphManagedServerOwnership(ownership, registryPath, {
        platform: "win32",
        spawn: spawnMock,
        killProcessGroup: vi.fn(),
      });
      expect(spawnMock).toHaveBeenCalledWith(
        "taskkill",
        ["/PID", "202", "/T", "/F"],
        { stdio: "ignore", windowsHide: true },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
