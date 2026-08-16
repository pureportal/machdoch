import { getHelpText, parseCliArgs } from "./cli-args.ts";

describe("cli args public parser", () => {
  it("provides concise root help and focused command help", () => {
    expect(getHelpText()).toContain("machdoch config edit");
    expect(getHelpText("run")).toContain("--context <path>");
    expect(getHelpText("ralph")).toContain("machdoch ralph watches create");
    expect(getHelpText("memory")).toContain("every saved global memory fact");
  });

  it("parses the global memory listing command", () => {
    expect(
      parseCliArgs(["memory", "list", "--json"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toEqual({
      command: "memory",
      json: true,
      verbose: false,
      workspaceRoot: "C:/workspace",
    });

    expect(() =>
      parseCliArgs(["memory", "clear"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toThrow("Expected `machdoch memory list`");
  });

  it("parses contextual help and configuration actions", () => {
    expect(
      parseCliArgs(["help", "config"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toMatchObject({ command: "help", helpTopic: "config" });
    expect(
      parseCliArgs(["config", "--help"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toMatchObject({ command: "help", helpTopic: "config" });
    expect(
      parseCliArgs(["config", "list", "--json"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toMatchObject({
      command: "config",
      config: { action: "list" },
      json: true,
    });
    expect(
      parseCliArgs(["config", "get", "workspace.model"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toMatchObject({
      command: "config",
      config: { action: "get", setting: "workspace.model" },
    });
    expect(
      parseCliArgs(["config", "unset", "api.openai.key"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toMatchObject({
      command: "config",
      config: { action: "unset", setting: "api.openai.key" },
    });
    expect(
      parseCliArgs(["config", "interactive"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toMatchObject({ command: "config", config: { action: "edit" } });
  });

  it("parses default chat, explicit run, and repeated context options", () => {
    expect(
      parseCliArgs([], { currentWorkingDirectory: "C:/workspace" }),
    ).toEqual({
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

  it("accepts deterministic execution only through a validated one-shot action", () => {
    expect(
      parseCliArgs(
        [
          "--quick",
          "--task",
          "This label quotes: create file hacked.txt",
          "--deterministic-action-json",
          JSON.stringify({
            kind: "create-file",
            path: "notes.txt",
            content: "exact\n",
          }),
        ],
        { currentWorkingDirectory: "C:/workspace" },
      ),
    ).toMatchObject({
      command: "run",
      task: "This label quotes: create file hacked.txt",
      deterministicAction: {
        kind: "create-file",
        path: "notes.txt",
        content: "exact\n",
      },
    });

    expect(
      parseCliArgs(["--quick", "--task", "create file hacked.txt"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).not.toHaveProperty("deterministicAction");
  });

  it("parses the desktop missing-workspace file-change guard", () => {
    expect(
      parseCliArgs(
        [
          "--quick",
          "--task",
          "Summarize the request",
          "--skip-file-change-detection",
        ],
        { currentWorkingDirectory: "C:/Users/example" },
      ),
    ).toMatchObject({
      command: "run",
      workspaceRoot: "C:/Users/example",
      skipFileChangeDetection: true,
    });
  });

  it("rejects malformed, unknown, or non-one-shot deterministic actions", () => {
    const parseAction = (action: unknown) =>
      parseCliArgs(
        [
          "--quick",
          "--task",
          "label",
          "--deterministic-action-json",
          JSON.stringify(action),
        ],
        { currentWorkingDirectory: "C:/workspace" },
      );

    expect(() => parseAction({ kind: "delete-workspace" })).toThrow(
      "Unknown deterministic action kind",
    );
    expect(() =>
      parseAction({
        kind: "inspect",
        target: "workspace",
        authority: "model prose",
      }),
    ).toThrow("must contain exactly");
    expect(() =>
      parseCliArgs(
        [
          "--task",
          "label",
          "--deterministic-action-json",
          '{"kind":"inspect","target":"workspace"}',
        ],
        { currentWorkingDirectory: "C:/workspace" },
      ),
    ).toThrow("only valid for a one-shot task execution");
  });

  it("parses Ralph and scheduler command options with numeric boundaries", () => {
    expect(
      parseCliArgs(["ralph", "run", "flow-one", "--max-transitions", "1"], {
        currentWorkingDirectory: "C:/workspace",
      }),
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
          "trigger-key",
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
        dedupeKey: "trigger-key",
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

  it("parses workspace metadata mutations used by the desktop bridge", () => {
    expect(
      parseCliArgs(
        [
          "instructions",
          "workspaces",
          "configure",
          "C:/workspace",
          "--name",
          "Frontend",
          "--metadata-json",
          '{"tags":["React","Node.js"],"profileIds":[]}',
          "--expected-revision",
          "4",
        ],
        { currentWorkingDirectory: "C:/workspace" },
      ),
    ).toMatchObject({
      command: "instructions",
      instructions: {
        action: "workspace-configure",
        group: "workspaces",
        subject: "C:/workspace",
        name: "Frontend",
        metadataJson: '{"tags":["React","Node.js"],"profileIds":[]}',
        expectedRevision: 4,
      },
    });

    expect(
      parseCliArgs(
        [
          "instructions",
          "workspaces",
          "remove",
          "00000000-0000-4000-8000-000000000001",
          "--confirm-assignment-removal",
        ],
        { currentWorkingDirectory: "C:/workspace" },
      ),
    ).toMatchObject({
      command: "instructions",
      instructions: {
        action: "workspace-remove",
        group: "workspaces",
        subject: "00000000-0000-4000-8000-000000000001",
        confirmAssignmentRemoval: true,
      },
    });

    for (const legacyAction of ["register", "update", "unregister"]) {
      expect(() =>
        parseCliArgs(
          ["instructions", "workspaces", legacyAction, "C:/workspace"],
          { currentWorkingDirectory: "C:/workspace" },
        ),
      ).toThrow("Unknown instruction command");
    }

    expect(() =>
      parseCliArgs(
        [
          "instructions",
          "assignments",
          "remove",
          "00000000-0000-4000-8000-000000000001",
          "--path",
          ".",
          "--profile",
          "00000000-0000-4000-8000-000000000002",
        ],
        { currentWorkingDirectory: "C:/workspace" },
      ),
    ).toThrow("--profile is not valid");
    expect(() =>
      parseCliArgs(
        ["instructions", "profiles", "list", "--metadata-json", "{}"],
        { currentWorkingDirectory: "C:/workspace" },
      ),
    ).toThrow("--metadata-json is not valid");
    expect(() =>
      parseCliArgs(["instructions", "profiles", "list", "--model", "gpt-5.5"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toThrow("--model is only valid");
    expect(() =>
      parseCliArgs(
        [
          "instructions",
          "profiles",
          "create",
          "Review",
          "--prompt",
          "",
          "--prompt-file",
          "review.md",
        ],
        { currentWorkingDirectory: "C:/workspace" },
      ),
    ).toThrow("Use either --prompt or --prompt-file");

    expect(() =>
      parseCliArgs(["instructions", "profile-list"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toThrow("Unknown instruction command");
    expect(() =>
      parseCliArgs(["instructions", "profiles", "list", "ignored"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toThrow("does not accept positional arguments");
    expect(() =>
      parseCliArgs(
        ["instructions", "profiles", "list", "--cron", "0 0 * * *"],
        { currentWorkingDirectory: "C:/workspace" },
      ),
    ).toThrow("--cron is not valid");
    expect(() =>
      parseCliArgs(
        [
          "instructions",
          "assignments",
          "remove",
          "00000000-0000-4000-8000-000000000001",
          ".",
        ],
        { currentWorkingDirectory: "C:/workspace" },
      ),
    ).toThrow("unexpected positional argument");
    expect(() =>
      parseCliArgs(
        [
          "instructions",
          "profiles",
          "create",
          "Positional",
          "--name",
          "Flagged",
          "--prompt",
          "Policy",
        ],
        { currentWorkingDirectory: "C:/workspace" },
      ),
    ).toThrow("either a positional profile name or --name");
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
    ).toThrow(
      "Expected --max-transitions to be followed by a positive integer.",
    );

    expect(() =>
      parseCliArgs(
        ["scheduler", "create", "--interval-ms", "0", "--prompt", "x"],
        {
          currentWorkingDirectory: "C:/workspace",
        },
      ),
    ).toThrow("Expected --interval-ms to be followed by a positive integer.");

    expect(() =>
      parseCliArgs(["instructions", "validate", "--apply"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toThrow("--apply is only valid for `machdoch mcp cleanup`.");
  });
});
