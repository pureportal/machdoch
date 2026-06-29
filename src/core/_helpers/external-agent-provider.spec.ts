import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maybeExecuteExternalAgentProviderTask } from "./external-agent-provider.ts";
import type { PreparedConversationPromptContext } from "./conversation-prompt-context.ts";
import type { ModelDrivenExecutionParams } from "./agent-runtime-types.ts";
import type {
  InstructionTargetAudience,
  TaskExecutionSection,
} from "../types.ts";
import type { RuntimeConfig } from "../runtime-contract.generated.ts";

interface MockChildProcess extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  stdinText: string;
  kill: ReturnType<typeof vi.fn>;
}

interface SpawnCall {
  executable: string;
  args: string[];
  options: Record<string, unknown>;
  child: MockChildProcess;
}

const spawnCalls: SpawnCall[] = [];

vi.mock("node:child_process", () => ({
  spawn: vi.fn((executable: string, args: string[], options: Record<string, unknown>) => {
    const child = new EventEmitter() as MockChildProcess;

    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdinText = "";
    child.kill = vi.fn();
    child.stdin.on("data", (chunk: Buffer | string) => {
      child.stdinText += chunk.toString();
    });
    spawnCalls.push({
      executable,
      args,
      options,
      child,
    });

    return child;
  }),
}));

const originalEnvironment = new Map<string, string | undefined>();
const ENV_KEYS = [
  "MACHDOCH_CODEX_CLI_PATH",
  "MACHDOCH_CLAUDE_CLI_PATH",
  "MACHDOCH_COPILOT_CLI_PATH",
  "MACHDOCH_USER_CONFIG_DIR",
  "CODEX_HOME",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "PERPLEXITY_API_KEY",
  "CLAUDE_CONFIG_DIR",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "CLAUDE_CODE_EFFORT_LEVEL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "COPILOT_HOME",
  "COPILOT_MODEL",
  "COPILOT_GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
] as const;
const workspacesToClean: string[] = [];

const isolateEnvironment = (): void => {
  for (const key of ENV_KEYS) {
    if (!originalEnvironment.has(key)) {
      originalEnvironment.set(key, process.env[key]);
    }

    delete process.env[key];
  }
};

const restoreEnvironment = (): void => {
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }

  originalEnvironment.clear();
};

const createWorkspace = async (): Promise<string> => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "machdoch-codex-cli-"));
  workspacesToClean.push(workspaceRoot);
  process.env.MACHDOCH_USER_CONFIG_DIR = join(workspaceRoot, ".user-config");
  return workspaceRoot;
};

const createConfig = (
  workspaceRoot: string,
  overrides: Partial<Pick<
    RuntimeConfig,
    "mode" | "provider" | "model" | "reasoning" | "agentLimits"
  >> = {},
): RuntimeConfig => ({
  workspaceRoot,
  mode: overrides.mode ?? "machdoch",
  provider: overrides.provider ?? "codex-cli",
  model: overrides.model ?? "gpt-5.5",
  reasoning: overrides.reasoning ?? "default",
  offline: false,
  compatibility: {
    discoverGithubCustomizations: false,
  },
  ...(overrides.agentLimits ? { agentLimits: overrides.agentLimits } : {}),
  providerAvailability: [
    { provider: "openai", configured: false },
    { provider: "anthropic", configured: false },
    { provider: "google", configured: false },
    {
      provider: "codex-cli",
      configured: (overrides.provider ?? "codex-cli") === "codex-cli",
    },
    {
      provider: "claude-cli",
      configured: overrides.provider === "claude-cli",
    },
    {
      provider: "copilot-cli",
      configured: overrides.provider === "copilot-cli",
    },
  ],
  webSearch: {
    activeProvider: "none",
    providerAvailability: [
      { provider: "perplexity", configured: false },
      { provider: "tavily", configured: false },
      { provider: "serper", configured: false },
    ],
  },
  reviewModel: {
    mode: "base",
  },
});

const preparedConversationContext: PreparedConversationPromptContext = {
  sections: [],
  memory: {
    sessionEnabled: true,
    sessionEntries: [],
    globalEnabled: false,
    globalEntries: [],
  },
  uiControlEnabled: false,
};

const contextSections: TaskExecutionSection[] = [
  {
    title: "Task context",
    lines: ["task: inspect README.md"],
  },
];

const createParams = (
  workspaceRoot: string,
  overrides: Partial<
    Pick<
      RuntimeConfig,
      "mode" | "provider" | "model" | "reasoning" | "agentLimits"
    >
  > & {
    instructionAudience?: InstructionTargetAudience;
    task?: string;
  } = {},
): ModelDrivenExecutionParams & {
  preparedConversationContext: PreparedConversationPromptContext;
} => ({
  task: overrides.task ?? "inspect README.md",
  config: createConfig(workspaceRoot, overrides),
  taskContext: {
    task: overrides.task ?? "inspect README.md",
    effectiveTask: overrides.task ?? "inspect README.md",
    taskContextText: "",
    instructionContextText: "",
    workspacePaths: [],
    suggestedTools: [],
    ...(overrides.instructionAudience
      ? { instructionAudience: overrides.instructionAudience }
      : {}),
    applicableInstructions: [],
  },
  contextSections,
  preparedConversationContext,
});

beforeEach(() => {
  isolateEnvironment();
  spawnCalls.splice(0);
  vi.mocked(spawn).mockClear();
});

afterEach(async () => {
  restoreEnvironment();

  await Promise.all(
    workspacesToClean
      .splice(0)
      .map((workspaceRoot) =>
        rm(workspaceRoot, { recursive: true, force: true }),
      ),
  );
});

describe("maybeExecuteExternalAgentProviderTask", () => {
  it("runs codex exec and returns stdout as the agent answer", async () => {
    const workspaceRoot = await createWorkspace();

    process.env.MACHDOCH_CODEX_CLI_PATH = process.execPath;

    const resultPromise = maybeExecuteExternalAgentProviderTask(
      createParams(workspaceRoot),
    );

    await vi.waitFor(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0];

    expect(call?.executable).toBe(process.execPath);
    expect(call?.args.slice(0, 9)).toEqual([
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "--ignore-rules",
      "--dangerously-bypass-hook-trust",
      "--cd",
      workspaceRoot,
      "--model",
      "gpt-5.5",
    ]);
    expect(call?.args).not.toContain("--ask-for-approval");
    expect(call?.args).not.toContain("--sandbox");
    expect(call?.args).toContain("--skip-git-repo-check");
    expect(call?.args).toContain("--ignore-rules");
    expect(call?.args).toContain("--dangerously-bypass-hook-trust");
    expect(call?.args.at(-1)).toBe("-");
    expect(call?.child.stdinText).toContain("User task:");
    expect(call?.options.cwd).toBe(workspaceRoot);

    call?.child.stdout.write("Codex delegated answer.");
    call?.child.emit("close", 0, null);

    const result = await resultPromise;

    expect(result?.status).toBe("executed");
    expect(result?.executedTools).toEqual(["shell"]);
    expect(result?.response?.markdown).toBe("Codex delegated answer.");
  });

  it("normalizes Windows extended-length workspace roots for Codex execution", async () => {
    const workspaceRoot = await createWorkspace();
    const configuredWorkspaceRoot =
      process.platform === "win32" ? `\\\\?\\${workspaceRoot}` : workspaceRoot;

    process.env.MACHDOCH_CODEX_CLI_PATH = process.execPath;

    const resultPromise = maybeExecuteExternalAgentProviderTask(
      createParams(configuredWorkspaceRoot),
    );

    await vi.waitFor(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0];
    const cdIndex = call?.args.indexOf("--cd") ?? -1;

    expect(call?.options.cwd).toBe(workspaceRoot);
    expect(cdIndex).toBeGreaterThanOrEqual(0);
    expect(call?.args[cdIndex + 1]).toBe(workspaceRoot);
    expect(call?.child.stdinText).toContain(`Workspace: ${workspaceRoot}`);

    call?.child.stdout.write("Codex delegated answer.");
    call?.child.emit("close", 0, null);

    await expect(resultPromise).resolves.toMatchObject({
      status: "executed",
      response: {
        markdown: "Codex delegated answer.",
      },
    });
  });

  it("runs ask-mode generator tasks as constrained read-only Codex artifact jobs", async () => {
    const workspaceRoot = await createWorkspace();

    process.env.MACHDOCH_CODEX_CLI_PATH = process.execPath;

    const resultPromise = maybeExecuteExternalAgentProviderTask(
      createParams(workspaceRoot, {
        mode: "ask",
        provider: "codex-cli",
        model: "gpt-5.5",
        reasoning: "minimal",
        instructionAudience: "generator",
        task: [
          "Create or update a Ralph flow graph.",
          "Output contract:",
          "- Return one complete Ralph flow JSON object in your final answer.",
          "- Wrap the JSON in <ralph_flow_json>...</ralph_flow_json> tags.",
        ].join("\n"),
      }),
    );

    await vi.waitFor(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0];

    expect(call?.args).toContain("--sandbox");
    expect(call?.args).toContain("read-only");
    expect(call?.args).toContain("--ephemeral");
    expect(call?.args).toContain("--ignore-user-config");
    expect(call?.args).not.toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
    expect(call?.args).not.toContain("--dangerously-bypass-hook-trust");
    expect(call?.args).toContain("--config");
    expect(call?.args).toContain('model_reasoning_effort="low"');
    expect(call?.args).not.toContain('model_reasoning_effort="minimal"');
    expect(call?.args).toContain('model_verbosity="low"');
    expect(call?.child.stdinText).toContain(
      "Run as a bounded artifact worker for Machdoch.",
    );
    expect(call?.child.stdinText).toContain(
      "Use available tools when they materially reduce uncertainty; prefer short read-only workspace inspection.",
    );
    expect(call?.child.stdinText).toContain(
      "Do not modify files, start or restart servers, install packages, run long-running commands, or perform broad workspace verification.",
    );
    expect(call?.child.stdinText).toContain(
      "Return exactly the artifact or answer requested by the user task.",
    );
    expect(call?.child.stdinText).not.toContain("Run with full local access");
    expect(call?.child.stdinText).not.toContain("make requested changes");
    expect(call?.child.stdinText).not.toContain(
      "Final response must summarize what changed",
    );

    call?.child.stdout.write("<ralph_flow_json>{}</ralph_flow_json>");
    call?.child.emit("close", 0, null);

    await expect(resultPromise).resolves.toMatchObject({ status: "executed" });
  });

  it("returns a blocked result when codex exec exits nonzero", async () => {
    const workspaceRoot = await createWorkspace();

    process.env.MACHDOCH_CODEX_CLI_PATH = process.execPath;

    const resultPromise = maybeExecuteExternalAgentProviderTask(
      createParams(workspaceRoot),
    );

    await vi.waitFor(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0];

    call?.child.stderr.write("authentication failed");
    call?.child.emit("close", 1, null);

    const result = await resultPromise;

    expect(result?.status).toBe("blocked");
    expect(result?.reason).toContain("authentication failed");
  });

  it("summarizes codex quota failures without echoing the delegated prompt", async () => {
    const workspaceRoot = await createWorkspace();

    process.env.MACHDOCH_CODEX_CLI_PATH = process.execPath;

    const resultPromise = maybeExecuteExternalAgentProviderTask(
      createParams(workspaceRoot),
    );

    await vi.waitFor(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0];

    call?.child.stdout.write(
      [
        "OpenAI Codex v0.140.0-alpha.2",
        "user",
        "You are running as a delegated Codex CLI agent for Machdoch.",
        "ERROR: Quota exceeded. Check your plan and billing details.",
      ].join("\n"),
    );
    call?.child.emit("close", 1, null);

    const result = await resultPromise;

    expect(result?.status).toBe("blocked");
    expect(result?.reason).toBe(
      "Codex CLI quota exceeded: Quota exceeded. Check your plan and billing details.",
    );
    expect(result?.reason).not.toContain("delegated Codex CLI agent");
  });

  it("summarizes structured codex api failures", async () => {
    const workspaceRoot = await createWorkspace();

    process.env.MACHDOCH_CODEX_CLI_PATH = process.execPath;

    const resultPromise = maybeExecuteExternalAgentProviderTask(
      createParams(workspaceRoot),
    );

    await vi.waitFor(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0];

    call?.child.stderr.write(
      [
        "ERROR: {",
        '  "type": "error",',
        '  "error": {',
        '    "type": "invalid_request_error",',
        '    "message": "The following tools cannot be used with reasoning.effort minimal: image_gen, web_search.",',
        '    "param": "tools"',
        "  },",
        '  "status": 400',
        "}",
      ].join("\n"),
    );
    call?.child.emit("close", 1, null);

    const result = await resultPromise;

    expect(result?.status).toBe("blocked");
    expect(result?.reason).toBe(
      "Codex CLI failed: The following tools cannot be used with reasoning.effort minimal: image_gen, web_search.",
    );
  });

  it("does not leak OpenAI API keys into Codex CLI authentication", async () => {
    const workspaceRoot = await createWorkspace();

    process.env.MACHDOCH_CODEX_CLI_PATH = process.execPath;
    await writeFile(
      join(workspaceRoot, ".env"),
      "OPENAI_API_KEY=sk-test-openai-key-1234567890\n",
      "utf8",
    );

    const resultPromise = maybeExecuteExternalAgentProviderTask(
      createParams(workspaceRoot),
    );

    await vi.waitFor(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0];
    const childEnv = call?.options.env as NodeJS.ProcessEnv | undefined;

    expect(childEnv?.OPENAI_API_KEY).toBeUndefined();
    expect(childEnv?.CODEX_API_KEY).toBeUndefined();

    call?.child.stdout.write("Codex delegated answer.");
    call?.child.emit("close", 0, null);

    await expect(resultPromise).resolves.toMatchObject({ status: "executed" });
  });

  it("passes explicitly configured Codex process auth variables", async () => {
    const workspaceRoot = await createWorkspace();

    process.env.MACHDOCH_CODEX_CLI_PATH = process.execPath;
    process.env.CODEX_HOME = join(workspaceRoot, ".codex-home");
    process.env.CODEX_API_KEY = "codex-explicit-key";
    process.env.OPENAI_API_KEY = "openai-process-key";
    process.env.GOOGLE_API_KEY = "google-process-key";

    const resultPromise = maybeExecuteExternalAgentProviderTask(
      createParams(workspaceRoot),
    );

    await vi.waitFor(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0];
    const childEnv = call?.options.env as NodeJS.ProcessEnv | undefined;

    expect(childEnv?.CODEX_API_KEY).toBe("codex-explicit-key");
    expect(childEnv?.CODEX_HOME).toBe(join(workspaceRoot, ".codex-home"));
    expect(childEnv?.OPENAI_API_KEY).toBeUndefined();
    expect(childEnv?.GOOGLE_API_KEY).toBeUndefined();

    call?.child.stdout.write("Codex delegated answer.");
    call?.child.emit("close", 0, null);

    await expect(resultPromise).resolves.toMatchObject({ status: "executed" });
  });

  it("does not pass workspace environment values into delegated CLI processes", async () => {
    const workspaceRoot = await createWorkspace();

    process.env.MACHDOCH_CODEX_CLI_PATH = process.execPath;
    await writeFile(
      join(workspaceRoot, ".env"),
      [
        "CODEX_API_KEY=codex-workspace-key",
        "GOOGLE_API_KEY=google-workspace-key",
        "PERPLEXITY_API_KEY=perplexity-workspace-key",
      ].join("\n"),
      "utf8",
    );

    const resultPromise = maybeExecuteExternalAgentProviderTask(
      createParams(workspaceRoot),
    );

    await vi.waitFor(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0];
    const childEnv = call?.options.env as NodeJS.ProcessEnv | undefined;

    expect(childEnv?.CODEX_API_KEY).toBeUndefined();
    expect(childEnv?.GOOGLE_API_KEY).toBeUndefined();
    expect(childEnv?.PERPLEXITY_API_KEY).toBeUndefined();

    call?.child.stdout.write("Codex delegated answer.");
    call?.child.emit("close", 0, null);

    await expect(resultPromise).resolves.toMatchObject({ status: "executed" });
  });

  it("runs claude in non-interactive print mode with the delegated prompt on stdin", async () => {
    const workspaceRoot = await createWorkspace();

    process.env.MACHDOCH_CLAUDE_CLI_PATH = process.execPath;

    const resultPromise = maybeExecuteExternalAgentProviderTask(
      createParams(workspaceRoot, {
        provider: "claude-cli",
        model: "claude-sonnet-4-6",
        reasoning: "high",
        agentLimits: {
          executorTurns: 7,
          autopilotExecutorIterations: 3,
        },
      }),
    );

    await vi.waitFor(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0];

    expect(call?.executable).toBe(process.execPath);
    expect(call?.args).toEqual([
      "-p",
      "Follow the Machdoch delegated task prompt supplied on stdin.",
      "--output-format",
      "text",
      "--model",
      "claude-sonnet-4-6",
      "--dangerously-skip-permissions",
      "--no-session-persistence",
      "--effort",
      "high",
      "--max-turns",
      "7",
    ]);
    expect(call?.child.stdinText).toContain(
      "You are running as a delegated Claude CLI agent for Machdoch.",
    );
    expect(call?.child.stdinText).toContain("User task:");

    call?.child.stdout.write("Claude delegated answer.");
    call?.child.emit("close", 0, null);

    const result = await resultPromise;

    expect(result?.status).toBe("executed");
    expect(result?.response?.markdown).toBe("Claude delegated answer.");
  });

  it("does not leak Anthropic API keys into Claude CLI authentication", async () => {
    const workspaceRoot = await createWorkspace();

    process.env.MACHDOCH_CLAUDE_CLI_PATH = process.execPath;
    await writeFile(
      join(workspaceRoot, ".env"),
      "ANTHROPIC_API_KEY=sk-ant-test-key-1234567890\n",
      "utf8",
    );

    const resultPromise = maybeExecuteExternalAgentProviderTask(
      createParams(workspaceRoot, {
        provider: "claude-cli",
        model: "claude-sonnet-4-6",
      }),
    );

    await vi.waitFor(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0];
    const childEnv = call?.options.env as NodeJS.ProcessEnv | undefined;

    expect(childEnv?.ANTHROPIC_API_KEY).toBeUndefined();

    call?.child.stdout.write("Claude delegated answer.");
    call?.child.emit("close", 0, null);

    await expect(resultPromise).resolves.toMatchObject({ status: "executed" });
  });

  it("passes explicit Claude process auth and config variables", async () => {
    const workspaceRoot = await createWorkspace();

    process.env.MACHDOCH_CLAUDE_CLI_PATH = process.execPath;
    process.env.CLAUDE_CONFIG_DIR = join(workspaceRoot, ".claude-config");
    process.env.ANTHROPIC_API_KEY = "anthropic-process-key";
    process.env.ANTHROPIC_MODEL = "claude-haiku-4-5";
    process.env.CLAUDE_CODE_EFFORT_LEVEL = "low";
    process.env.PERPLEXITY_API_KEY = "perplexity-process-key";

    const resultPromise = maybeExecuteExternalAgentProviderTask(
      createParams(workspaceRoot, {
        provider: "claude-cli",
        model: "claude-sonnet-4-6",
      }),
    );

    await vi.waitFor(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0];
    const childEnv = call?.options.env as NodeJS.ProcessEnv | undefined;

    expect(childEnv?.ANTHROPIC_API_KEY).toBe("anthropic-process-key");
    expect(childEnv?.CLAUDE_CONFIG_DIR).toBe(join(workspaceRoot, ".claude-config"));
    expect(childEnv?.ANTHROPIC_MODEL).toBeUndefined();
    expect(childEnv?.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
    expect(childEnv?.PERPLEXITY_API_KEY).toBeUndefined();

    call?.child.stdout.write("Claude delegated answer.");
    call?.child.emit("close", 0, null);

    await expect(resultPromise).resolves.toMatchObject({ status: "executed" });
  });

  it("keeps claude full-access even when the surrounding mode is ask", async () => {
    const workspaceRoot = await createWorkspace();

    process.env.MACHDOCH_CLAUDE_CLI_PATH = process.execPath;

    const resultPromise = maybeExecuteExternalAgentProviderTask(
      createParams(workspaceRoot, {
        mode: "ask",
        provider: "claude-cli",
        model: "claude-sonnet-4-6",
      }),
    );

    await vi.waitFor(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0];

    expect(call?.args).toContain("--dangerously-skip-permissions");
    expect(call?.args).not.toContain("--permission-mode");
    expect(call?.args).not.toContain("plan");
    expect(call?.child.stdinText).toContain("Run with full local access");
    expect(call?.child.stdinText).not.toContain("Run in read-only mode");

    call?.child.stdout.write("Claude delegated answer.");
    call?.child.emit("close", 0, null);

    await expect(resultPromise).resolves.toMatchObject({ status: "executed" });
  });

  it("runs copilot in silent non-interactive mode with the delegated prompt on stdin", async () => {
    const workspaceRoot = await createWorkspace();

    process.env.MACHDOCH_COPILOT_CLI_PATH = process.execPath;

    const resultPromise = maybeExecuteExternalAgentProviderTask(
      createParams(workspaceRoot, {
        provider: "copilot-cli",
        model: "auto",
      }),
    );

    await vi.waitFor(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0];

    expect(call?.executable).toBe(process.execPath);
    expect(call?.args).toContain("-s");
    expect(call?.args).not.toContain("-p");
    expect(call?.args).not.toContain("--prompt");
    expect(call?.args).toContain("--autopilot");
    expect(call?.args).toContain("--no-ask-user");
    expect(call?.args).toContain("--allow-all");
    expect(call?.args).toContain("--secret-env-vars=GH_TOKEN");
    expect(call?.args).not.toContain("--add-dir");
    expect(call?.args).not.toContain("--deny-tool=write,shell,memory");
    expect(call?.args).toContain("--model=auto");
    expect(call?.child.stdinText).toContain(
      "You are running as a delegated Copilot CLI agent for Machdoch.",
    );
    expect(call?.child.stdinText).toContain("User task:");

    call?.child.stdout.write("Copilot delegated answer.");
    call?.child.emit("close", 0, null);

    const result = await resultPromise;

    expect(result?.status).toBe("executed");
    expect(result?.response?.markdown).toBe("Copilot delegated answer.");
  });

  it("keeps copilot full-access even when the surrounding mode is ask", async () => {
    const workspaceRoot = await createWorkspace();

    process.env.MACHDOCH_COPILOT_CLI_PATH = process.execPath;

    const resultPromise = maybeExecuteExternalAgentProviderTask(
      createParams(workspaceRoot, {
        mode: "ask",
        provider: "copilot-cli",
        model: "auto",
      }),
    );

    await vi.waitFor(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0];

    expect(call?.args).toContain("--no-ask-user");
    expect(call?.args).toContain("--autopilot");
    expect(call?.args).toContain("--allow-all");
    expect(call?.args).toContain("--secret-env-vars=GH_TOKEN");
    expect(call?.args.some((arg) => arg.startsWith("--add-dir="))).toBe(false);
    expect(call?.args).not.toContain("--allow-tool=read,url");
    expect(call?.args).not.toContain("--deny-tool=write,shell,memory");
    expect(call?.args).not.toContain("-p");
    expect(call?.child.stdinText).toContain("Run with full local access");
    expect(call?.child.stdinText).not.toContain("Run in read-only mode");

    call?.child.stdout.write("Copilot delegated answer.");
    call?.child.emit("close", 0, null);

    await expect(resultPromise).resolves.toMatchObject({ status: "executed" });
  });

  it("does not leak GitHub token environment from workspace files into Copilot CLI", async () => {
    const workspaceRoot = await createWorkspace();

    process.env.MACHDOCH_COPILOT_CLI_PATH = process.execPath;
    await writeFile(
      join(workspaceRoot, ".env"),
      "GITHUB_TOKEN=github-token-from-workspace\n",
      "utf8",
    );

    const resultPromise = maybeExecuteExternalAgentProviderTask(
      createParams(workspaceRoot, {
        provider: "copilot-cli",
        model: "auto",
      }),
    );

    await vi.waitFor(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0];
    const childEnv = call?.options.env as NodeJS.ProcessEnv | undefined;

    expect(childEnv?.GITHUB_TOKEN).toBeUndefined();

    call?.child.stdout.write("Copilot delegated answer.");
    call?.child.emit("close", 0, null);

    await expect(resultPromise).resolves.toMatchObject({ status: "executed" });
  });

  it("passes explicit Copilot process auth and config variables with GH_TOKEN redaction enabled", async () => {
    const workspaceRoot = await createWorkspace();

    process.env.MACHDOCH_COPILOT_CLI_PATH = process.execPath;
    process.env.COPILOT_HOME = join(workspaceRoot, ".copilot-home");
    process.env.COPILOT_GITHUB_TOKEN = "copilot-process-token";
    process.env.GH_TOKEN = "gh-process-token";
    process.env.COPILOT_MODEL = "claude-haiku-4.5";
    process.env.OPENAI_API_KEY = "openai-process-key";

    const resultPromise = maybeExecuteExternalAgentProviderTask(
      createParams(workspaceRoot, {
        provider: "copilot-cli",
        model: "auto",
      }),
    );

    await vi.waitFor(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0];
    const childEnv = call?.options.env as NodeJS.ProcessEnv | undefined;

    expect(childEnv?.COPILOT_GITHUB_TOKEN).toBe("copilot-process-token");
    expect(childEnv?.GH_TOKEN).toBe("gh-process-token");
    expect(childEnv?.COPILOT_HOME).toBe(join(workspaceRoot, ".copilot-home"));
    expect(childEnv?.COPILOT_MODEL).toBeUndefined();
    expect(childEnv?.OPENAI_API_KEY).toBeUndefined();
    expect(call?.args).toContain("--secret-env-vars=GH_TOKEN");

    call?.child.stdout.write("Copilot delegated answer.");
    call?.child.emit("close", 0, null);

    await expect(resultPromise).resolves.toMatchObject({ status: "executed" });
  });

  it("passes explicit copilot models and reports nonzero exits as blocked", async () => {
    const workspaceRoot = await createWorkspace();

    process.env.MACHDOCH_COPILOT_CLI_PATH = process.execPath;

    const resultPromise = maybeExecuteExternalAgentProviderTask(
      createParams(workspaceRoot, {
        provider: "copilot-cli",
        model: "gpt-5.3-codex",
      }),
    );

    await vi.waitFor(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0];

    expect(call?.args).toContain("--model=gpt-5.3-codex");

    call?.child.stderr.write("Copilot authentication required");
    call?.child.emit("close", 1, null);

    const result = await resultPromise;

    expect(result?.status).toBe("blocked");
    expect(result?.summary).toContain("Copilot CLI execution failed");
    expect(result?.reason).toContain("Copilot authentication required");
  });

  it("passes explicit copilot reasoning effort when configured", async () => {
    const workspaceRoot = await createWorkspace();

    process.env.MACHDOCH_COPILOT_CLI_PATH = process.execPath;

    const resultPromise = maybeExecuteExternalAgentProviderTask(
      createParams(workspaceRoot, {
        provider: "copilot-cli",
        model: "gpt-5.3-codex",
        reasoning: "xhigh",
      }),
    );

    await vi.waitFor(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0];

    expect(call?.args).toContain("--model=gpt-5.3-codex");
    expect(call?.args).toContain("--effort=xhigh");

    call?.child.stdout.write("Copilot delegated answer.");
    call?.child.emit("close", 0, null);

    const result = await resultPromise;

    expect(result?.status).toBe("executed");
  });

  it("passes the executor turn limit as the Copilot autopilot continuation cap", async () => {
    const workspaceRoot = await createWorkspace();

    process.env.MACHDOCH_COPILOT_CLI_PATH = process.execPath;

    const resultPromise = maybeExecuteExternalAgentProviderTask(
      createParams(workspaceRoot, {
        provider: "copilot-cli",
        model: "gpt-5.3-codex",
        agentLimits: {
          executorTurns: 9,
          autopilotExecutorIterations: 3,
        },
      }),
    );

    await vi.waitFor(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0];

    expect(call?.args).toContain("--autopilot");
    expect(call?.args).toContain("--max-autopilot-continues=9");

    call?.child.stdout.write("Copilot delegated answer.");
    call?.child.emit("close", 0, null);

    const result = await resultPromise;

    expect(result?.status).toBe("executed");
  });
});
