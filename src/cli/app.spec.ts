import type { TaskExecutionProgress } from "../core/types.ts";
import { formatExecutionProgressLines, parseCliArgs } from "./app.ts";

describe("parseCliArgs", () => {
  it("returns help when no command or task was provided", () => {
    expect(
      parseCliArgs([], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toEqual({
      command: "help",
      json: false,
      verbose: false,
      workspaceRoot: "C:/workspace",
    });
  });

  it("parses explicit run commands with built-in options", () => {
    expect(
      parseCliArgs(
        [
          "--cwd",
          "C:/repo",
          "--model",
          "gpt-4.5",
          "--mode",
          "auto",
          "--profile",
          "offline",
          "--json",
          "--verbose",
          "run",
          "show",
          "README.md",
        ],
        {
          currentWorkingDirectory: "C:/workspace",
        },
      ),
    ).toEqual({
      command: "run",
      task: "show README.md",
      model: "gpt-4.5",
      mode: "auto",
      profile: "offline",
      json: true,
      verbose: true,
      workspaceRoot: "C:/repo",
    });
  });

  it("treats unknown leading positionals as a task for the run command", () => {
    expect(
      parseCliArgs(["show", "profiles", "-v"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toEqual({
      command: "run",
      task: "show profiles",
      json: false,
      verbose: true,
      workspaceRoot: "C:/workspace",
    });
  });

  it("supports the option terminator so task text can contain flag-like tokens", () => {
    expect(
      parseCliArgs(["run", "--", "--literal", "task"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toEqual({
      command: "run",
      task: "--literal task",
      json: false,
      verbose: false,
      workspaceRoot: "C:/workspace",
    });
  });

  it("supports quick run invocations with explicit task and model flags", () => {
    expect(
      parseCliArgs(
        [
          "--quick",
          "--model",
          "gpt-4.5",
          "--task",
          "create a dockerfile for nginx",
        ],
        {
          currentWorkingDirectory: "C:/workspace",
        },
      ),
    ).toEqual({
      command: "run",
      task: "create a dockerfile for nginx",
      mode: "auto",
      model: "gpt-4.5",
      json: false,
      verbose: false,
      workspaceRoot: "C:/workspace",
    });
  });

  it("enters interactive chat mode when runtime flags are provided without a task", () => {
    expect(
      parseCliArgs(["--model", "gpt-4.5"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toEqual({
      command: "chat",
      model: "gpt-4.5",
      json: false,
      verbose: false,
      workspaceRoot: "C:/workspace",
    });
  });

  it("parses persistent default-model updates", () => {
    expect(
      parseCliArgs(["--default-model", "gpt-4.5"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toEqual({
      command: "set-default-model",
      defaultModel: "gpt-4.5",
      json: false,
      verbose: false,
      workspaceRoot: "C:/workspace",
    });
  });

  it("parses user API key updates", () => {
    expect(
      parseCliArgs(["--set-api", "--provider", "openai", "--key", "sk-live"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toEqual({
      command: "set-api",
      provider: "openai",
      key: "sk-live",
      json: false,
      verbose: false,
      workspaceRoot: "C:/workspace",
    });
  });

  it("rejects invalid modes and missing run tasks", () => {
    expect(() =>
      parseCliArgs(["--mode", "loud"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toThrow("Expected --mode to be followed by safe, ask, or auto.");

    expect(() =>
      parseCliArgs(["run"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toThrow("Expected a task after `machdoch run`.");

    expect(() =>
      parseCliArgs(["--quick", "--mode", "safe", "show README.md"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toThrow("--quick cannot be combined with a non-auto --mode value.");

    expect(() =>
      parseCliArgs(["--set-api", "--provider", "xai", "--key", "sk-live"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toThrow(
      "Expected --provider to be followed by openai, anthropic, or google.",
    );
  });

  it("rejects extra positionals for summary commands instead of silently ignoring them", () => {
    expect(() =>
      parseCliArgs(["config", "extra"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toThrow("Command `config` does not accept positional arguments: extra");
  });
});

describe("formatExecutionProgressLines", () => {
  it("formats terminal progress with reasons and executed tools", () => {
    const progress: TaskExecutionProgress = {
      task: "show README.md",
      mode: "ask",
      state: "completed",
      message: "Executed a safe file inspection.",
      executedTools: ["filesystem"],
      outputSections: [],
      cancellable: false,
      reason: "Verification passed.",
    };

    expect(formatExecutionProgressLines(progress)).toEqual([
      "[completed] Executed a safe file inspection.",
      "reason: Verification passed.",
      "tools: filesystem",
    ]);
  });

  it("keeps non-terminal progress output compact when optional data is absent", () => {
    const progress: TaskExecutionProgress = {
      task: "show README.md",
      mode: "ask",
      state: "resolving-context",
      message:
        "Resolve prompt inputs, workspace paths, and applicable instructions.",
      executedTools: [],
      outputSections: [],
      cancellable: true,
    };

    expect(formatExecutionProgressLines(progress)).toEqual([
      "[resolving-context] Resolve prompt inputs, workspace paths, and applicable instructions.",
    ]);
  });
});
