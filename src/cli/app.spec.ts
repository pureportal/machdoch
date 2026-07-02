import type { TaskExecutionProgress } from "../core/types.ts";
import { parseCliArgs } from "./_helpers/cli-args.ts";
import { formatExecutionProgressLines } from "./_helpers/cli-output.ts";
import { createUserConfigSummaryLines } from "./_helpers/cli-output.ts";

describe("parseCliArgs", () => {
  it("enters interactive chat when no command or task was provided", () => {
    expect(
      parseCliArgs([], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toEqual({
      command: "chat",
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
          "machdoch",
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
      mode: "machdoch",
      json: true,
      verbose: true,
      workspaceRoot: "C:/repo",
    });
  });

  it("treats unknown leading positionals as the initial interactive chat task", () => {
    expect(
      parseCliArgs(["show", "status", "-v"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toEqual({
      command: "chat",
      task: "show status",
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

  it("supports quick one-shot invocations with explicit task and model flags", () => {
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
      model: "gpt-4.5",
      json: false,
      verbose: false,
      workspaceRoot: "C:/workspace",
    });
  });

  it("parses repeated task context paths for quick one-shot invocations", () => {
    expect(
      parseCliArgs(
        [
          "--quick",
          "--context",
          "README.md",
          "--context",
          "src/core",
          "--task",
          "summarize the selected context",
        ],
        {
          currentWorkingDirectory: "C:/workspace",
        },
      ),
    ).toEqual({
      command: "run",
      task: "summarize the selected context",
      contextPaths: ["README.md", "src/core"],
      json: false,
      verbose: false,
      workspaceRoot: "C:/workspace",
    });
  });

  it("parses repeated image attachments for quick one-shot invocations", () => {
    expect(
      parseCliArgs(
        [
          "--quick",
          "--image",
          "screen.png",
          "--image",
          "mockup.webp",
          "--task",
          "describe the screenshots",
        ],
        {
          currentWorkingDirectory: "C:/workspace",
        },
      ),
    ).toEqual({
      command: "run",
      task: "describe the screenshots",
      imagePaths: ["screen.png", "mockup.webp"],
      json: false,
      verbose: false,
      workspaceRoot: "C:/workspace",
    });
  });

  it("parses task context paths on explicit run commands", () => {
    expect(
      parseCliArgs(["run", "--context", "src/core", "review", "the code"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toEqual({
      command: "run",
      task: "review the code",
      contextPaths: ["src/core"],
      json: false,
      verbose: false,
      workspaceRoot: "C:/workspace",
    });
  });

  it("supports desktop bridge JSON one-shot invocations with --task", () => {
    expect(
      parseCliArgs(
        [
          "--quick",
          "--json",
          "--verbose",
          "--cwd",
          "C:/workspace",
          "--task",
          "How is the weather?",
        ],
        {
          currentWorkingDirectory: "C:/fallback",
        },
      ),
    ).toEqual({
      command: "run",
      task: "How is the weather?",
      json: true,
      verbose: true,
      workspaceRoot: "C:/workspace",
    });
  });

  it("uses --task as an initial interactive chat task unless --quick is set", () => {
    expect(
      parseCliArgs(["--task", "create a dockerfile for nginx"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toEqual({
      command: "chat",
      task: "create a dockerfile for nginx",
      json: false,
      verbose: false,
      workspaceRoot: "C:/workspace",
    });
  });

  it("allows context paths to seed interactive chat without an initial task", () => {
    expect(
      parseCliArgs(["--context", "docs/brief.md"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toEqual({
      command: "chat",
      contextPaths: ["docs/brief.md"],
      json: false,
      verbose: false,
      workspaceRoot: "C:/workspace",
    });
  });

  it("parses session and global memory overrides for run and chat flows", () => {
    expect(
      parseCliArgs(
        [
          "--session-memory",
          "off",
          "--global-memory",
          "off",
          "run",
          "summarize",
          "changes",
        ],
        {
          currentWorkingDirectory: "C:/workspace",
        },
      ),
    ).toEqual({
      command: "run",
      task: "summarize changes",
      sessionMemoryEnabled: false,
      globalMemoryEnabled: false,
      json: false,
      verbose: false,
      workspaceRoot: "C:/workspace",
    });

    expect(
      parseCliArgs(["--global-memory", "on", "--model", "gpt-4.5"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toEqual({
      command: "chat",
      globalMemoryEnabled: true,
      model: "gpt-4.5",
      json: false,
      verbose: false,
      workspaceRoot: "C:/workspace",
    });
  });

  it("parses agent loop limit overrides", () => {
    expect(
      parseCliArgs(
        [
          "--executor-turns",
          "128",
          "--autopilot-iterations",
          "24",
          "run",
          "fix",
          "the",
          "bug",
        ],
        {
          currentWorkingDirectory: "C:/workspace",
        },
      ),
    ).toEqual({
      command: "run",
      task: "fix the bug",
      agentLimits: {
        executorTurns: 128,
        autopilotExecutorIterations: 24,
      },
      json: false,
      verbose: false,
      workspaceRoot: "C:/workspace",
    });

    expect(
      parseCliArgs(["--infinite", "--task", "keep working"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toEqual({
      command: "chat",
      task: "keep working",
      agentLimits: {
        infinite: true,
      },
      json: false,
      verbose: false,
      workspaceRoot: "C:/workspace",
    });
  });

  it("parses persistent global-memory updates", () => {
    expect(
      parseCliArgs(["--set-global-memory", "on"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toEqual({
      command: "set-global-memory",
      setGlobalMemoryEnabled: true,
      json: false,
      verbose: false,
      workspaceRoot: "C:/workspace",
    });
  });

  it("allows quick invocations to keep an explicit runtime mode", () => {
    expect(
      parseCliArgs(["--quick", "--mode", "ask", "show", "README.md"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toEqual({
      command: "run",
      task: "show README.md",
      mode: "ask",
      json: false,
      verbose: false,
      workspaceRoot: "C:/workspace",
    });

    expect(
      parseCliArgs(["--quick", "--mode", "machdoch", "--task", "fix the bug"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toEqual({
      command: "run",
      task: "fix the bug",
      mode: "machdoch",
      json: false,
      verbose: false,
      workspaceRoot: "C:/workspace",
    });
  });

  it("parses explicit runtime provider overrides for shared execution", () => {
    expect(
      parseCliArgs(
        [
          "--runtime-provider",
          "anthropic",
          "--model",
          "claude-sonnet-4-20250514",
          "run",
          "inspect",
          "config",
        ],
        {
          currentWorkingDirectory: "C:/workspace",
        },
      ),
    ).toEqual({
      command: "run",
      task: "inspect config",
      runtimeProvider: "anthropic",
      model: "claude-sonnet-4-20250514",
      json: false,
      verbose: false,
      workspaceRoot: "C:/workspace",
    });
  });

  it("parses scheduler list as the default scheduler action", () => {
    expect(
      parseCliArgs(["--json", "--cwd", "C:/repo", "scheduler"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toEqual({
      command: "scheduler",
      scheduler: {
        action: "list",
      },
      json: true,
      verbose: false,
      workspaceRoot: "C:/repo",
    });
  });

  it("parses MCP management commands", () => {
    expect(
      parseCliArgs(["--json", "--cwd", "C:/repo", "mcp"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toEqual({
      command: "mcp",
      mcp: {
        action: "servers",
      },
      json: true,
      verbose: false,
      workspaceRoot: "C:/repo",
    });

    expect(
      parseCliArgs(["mcp", "oauth-authorize", "github"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toEqual({
      command: "mcp",
      mcp: {
        action: "oauth-authorize",
        serverId: "github",
      },
      json: false,
      verbose: false,
      workspaceRoot: "C:/workspace",
    });

    expect(
      parseCliArgs(
        [
          "mcp",
          "call-tool",
          "serper",
          "search",
          "--arguments-json",
          '{"q":"model context protocol"}',
        ],
        {
          currentWorkingDirectory: "C:/workspace",
        },
      ),
    ).toEqual({
      command: "mcp",
      mcp: {
        action: "call-tool",
        serverId: "serper",
        target: "search",
        argumentsJson: '{"q":"model context protocol"}',
      },
      json: false,
      verbose: false,
      workspaceRoot: "C:/workspace",
    });

    expect(
      parseCliArgs(
        [
          "mcp",
          "oauth-finish",
          "github",
          "http://127.0.0.1:43110/oauth/callback?code=abc&state=xyz",
        ],
        {
          currentWorkingDirectory: "C:/workspace",
        },
      ),
    ).toEqual({
      command: "mcp",
      mcp: {
        action: "oauth-finish",
        serverId: "github",
        target: "http://127.0.0.1:43110/oauth/callback?code=abc&state=xyz",
      },
      json: false,
      verbose: false,
      workspaceRoot: "C:/workspace",
    });

    expect(() =>
      parseCliArgs(["mcp", "refresh", "github", "--include-disabled"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toThrow("--include-disabled is only valid for `machdoch mcp servers`.");

    expect(
      parseCliArgs(
        [
          "mcp",
          "lifecycle-hook",
          "--agent",
          "claude-cli",
          "--phase",
          "succeeded",
        ],
        {
          currentWorkingDirectory: "C:/workspace",
        },
      ),
    ).toEqual({
      command: "mcp",
      mcp: {
        action: "lifecycle-hook",
        agent: "claude-cli",
        phase: "succeeded",
      },
      json: false,
      verbose: false,
      workspaceRoot: "C:/workspace",
    });

    expect(
      parseCliArgs(
        ["mcp", "cleanup", "--unused-days", "45", "--never-used-days", "7", "--apply"],
        {
          currentWorkingDirectory: "C:/workspace",
        },
      ),
    ).toEqual({
      command: "mcp",
      mcp: {
        action: "cleanup",
        unusedDays: 45,
        neverUsedDays: 7,
        apply: true,
      },
      json: false,
      verbose: false,
      workspaceRoot: "C:/workspace",
    });

    expect(() =>
      parseCliArgs(["mcp", "usage", "--apply"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toThrow("--apply is only valid for `machdoch mcp cleanup`.");
  });

  it("parses task interview commands", () => {
    expect(
      parseCliArgs(
        [
          "--json",
          "--cwd",
          "C:/repo",
          "interview",
          "--prompt",
          "Refine billing settings.",
          "--input-json",
          '{"answers":{"scope":"billing"}}',
          "--max-rounds",
          "3",
          "--mode",
          "machdoch",
          "--runtime-provider",
          "openai",
          "--model",
          "gpt-5.5",
        ],
        {
          currentWorkingDirectory: "C:/workspace",
        },
      ),
    ).toEqual({
      command: "interview",
      mode: "machdoch",
      runtimeProvider: "openai",
      model: "gpt-5.5",
      interview: {
        prompt: "Refine billing settings.",
        inputJson: '{"answers":{"scope":"billing"}}',
        maxRounds: 3,
      },
      json: true,
      verbose: false,
      workspaceRoot: "C:/repo",
    });

    expect(() =>
      parseCliArgs(["interview"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toThrow("`machdoch interview` expects --prompt or --prompt-file.");
  });

  it("parses instruction management commands", () => {
    expect(
      parseCliArgs(
        [
          "--json",
          "--cwd",
          "C:/repo",
          "instructions",
          "create",
          "TypeScript rules",
          "--prompt",
          "Prefer strict types.",
          "--scope",
          "workspace",
          "--apply-to",
          "src/**/*.ts",
          "--apply-to",
          "tests/**/*.ts",
          "--exclude",
          "src/generated/**",
          "--keyword",
          "typescript",
          "--instruction-mode",
          "auto",
          "--audience",
          "executor",
          "--priority",
          "25",
        ],
        {
          currentWorkingDirectory: "C:/workspace",
        },
      ),
    ).toEqual({
      command: "instructions",
      instructions: {
        action: "create",
        subject: "TypeScript rules",
        scope: "workspace",
        prompt: "Prefer strict types.",
        applyTo: ["src/**/*.ts", "tests/**/*.ts"],
        exclude: ["src/generated/**"],
        keywords: ["typescript"],
        mode: "auto",
        audience: "executor",
        priority: 25,
      },
      json: true,
      verbose: false,
      workspaceRoot: "C:/repo",
    });

    expect(
      parseCliArgs(
        ["instructions", "list", "--scope", "compatibility"],
        {
          currentWorkingDirectory: "C:/workspace",
        },
      ),
    ).toEqual({
      command: "instructions",
      instructions: {
        action: "list",
        scope: "compatibility",
      },
      json: false,
      verbose: false,
      workspaceRoot: "C:/workspace",
    });

    expect(
      parseCliArgs(
        [
          "instructions",
          "save",
          "TypeScript rules",
          "--prompt",
          "Prefer strict types and regression tests.",
          "--path",
          ".machdoch/instructions/typescript-rules.instructions.md",
          "--scope",
          "workspace",
        ],
        {
          currentWorkingDirectory: "C:/workspace",
        },
      ),
    ).toEqual({
      command: "instructions",
      instructions: {
        action: "save",
        subject: "TypeScript rules",
        prompt: "Prefer strict types and regression tests.",
        path: ".machdoch/instructions/typescript-rules.instructions.md",
        scope: "workspace",
      },
      json: false,
      verbose: false,
      workspaceRoot: "C:/workspace",
    });

    expect(
      parseCliArgs(
        [
          "instructions",
          "generate",
          "Review rules",
          "--prompt",
          "Create review instructions for React accessibility work.",
          "--path",
          "instructions/review-rules.instructions.md",
          "--scope",
          "user",
          "--max-rounds",
          "3",
        ],
        {
          currentWorkingDirectory: "C:/workspace",
        },
      ),
    ).toEqual({
      command: "instructions",
      instructions: {
        action: "generate",
        subject: "Review rules",
        prompt: "Create review instructions for React accessibility work.",
        path: "instructions/review-rules.instructions.md",
        scope: "user",
        maxRounds: 3,
      },
      json: false,
      verbose: false,
      workspaceRoot: "C:/workspace",
    });

    expect(() =>
      parseCliArgs(
        ["instructions", "save", "Rules", "--prompt", "Body", "--max-rounds", "2"],
        {
          currentWorkingDirectory: "C:/workspace",
        },
      ),
    ).toThrow("--max-rounds is only valid for `machdoch instructions generate`.");

    expect(() =>
      parseCliArgs(
        [
          "instructions",
          "generate",
          "Rules",
          "--prompt",
          "Body",
          "--scope",
          "compatibility",
        ],
        {
          currentWorkingDirectory: "C:/workspace",
        },
      ),
    ).toThrow(
      "Compatibility instruction files are read-only; use user, workspace, or ralph-flow scope.",
    );
  });

  it("parses Ralph flow commands", () => {
    expect(
      parseCliArgs(["--json", "--cwd", "C:/repo", "ralph"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toEqual({
      command: "ralph",
      ralph: {
        action: "list",
      },
      json: true,
      verbose: false,
      workspaceRoot: "C:/repo",
    });

    expect(
      parseCliArgs(["--json", "ralph", "list", "--scope", "user"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toEqual({
      command: "ralph",
      ralph: {
        action: "list",
        scope: "user",
      },
      json: true,
      verbose: false,
      workspaceRoot: "C:/workspace",
    });

    expect(
      parseCliArgs(
        [
          "--mode",
          "machdoch",
          "ralph",
          "run",
          "refactor-scope",
          "--param",
          "scope=src/core",
          "--param",
          "workspace=C:/repo",
        ],
        {
          currentWorkingDirectory: "C:/workspace",
        },
      ),
    ).toEqual({
      command: "ralph",
      mode: "machdoch",
      ralph: {
        action: "run",
        subject: "refactor-scope",
        params: ["scope=src/core", "workspace=C:/repo"],
      },
      json: false,
      verbose: false,
      workspaceRoot: "C:/workspace",
    });

    expect(
      parseCliArgs(
        [
          "ralph",
          "create",
          "refactor-scope",
          "--name",
          "refactor-scope",
          "--prompt",
          "Create a refactor loop.",
          "--existing-flow-json",
          '{"schemaVersion":1,"id":"refactor-scope","name":"Refactor","blocks":[],"edges":[]}',
          "--flow-target",
          "refactor",
          "--generation-mode",
          "do-it",
          "--max-rounds",
          "2",
        ],
        {
          currentWorkingDirectory: "C:/workspace",
        },
      ),
    ).toEqual({
      command: "ralph",
      ralph: {
        action: "create",
        subject: "refactor-scope",
        name: "refactor-scope",
        prompt: "Create a refactor loop.",
        existingFlowJson:
          '{"schemaVersion":1,"id":"refactor-scope","name":"Refactor","blocks":[],"edges":[]}',
        target: "refactor",
        generationMode: "do-it",
        maxRounds: 2,
      },
      json: false,
      verbose: false,
      workspaceRoot: "C:/workspace",
    });

    expect(
      parseCliArgs(
        [
          "ralph",
          "interview",
          "refactor-scope",
          "--prompt",
          "Improve the flow safely.",
          "--existing-flow-json",
          '{"schemaVersion":1,"id":"refactor-scope","name":"Refactor","blocks":[],"edges":[]}',
          "--flow-target",
          "refactor",
          "--input-json",
          '{"answers":{"scope":"src/core"}}',
          "--max-rounds",
          "5",
        ],
        {
          currentWorkingDirectory: "C:/workspace",
        },
      ),
    ).toEqual({
      command: "ralph",
      ralph: {
        action: "interview",
        subject: "refactor-scope",
        prompt: "Improve the flow safely.",
        existingFlowJson:
          '{"schemaVersion":1,"id":"refactor-scope","name":"Refactor","blocks":[],"edges":[]}',
        target: "refactor",
        inputJson: '{"answers":{"scope":"src/core"}}',
        maxRounds: 5,
      },
      json: false,
      verbose: false,
      workspaceRoot: "C:/workspace",
    });

    expect(
      parseCliArgs(
        [
          "ralph",
          "save",
          "refactor-scope",
          "--flow-json",
          '{"schemaVersion":1,"id":"refactor-scope","name":"Refactor","blocks":[],"edges":[]}',
        ],
        {
          currentWorkingDirectory: "C:/workspace",
        },
      ),
    ).toEqual({
      command: "ralph",
      ralph: {
        action: "save",
        subject: "refactor-scope",
        flowJson:
          '{"schemaVersion":1,"id":"refactor-scope","name":"Refactor","blocks":[],"edges":[]}',
      },
      json: false,
      verbose: false,
      workspaceRoot: "C:/workspace",
    });

    expect(
      parseCliArgs(
        [
          "ralph",
          "watches",
          "create",
          "--watch-json",
          '{"id":"lint-on-change","roots":[{"path":"C:/repo","scope":"workspace"}],"flow":{"id":"lint","scope":"user"}}',
        ],
        {
          currentWorkingDirectory: "C:/workspace",
        },
      ),
    ).toEqual({
      command: "ralph",
      ralph: {
        action: "watches",
        watchAction: "create",
        watchJson:
          '{"id":"lint-on-change","roots":[{"path":"C:/repo","scope":"workspace"}],"flow":{"id":"lint","scope":"user"}}',
      },
      json: false,
      verbose: false,
      workspaceRoot: "C:/workspace",
    });

    expect(
      parseCliArgs(["ralph", "watches", "delete", "lint-on-change"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toEqual({
      command: "ralph",
      ralph: {
        action: "watches",
        subject: "lint-on-change",
        watchAction: "delete",
      },
      json: false,
      verbose: false,
      workspaceRoot: "C:/workspace",
    });

    expect(
      parseCliArgs(["ralph", "revisions", "refactor-scope"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toEqual({
      command: "ralph",
      ralph: {
        action: "revisions",
        subject: "refactor-scope",
      },
      json: false,
      verbose: false,
      workspaceRoot: "C:/workspace",
    });

    expect(
      parseCliArgs(
        [
          "ralph",
          "restore",
          "refactor-scope",
          "--revision",
          "2026-06-13T10-00-00-000Z",
        ],
        {
          currentWorkingDirectory: "C:/workspace",
        },
      ),
    ).toEqual({
      command: "ralph",
      ralph: {
        action: "restore",
        subject: "refactor-scope",
        revision: "2026-06-13T10-00-00-000Z",
      },
      json: false,
      verbose: false,
      workspaceRoot: "C:/workspace",
    });

    expect(
      parseCliArgs(["ralph", "resume", "run-1", "--retry-current"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toEqual({
      command: "ralph",
      ralph: {
        action: "resume",
        subject: "run-1",
        retryCurrent: true,
      },
      json: false,
      verbose: false,
      workspaceRoot: "C:/workspace",
    });
  });

  it("parses scheduler create controls for prompts, packs, queues, and retries", () => {
    expect(
      parseCliArgs(
        [
          "--cwd",
          "C:/repo",
          "--mode",
          "machdoch",
          "--runtime-provider",
          "openai",
          "--model",
          "gpt-5",
          "--context",
          "src",
          "--image",
          "mockup.png",
          "scheduler",
          "create",
          "--name",
          "Daily review",
          "--cron",
          "0 9 * * *",
          "--timezone",
          "Europe/Berlin",
          "--prompt",
          "/daily-review",
          "--context-pack",
          "{\"name\":\"release\"}",
          "--macro",
          "/triage --fast",
          "--missed-run-policy",
          "enqueue-all",
          "--missed-run-grace-ms",
          "60000",
          "--retry-attempts",
          "4",
          "--retry-min-ms",
          "1000",
          "--retry-max-ms",
          "90000",
          "--retry-factor",
          "1.5",
          "--retry-randomize",
          "off",
          "--dedupe-key",
          "daily-review",
          "--ttl-ms",
          "300000",
          "--max-duration-ms",
          "600000",
          "--concurrency-key",
          "workspace",
          "--concurrency-limit",
          "2",
          "--history-limit",
          "50",
          "--max-catch-up-runs",
          "10",
        ],
        {
          currentWorkingDirectory: "C:/workspace",
        },
      ),
    ).toEqual({
      command: "scheduler",
      mode: "machdoch",
      runtimeProvider: "openai",
      model: "gpt-5",
      contextPaths: ["src"],
      imagePaths: ["mockup.png"],
      scheduler: {
        action: "create",
        name: "Daily review",
        cron: "0 9 * * *",
        timezone: "Europe/Berlin",
        prompt: "/daily-review",
        contextPacks: ["{\"name\":\"release\"}"],
        macros: ["/triage --fast"],
        missedRunPolicy: "enqueue-all",
        missedRunGraceMs: 60000,
        retryAttempts: 4,
        retryMinMs: 1000,
        retryMaxMs: 90000,
        retryFactor: 1.5,
        retryRandomize: false,
        dedupeKey: "daily-review",
        ttlMs: 300000,
        maxDurationMs: 600000,
        concurrencyKey: "workspace",
        concurrencyLimit: 2,
        historyLimit: 50,
        maxCatchUpRuns: 10,
      },
      json: false,
      verbose: false,
      workspaceRoot: "C:/repo",
    });
  });

  it("parses scheduled Ralph flow creation and scheduler service controls", () => {
    expect(
      parseCliArgs(
        [
          "--cwd",
          "C:/repo",
          "scheduler",
          "create",
          "--name",
          "Daily security analysis",
          "--cron",
          "0 8 * * *",
          "--timezone",
          "Europe/Berlin",
          "--scheduler-target",
          "ralph-flow",
          "--scheduled-ralph-flow",
          "security-analysis",
          "--scheduled-ralph-flow-scope",
          "workspace",
          "--scheduled-ralph-param",
          "severity=high",
          "--scheduled-ralph-run-log-scope",
          "workspace",
          "--scheduled-ralph-max-transitions",
          "80",
          "--scheduled-ralph-allowed-root",
          "C:/repo",
          "--scheduled-ralph-allow-commands",
          "on",
          "--scheduled-ralph-allow-writes",
          "off",
          "--scheduled-ralph-allow-network",
          "off",
          "--scheduled-ralph-allow-mcp-tools",
          "off",
        ],
        {
          currentWorkingDirectory: "C:/workspace",
        },
      ),
    ).toEqual({
      command: "scheduler",
      scheduler: {
        action: "create",
        name: "Daily security analysis",
        cron: "0 8 * * *",
        timezone: "Europe/Berlin",
        schedulerTarget: "ralph-flow",
        scheduledRalphFlow: "security-analysis",
        scheduledRalphFlowScope: "workspace",
        scheduledRalphParams: ["severity=high"],
        scheduledRalphRunLogScope: "workspace",
        scheduledRalphMaxTransitions: 80,
        scheduledRalphAllowedRoots: ["C:/repo"],
        scheduledRalphAllowCommands: true,
        scheduledRalphAllowWrites: false,
        scheduledRalphAllowNetwork: false,
        scheduledRalphAllowMcpTools: false,
      },
      json: false,
      verbose: false,
      workspaceRoot: "C:/repo",
    });

    expect(
      parseCliArgs(
        [
          "scheduler",
          "service",
          "--service-poll-ms",
          "1000",
          "--service-idle-shutdown-ms",
          "60000",
          "--service-max-iterations",
          "2",
          "--service-max-runs-per-tick",
          "3",
          "--service-start-event-type",
          "system.startup",
          "--service-start-event-kind",
          "system",
          "--service-start-event-dedupe-key",
          "boot:2026-06-22",
        ],
        {
          currentWorkingDirectory: "C:/workspace",
        },
      ),
    ).toMatchObject({
      command: "scheduler",
      scheduler: {
        action: "service",
        servicePollMs: 1000,
        serviceIdleShutdownMs: 60000,
        serviceMaxIterations: 2,
        serviceMaxRunsPerTick: 3,
        serviceStartEventType: "system.startup",
        serviceStartEventKind: "system",
        serviceStartEventDedupeKey: "boot:2026-06-22",
      },
    });
  });

  it("parses event-only scheduler creation and scheduler events", () => {
    expect(
      parseCliArgs(
        [
          "--cwd",
          "C:/repo",
          "scheduler",
          "create",
          "--name",
          "Summarize invoices",
          "--trigger",
          "workspace-file:workspace-file.created",
          "--trigger-filter",
          "payload.path=invoices/*.pdf",
          "--trigger-recovery-filter",
          "payload.ready=true",
          "--trigger-firing-mode",
          "state",
          "--trigger-cooldown-ms",
          "30000",
          "--trigger-repeat-ms",
          "60000",
          "--trigger-max-events",
          "2",
          "--trigger-window-ms",
          "120000",
          "--trigger-dedupe-key-template",
          "invoice:{payload.path}:{payload.mtime}",
          "--prompt",
          "Summarize the new invoice PDF.",
        ],
        {
          currentWorkingDirectory: "C:/workspace",
        },
      ),
    ).toEqual({
      command: "scheduler",
      scheduler: {
        action: "create",
        name: "Summarize invoices",
        triggers: ["workspace-file:workspace-file.created"],
        triggerFilters: ["payload.path=invoices/*.pdf"],
        triggerRecoveryFilters: ["payload.ready=true"],
        triggerFiringMode: "state",
        triggerCooldownMs: 30000,
        triggerRepeatMs: 60000,
        triggerMaxEvents: 2,
        triggerWindowMs: 120000,
        triggerDedupeKeyTemplate: "invoice:{payload.path}:{payload.mtime}",
        prompt: "Summarize the new invoice PDF.",
      },
      json: false,
      verbose: false,
      workspaceRoot: "C:/repo",
    });

    expect(
      parseCliArgs(
        [
          "--json",
          "scheduler",
          "event",
          "--event-type",
          "workspace-file.created",
          "--event-kind",
          "workspace-file",
          "--event-source",
          "test",
          "--event-payload-json",
          "{\"path\":\"invoices/june.pdf\"}",
          "--event-dedupe-key",
          "file:june",
          "--event-occurred-at",
          "1000",
        ],
        {
          currentWorkingDirectory: "C:/workspace",
        },
      ),
    ).toEqual({
      command: "scheduler",
      scheduler: {
        action: "event",
        eventType: "workspace-file.created",
        eventKind: "workspace-file",
        eventSource: "test",
        eventPayloadJson: "{\"path\":\"invoices/june.pdf\"}",
        eventDedupeKey: "file:june",
        eventOccurredAt: 1000,
      },
      json: true,
      verbose: false,
      workspaceRoot: "C:/workspace",
    });
  });

  it("parses scheduler event history listing", () => {
    expect(
      parseCliArgs(["scheduler", "events"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toEqual({
      command: "scheduler",
      scheduler: {
        action: "events",
      },
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

  it("treats a conversation context file as sufficient to enter interactive chat mode", () => {
    expect(
      parseCliArgs(
        [
          "--conversation-context-file",
          "C:/workspace/.machdoch/context.json",
        ],
        {
          currentWorkingDirectory: "C:/workspace",
        },
      ),
    ).toEqual({
      command: "chat",
      conversationContextFile: "C:/workspace/.machdoch/context.json",
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

  it("parses typed config set updates", () => {
    expect(
      parseCliArgs(["config", "set", "web-search.serper.key", "serper-live"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toEqual({
      command: "set-config",
      configSetting: "web-search.serper.key",
      configValue: "serper-live",
      json: false,
      verbose: false,
      workspaceRoot: "C:/workspace",
    });

    expect(
      parseCliArgs(["--json", "config", "set", "web-search.provider", "serper"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toEqual({
      command: "set-config",
      configSetting: "web-search.provider",
      configValue: "serper",
      json: true,
      verbose: false,
      workspaceRoot: "C:/workspace",
    });
  });

  it("rejects invalid modes and missing run tasks", () => {
    expect(() =>
      parseCliArgs(["--mode", "loud"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toThrow("Expected --mode to be followed by ask or machdoch.");

    expect(() =>
      parseCliArgs(["run"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toThrow("Expected a task after `machdoch run`.");

    expect(() =>
      parseCliArgs(["--quick", "--model", "gpt-4.5"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toThrow(
      "--quick can only be used with a task provided via --task or positional task text.",
    );

    expect(() =>
      parseCliArgs(["--set-api", "--provider", "xai", "--key", "sk-live"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toThrow(
      "Expected --provider to be followed by openai, anthropic, google, langdock.",
    );

    expect(() =>
      parseCliArgs(["--runtime-provider", "xai", "run", "show", "README.md"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toThrow(
      "Expected --runtime-provider to be followed by openai, anthropic, google, langdock, codex-cli, claude-cli, copilot-cli.",
    );

    expect(() =>
      parseCliArgs(["--session-memory", "maybe", "run", "inspect", "config"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toThrow("Expected --session-memory to be followed by on or off.");

    expect(() =>
      parseCliArgs(
        ["--global-memory", "sometimes", "run", "inspect", "config"],
        {
          currentWorkingDirectory: "C:/workspace",
        },
      ),
    ).toThrow(
      "Expected --global-memory to be followed by inherit, on, or off.",
    );

    expect(() =>
      parseCliArgs(["--image", ""], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toThrow("Expected --image to be followed by an image file path.");

    expect(() =>
      parseCliArgs(["--executor-turns", "0", "run", "inspect", "config"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toThrow("Expected --executor-turns to be followed by a positive integer.");

    expect(() =>
      parseCliArgs(["--infinite", "--executor-turns", "128"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toThrow(
      "--infinite cannot be combined with finite loop limit overrides.",
    );

    expect(() =>
      parseCliArgs(["config", "set", "web-search.provider"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toThrow("Expected `machdoch config set <setting> <value>`.");

    expect(() =>
      parseCliArgs(
        ["--model", "gpt-5.5", "config", "set", "workspace.mode", "machdoch"],
        {
          currentWorkingDirectory: "C:/workspace",
        },
      ),
    ).toThrow(
      "`machdoch config set` cannot be combined with runtime override options.",
    );

    expect(() =>
      parseCliArgs(["scheduler", "trigger"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toThrow("Expected an id after `machdoch scheduler trigger`.");

    expect(() =>
      parseCliArgs(["ralph", "run"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toThrow("Expected a flow id after `machdoch ralph run`.");

    expect(() =>
      parseCliArgs(["ralph", "delete"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toThrow("Expected a flow id after `machdoch ralph delete`.");

    expect(() =>
      parseCliArgs(["ralph", "resume", "run-1"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toThrow("`machdoch ralph resume` expects --input-json, --input-json-file, or --retry-current.");

    expect(() =>
      parseCliArgs(
        [
          "ralph",
          "resume",
          "run-1",
          "--retry-current",
          "--input-json",
          '{"requestId":"request-1","action":"submit"}',
        ],
        {
          currentWorkingDirectory: "C:/workspace",
        },
      ),
    ).toThrow("Use either --retry-current or an input response for `machdoch ralph resume`, not both.");

    expect(() =>
      parseCliArgs(["ralph", "create", "template"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toThrow("`machdoch ralph create` expects --prompt or --prompt-file.");

    expect(() =>
      parseCliArgs(["ralph", "validate", "template", "--param", "scope=src"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toThrow("--param is only valid for `machdoch ralph run`.");

    expect(() =>
      parseCliArgs(["ralph", "save", "template"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toThrow("`machdoch ralph save` expects --flow-json.");

    expect(() =>
      parseCliArgs(["ralph", "run", "template", "--flow-json", "{}"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toThrow("--flow-json is only valid for `machdoch ralph save`.");

    expect(() =>
      parseCliArgs(["ralph", "restore", "template"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toThrow("`machdoch ralph restore` expects --revision.");

    expect(() =>
      parseCliArgs(["ralph", "run", "template", "--revision", "rev-1"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toThrow("--revision is only valid for `machdoch ralph restore`.");

    expect(() =>
      parseCliArgs(["ralph", "run", "template", "--flow-target", "refactor"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toThrow("--flow-target is only valid for `machdoch ralph create` or `machdoch ralph interview`.");

    expect(() =>
      parseCliArgs(
        ["ralph", "create", "template", "--prompt", "x", "--flow-target", "bad"],
        {
          currentWorkingDirectory: "C:/workspace",
        },
      ),
    ).toThrow(
      "Expected --flow-target to be followed by flow, prompt-block, or refactor.",
    );

    expect(() =>
      parseCliArgs(
        [
          "ralph",
          "create",
          "template",
          "--prompt",
          "x",
          "--generation-mode",
          "bad",
        ],
        {
          currentWorkingDirectory: "C:/workspace",
        },
      ),
    ).toThrow("Expected --generation-mode to be followed by do-it or interview.");

    expect(() =>
      parseCliArgs(["ralph", "list", "--scope", "compatibility"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toThrow("Expected Ralph --scope to be followed by user or workspace.");

    expect(() =>
      parseCliArgs(["ralph", "watches", "create"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toThrow("`machdoch ralph watches create` expects --watch-json or --watch-json-file.");

    expect(() =>
      parseCliArgs(["ralph", "watches", "delete"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toThrow("Expected a watch id after `machdoch ralph watches delete`.");

    expect(() =>
      parseCliArgs(
        ["scheduler", "create", "--cron", "0 9 * * *", "--prompt", "review"],
        {
          currentWorkingDirectory: "C:/workspace",
        },
      ),
    ).not.toThrow();

    expect(() =>
      parseCliArgs(["scheduler", "create", "--cron", "0 9 * * *"], {
        currentWorkingDirectory: "C:/workspace",
      }),
    ).toThrow("`machdoch scheduler create` expects --prompt or --prompt-file.");

    expect(() =>
      parseCliArgs(
        [
          "scheduler",
          "create",
          "--cron",
          "0 9 * * *",
          "--interval-ms",
          "60000",
          "--prompt",
          "review",
        ],
        {
          currentWorkingDirectory: "C:/workspace",
        },
      ),
    ).toThrow(
      "`machdoch scheduler create` expects at most one of --cron, --interval-ms, or --delay-ms/--run-at.",
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
      "Done: Executed a safe file inspection.",
      "Reason: Verification passed.",
      "Tools used: filesystem",
    ]);
  });

  it("keeps non-terminal progress output compact while preserving the exact state message", () => {
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

describe("createUserConfigSummaryLines", () => {
  it("prints the resolved user config path", () => {
    expect(
      createUserConfigSummaryLines("/home/ane/.config/machdoch/user-config.json"),
    ).toEqual(["user config: /home/ane/.config/machdoch/user-config.json"]);
  });

  it("warns when sudo may point at root's user config", () => {
    expect(
      createUserConfigSummaryLines("/root/.config/machdoch/user-config.json", {
        env: { SUDO_USER: "ane" },
        getuid: () => 0,
      }),
    ).toEqual([
      "user config: /root/.config/machdoch/user-config.json",
      "sudo notice: running as root via sudo for ane; this may inspect root's user config. Run without sudo to inspect ane's normal config.",
    ]);
  });
});
