import { getHelpText, parseCliArgs } from "./cli-args.ts";

describe("cli args public parser", () => {
  it("keeps the existing public help text available", () => {
    expect(getHelpText()).toContain("machdoch ralph watches create");
    expect(getHelpText()).toContain("--context <path>");
  });

  it("parses default chat, explicit run, and repeated context options", () => {
    expect(parseCliArgs([], { currentWorkingDirectory: "C:/workspace" })).toEqual({
      command: "chat",
      json: false,
      verbose: false,
      workspaceRoot: "C:/workspace",
    });

    expect(
      parseCliArgs(
        [
          "--cwd",
          "C:/repo",
          "--context",
          "src",
          "--context",
          "src",
          "run",
          "review",
          "changes",
        ],
        { currentWorkingDirectory: "C:/workspace" },
      ),
    ).toEqual({
      command: "run",
      task: "review changes",
      contextPaths: ["src"],
      json: false,
      verbose: false,
      workspaceRoot: "C:/repo",
    });
  });

  it("parses Ralph and scheduler command options with numeric boundaries", () => {
    expect(
      parseCliArgs(
        ["ralph", "run", "flow-one", "--max-transitions", "1"],
        { currentWorkingDirectory: "C:/workspace" },
      ),
    ).toMatchObject({
      command: "ralph",
      ralph: {
        action: "run",
        subject: "flow-one",
        maxTransitions: 1,
      },
    });

    expect(
      parseCliArgs(
        [
          "scheduler",
          "create",
          "--interval-ms",
          "1",
          "--prompt",
          "review",
          "--retry-factor",
          "0.5",
        ],
        { currentWorkingDirectory: "C:/workspace" },
      ),
    ).toMatchObject({
      command: "scheduler",
      scheduler: {
        action: "create",
        intervalMs: 1,
        prompt: "review",
        retryFactor: 0.5,
      },
    });
  });

  it("parses Ralph flow instruction scope options", () => {
    expect(
      parseCliArgs(
        [
          "instructions",
          "create",
          "Flow Rules",
          "--scope",
          "ralph-flow",
          "--ralph-flow",
          "build-flow",
          "--flow-scope",
          "workspace",
          "--prompt",
          "Keep flow steps focused.",
        ],
        { currentWorkingDirectory: "C:/workspace" },
      ),
    ).toMatchObject({
      command: "instructions",
      instructions: {
        action: "create",
        subject: "Flow Rules",
        scope: "ralph-flow",
        ralphFlow: "build-flow",
        ralphFlowScope: "workspace",
        prompt: "Keep flow steps focused.",
      },
    });

    expect(() =>
      parseCliArgs(
        [
          "instructions",
          "create",
          "Flow Rules",
          "--scope",
          "ralph-flow",
          "--prompt",
          "Keep flow steps focused.",
        ],
        { currentWorkingDirectory: "C:/workspace" },
      ),
    ).toThrow("Ralph flow instruction scope requires --ralph-flow.");
  });

  it("rejects invalid empty, conflicting, and out-of-range inputs", () => {
    expect(() =>
      parseCliArgs(["--task", "run", "extra"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toThrow("Use either positional task text or --task, not both.");

    expect(() =>
      parseCliArgs(["--image", ""], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toThrow("Expected --image to be followed by an image file path.");

    expect(() =>
      parseCliArgs(["ralph", "run", "flow-one", "--max-transitions", "0"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toThrow("Expected --max-transitions to be followed by a positive integer.");

    expect(() =>
      parseCliArgs(["scheduler", "create", "--interval-ms", "0", "--prompt", "x"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toThrow("Expected --interval-ms to be followed by a positive integer.");
  });
});
