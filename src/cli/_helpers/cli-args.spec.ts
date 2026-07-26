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
          "--request-id",
          "scheduler-create-1",
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
        requestId: "scheduler-create-1",
      },
    });

    expect(
      parseCliArgs(
        [
          "scheduler",
          "trigger",
          "job-1",
          "--dedupe-key",
          "legacy-trigger-key",
          "--request-id",
          "trigger-request",
        ],
        { currentWorkingDirectory: "C:/workspace" },
      ),
    ).toMatchObject({
      command: "scheduler",
      scheduler: {
        action: "trigger",
        subject: "job-1",
        dedupeKey: "legacy-trigger-key",
        requestId: "trigger-request",
      },
    });
  });

  it("parses Ralph flow guidance for canonical instruction resolution", () => {
    expect(
      parseCliArgs(
        [
          "instructions",
          "resolve",
          "--ralph-flow",
          "build-flow",
          "--flow-scope",
          "workspace",
        ],
        { currentWorkingDirectory: "C:/workspace" },
      ),
    ).toMatchObject({
      command: "instructions",
      instructions: {
        action: "resolve",
        ralphFlow: "build-flow",
        ralphFlowScope: "workspace",
      },
    });
  });

  it("parses explicit instruction-library recovery actions", () => {
    expect(
      parseCliArgs(["instructions", "recovery"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toMatchObject({
      command: "instructions",
      instructions: { action: "recovery-status" },
    });
    expect(
      parseCliArgs(
        [
          "instructions",
          "recovery",
          "restore",
          "--expected-digest",
          "a".repeat(64),
        ],
        { currentWorkingDirectory: "C:/workspace" },
      ),
    ).toMatchObject({
      command: "instructions",
      instructions: {
        action: "recovery-restore",
        expectedDigest: "a".repeat(64),
      },
    });
    expect(
      parseCliArgs(
        [
          "instructions",
          "recovery",
          "export",
          "--expected-digest",
          "b".repeat(64),
          "--include-content",
        ],
        { currentWorkingDirectory: "C:/workspace" },
      ),
    ).toMatchObject({
      command: "instructions",
      instructions: {
        action: "recovery-export",
        expectedDigest: "b".repeat(64),
        includeContent: true,
      },
    });
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

    expect(() =>
      parseCliArgs(["instructions", "validate", "--apply"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toThrow("--apply is only valid for `machdoch mcp cleanup`.");
  });
});
