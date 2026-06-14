import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maybeExecuteExternalAgentProviderTask } from "./external-agent-provider.ts";
import type { PreparedConversationPromptContext } from "./conversation-prompt-context.ts";
import type { ModelDrivenExecutionParams } from "./agent-runtime-types.ts";
import type { RuntimeConfig, TaskExecutionSection } from "../types.ts";

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
  availableProfiles: [],
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
  overrides: Partial<Pick<
    RuntimeConfig,
    "mode" | "provider" | "model" | "reasoning" | "agentLimits"
  >> = {},
): ModelDrivenExecutionParams & {
  preparedConversationContext: PreparedConversationPromptContext;
} => ({
  task: "inspect README.md",
  config: createConfig(workspaceRoot, overrides),
  taskContext: {
    task: "inspect README.md",
    effectiveTask: "inspect README.md",
    taskContextText: "",
    instructionContextText: "",
    workspacePaths: [],
    suggestedTools: [],
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
      "--cd",
      workspaceRoot,
      "--model",
      "gpt-5.5",
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "never",
    ]);
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
      "--permission-mode",
      "bypassPermissions",
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

  it("runs copilot in silent non-interactive mode and lets auto model use the CLI default", async () => {
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
    expect(call?.args.slice(0, 3)).toEqual(["-s", "-p", expect.any(String)]);
    expect(call?.args).toContain("--no-ask-user");
    expect(call?.args).toContain("--allow-all");
    expect(call?.args.some((arg) => arg.startsWith("--model="))).toBe(false);
    expect(call?.args[2]).toContain(
      "You are running as a delegated Copilot CLI agent for Machdoch.",
    );
    expect(call?.child.stdinText).toBe("");

    call?.child.stdout.write("Copilot delegated answer.");
    call?.child.emit("close", 0, null);

    const result = await resultPromise;

    expect(result?.status).toBe("executed");
    expect(result?.response?.markdown).toBe("Copilot delegated answer.");
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
});
