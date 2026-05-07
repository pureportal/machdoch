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
import type { RuntimeConfig } from "../types.ts";
import {
  createShellNetworkToolDefinitions,
  isReadOnlyShellCommand,
  resolveShellCommandInvocation,
  startDetachedShellCommand,
} from "./shell-network-tool-definitions.ts";

afterEach(() => {
  spawnMock.mockReset();
});

const createRuntimeConfig = (): RuntimeConfig => ({
  workspaceRoot: "c:/Development/machdoch",
  availableProfiles: [],
  mode: "auto",
  enabledTools: ["shell"],
  provider: "unconfigured",
  model: "gpt-5.5",
  offline: true,
  compatibility: {},
  providerAvailability: [],
  webSearch: {
    activeProvider: "none",
    providerAvailability: [],
  },
});

const createToolContext = (
  chunks: { stream: "stdout" | "stderr"; chunk: string }[] = [],
) => ({
  workspaceRoot: "c:/Development/machdoch",
  memory: {
    sessionEnabled: false,
    sessionEntries: [],
    globalEnabled: false,
    globalEntries: [],
  },
  onOutput: (output: { stream: "stdout" | "stderr"; chunk: string }) => {
    chunks.push(output);
  },
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

describe("run_shell_command", () => {
  it("streams stdout and stderr chunks while preserving the final result", async () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    const chunks: { stream: "stdout" | "stderr"; chunk: string }[] = [];
    const tool = createShellNetworkToolDefinitions(createRuntimeConfig()).find(
      (definition) => definition.spec.name === "run_shell_command",
    );

    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = vi.fn();
    spawnMock.mockReturnValue(child);

    if (!tool) {
      throw new Error("Expected run_shell_command to be registered.");
    }

    const resultPromise = tool.execute(
      { command: "node script.js" },
      createToolContext(chunks),
    );

    stdout.emit("data", "first line\n");
    stderr.emit("data", Buffer.from("warning line\n"));
    child.emit("close", 0);

    const result = await resultPromise;

    expect(chunks).toEqual([
      { stream: "stdout", chunk: "first line\n" },
      { stream: "stderr", chunk: "warning line\n" },
    ]);
    const expectedExecutable =
      process.platform === "win32" ? "powershell.exe" : "sh";
    const expectedArgs =
      process.platform === "win32"
        ? expect.arrayContaining(["-NoProfile", "-NonInteractive", "-Command"])
        : ["-lc", "node script.js"];

    expect(spawnMock).toHaveBeenCalledWith(
      expectedExecutable,
      expectedArgs,
      expect.objectContaining({
        cwd: "c:/Development/machdoch",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }),
    );
    expect(result.toolResult.output).toContain("STDOUT:\nfirst line");
    expect(result.toolResult.output).toContain("STDERR:\nwarning line");
    expect(result.toolResult.isError).toBeUndefined();
  });
});

describe("isReadOnlyShellCommand", () => {
  it("allows simple inspection commands", () => {
    expect(isReadOnlyShellCommand({ command: "rg plan src" })).toBe(true);
    expect(isReadOnlyShellCommand({ command: "git status --short" })).toBe(
      true,
    );
    expect(isReadOnlyShellCommand({ command: "Get-Content README.md" })).toBe(
      true,
    );
  });

  it("rejects pipelines, redirection, and command chaining", () => {
    expect(
      isReadOnlyShellCommand({
        command: "dir | Tee-Object plan-mode-check.txt",
      }),
    ).toBe(false);
    expect(
      isReadOnlyShellCommand({ command: "rg plan src > plan-mode-check.txt" }),
    ).toBe(false);
    expect(
      isReadOnlyShellCommand({ command: "git status; npm test" }),
    ).toBe(false);
  });

  it("rejects commands with write-capable options", () => {
    expect(
      isReadOnlyShellCommand({
        command: "git diff --output=plan-mode-check.patch",
      }),
    ).toBe(false);
    expect(
      isReadOnlyShellCommand({
        command: "rg plan src --pre node",
      }),
    ).toBe(false);
  });

  it("rejects obvious out-of-workspace path forms", () => {
    expect(
      isReadOnlyShellCommand({
        command: "Get-Content C:\\Users\\someone\\.ssh\\id_rsa",
      }),
    ).toBe(false);
    expect(
      isReadOnlyShellCommand({ command: "cat ../outside-workspace.txt" }),
    ).toBe(false);
    expect(isReadOnlyShellCommand({ command: "ls /etc" })).toBe(false);
    expect(
      isReadOnlyShellCommand({ command: "type %USERPROFILE%\\.ssh\\config" }),
    ).toBe(false);
  });
});
