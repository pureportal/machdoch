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
import type { RuntimeConfig } from "../runtime-contract.generated.ts";
import { SHELL_TIMEOUT_MS } from "./agent-tools-shared.ts";
import {
  createShellNetworkToolDefinitions,
  isReadOnlyShellCommand,
  resolveShellCommandInvocation,
  startDetachedShellCommand,
} from "./shell-network-tool-definitions.ts";

afterEach(() => {
  spawnMock.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const createRuntimeConfig = (): RuntimeConfig => ({
  workspaceRoot: "c:/Development/machdoch",
  mode: "machdoch",
  provider: "unconfigured",
  model: "gpt-5.5",
  reasoning: "default",
  offline: true,
  compatibility: {},
  providerAvailability: [],
  webSearch: {
    activeProvider: "none",
    providerAvailability: [],
  },
  reviewModel: {
    mode: "base",
  },
});

const createToolContext = (
  chunks: { stream: "stdout" | "stderr"; chunk: string }[] = [],
  workspaceRoot = "c:/Development/machdoch",
) => ({
  workspaceRoot,
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

const getFetchUrlTool = () => {
  const tool = createShellNetworkToolDefinitions(createRuntimeConfig()).find(
    (definition) => definition.spec.name === "fetch_url",
  );

  if (!tool) {
    throw new Error("Expected fetch_url to be registered.");
  }

  return tool;
};

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

  it("normalizes Windows extended-length cwd values for detached commands", async () => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      unref: ReturnType<typeof vi.fn>;
    };

    child.pid = 4243;
    child.unref = vi.fn();
    spawnMock.mockReturnValue(child);

    const launchPromise = startDetachedShellCommand(
      "pnpm --version",
      "\\\\?\\C:\\Development\\machdoch",
      "win32",
    );

    child.emit("spawn");

    await expect(launchPromise).resolves.toBe(4243);
    expect(spawnMock).toHaveBeenCalledWith(
      "powershell.exe",
      expect.arrayContaining(["-NoProfile", "-NonInteractive", "-Command"]),
      expect.objectContaining({
        cwd: "C:\\Development\\machdoch",
      }),
    );
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
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }),
    );
    expect(result.toolResult.output).toContain("STDOUT:\nfirst line");
    expect(result.toolResult.output).toContain("STDERR:\nwarning line");
    expect(result.toolResult.isError).toBeUndefined();
  });

  it("normalizes Windows extended-length cwd values in shell execution and reporting", async () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    const workspaceRoot = "\\\\?\\C:\\Development\\machdoch";
    const expectedCwd =
      process.platform === "win32"
        ? "C:\\Development\\machdoch"
        : workspaceRoot;
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
      { command: "pnpm --version" },
      createToolContext([], workspaceRoot),
    );

    child.emit("close", 0);

    const result = await resultPromise;

    expect(spawnMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        cwd: expectedCwd,
      }),
    );
    expect(result.sections?.find((section) => section.title === "Shell command"))
      .toMatchObject({
        lines: expect.arrayContaining([`cwd: ${expectedCwd}`]),
      });
  });

  it("terminates the process tree when a streaming shell command times out", async () => {
    vi.useFakeTimers();

    const processKillSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("missing process group");
    });
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdout: EventEmitter;
      stderr: EventEmitter;
      killed: boolean;
      kill: ReturnType<typeof vi.fn>;
    };
    const taskkillChild = new EventEmitter();
    const tool = createShellNetworkToolDefinitions(createRuntimeConfig()).find(
      (definition) => definition.spec.name === "run_shell_command",
    );

    child.pid = 4242;
    child.stdout = stdout;
    child.stderr = stderr;
    child.killed = false;
    child.kill = vi.fn(() => {
      child.killed = true;
      return true;
    });
    spawnMock.mockImplementation((command: string) =>
      command === "taskkill" ? taskkillChild : child,
    );

    if (!tool) {
      throw new Error("Expected run_shell_command to be registered.");
    }

    const resultPromise = tool.execute(
      { command: "node hangs.js" },
      createToolContext(),
    );

    await vi.advanceTimersByTimeAsync(SHELL_TIMEOUT_MS);
    child.emit("close", null);

    const result = await resultPromise;

    expect(result.toolResult.isError).toBe(true);
    expect(result.toolResult.output).toContain("Command timed out");

    if (process.platform === "win32") {
      expect(spawnMock).toHaveBeenCalledWith(
        "taskkill",
        ["/PID", "4242", "/T", "/F"],
        expect.objectContaining({
          stdio: "ignore",
          windowsHide: true,
        }),
      );
      expect(child.kill).not.toHaveBeenCalled();
    } else {
      expect(processKillSpy).toHaveBeenCalledWith(-4242, "SIGTERM");
      expect(child.kill).toHaveBeenCalledTimes(1);
    }
  });

  it("terminates the process tree when a streaming shell command is aborted", async () => {
    const processKillSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("missing process group");
    });
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdout: EventEmitter;
      stderr: EventEmitter;
      killed: boolean;
      kill: ReturnType<typeof vi.fn>;
    };
    const taskkillChild = new EventEmitter();
    const controller = new AbortController();
    const tool = createShellNetworkToolDefinitions(createRuntimeConfig()).find(
      (definition) => definition.spec.name === "run_shell_command",
    );

    child.pid = 5252;
    child.stdout = stdout;
    child.stderr = stderr;
    child.killed = false;
    child.kill = vi.fn(() => {
      child.killed = true;
      return true;
    });
    spawnMock.mockImplementation((command: string) =>
      command === "taskkill" ? taskkillChild : child,
    );

    if (!tool) {
      throw new Error("Expected run_shell_command to be registered.");
    }

    const resultPromise = tool.execute(
      { command: "node slow.js" },
      {
        ...createToolContext(),
        signal: controller.signal,
      },
    );

    controller.abort("User requested cancellation.");
    child.emit("close", null, "SIGTERM");

    const result = await resultPromise;

    expect(result.toolResult.isError).toBe(true);
    expect(result.toolResult.output).toContain("User requested cancellation.");

    if (process.platform === "win32") {
      expect(spawnMock).toHaveBeenCalledWith(
        "taskkill",
        ["/PID", "5252", "/T", "/F"],
        expect.objectContaining({
          stdio: "ignore",
          windowsHide: true,
        }),
      );
      expect(child.kill).not.toHaveBeenCalled();
    } else {
      expect(processKillSpy).toHaveBeenCalledWith(-5252, "SIGTERM");
      expect(child.kill).toHaveBeenCalledTimes(1);
    }
  });

  it("reports commands that terminate from a signal as failures", async () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
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
      { command: "node killed.js" },
      createToolContext(),
    );

    stdout.emit("data", "partial output\n");
    child.emit("close", null, "SIGTERM");

    const result = await resultPromise;

    expect(result.toolResult.isError).toBe(true);
    expect(result.toolResult.output).toContain(
      "Command terminated by signal SIGTERM.",
    );
    expect(result.toolResult.output).toContain("partial output");
  });

  it("terminates the command when the output callback throws", async () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
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
      { command: "node noisy.js" },
      {
        ...createToolContext(),
        onOutput: () => {
          throw new Error("sink failed");
        },
      },
    );

    stdout.emit("data", "partial output\n");
    child.emit("close", null, "SIGTERM");

    const result = await resultPromise;

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(result.toolResult.isError).toBe(true);
    expect(result.toolResult.output).toContain(
      "Command output handler failed: sink failed",
    );
    expect(result.toolResult.output).toContain("partial output");
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

describe("fetch_url", () => {
  it("allows HTTP(S) URLs without filtering local or private targets", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html><body>Local page</body></html>", {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
      }),
    );

    const result = await getFetchUrlTool().execute(
      { url: "http://127.0.0.1:8080/page" },
      createToolContext(),
    );

    expect(result.toolResult.isError).toBeUndefined();
    expect(result.toolResult.output).toContain("Local page");
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("rejects oversized responses before returning fetched content", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1_000_001));
        controller.close();
      },
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/plain",
        },
      }),
    );

    const result = await getFetchUrlTool().execute(
      { url: "https://example.com/large.txt" },
      createToolContext(),
    );

    expect(result.toolResult.isError).toBe(true);
    expect(result.toolResult.output).toContain("exceeded");
  });
});
