import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../runtime-contract.generated.ts";
import type { TaskExecutionRole, TaskExecutionSection } from "../types.ts";
import { createInstructionResolutionFixture } from "../__test__/instruction-test-helpers.ts";
import { createInstructionDeliveryPlan } from "../instruction-system/index.ts";
import { createCliInstructionCapabilityFromProbe } from "../provider-enrollment/instruction-delivery-preflight.ts";
import { hasUnpairedUtf16Surrogate } from "../../shared/unicode.ts";
import type { ModelDrivenExecutionParams } from "./agent-runtime-types.ts";
import type { PreparedConversationPromptContext } from "./conversation-prompt-context.ts";
import {
  assertWindowsCommandLineLength,
  maybeExecuteExternalAgentProviderTask,
} from "./external-agent-provider.ts";
import { createExternalAgentResultProtocolInstructions } from "./external-agent-result-protocol.ts";

interface MockChildProcess extends EventEmitter {
  pid: number;
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
const writeCopilotAssistantMessage = (
  child: MockChildProcess,
  content: string,
): void => {
  child.stdout.write(
    `${JSON.stringify({ type: "assistant.message", data: { content } })}\n`,
  );
};
const writeCopilotResult = (child: MockChildProcess, exitCode = 0): void => {
  child.stdout.write(`${JSON.stringify({ type: "result", exitCode })}\n`);
};
const writeCodexMessage = (child: MockChildProcess, content: string): void => {
  child.stdout.write(
    `${JSON.stringify({
      type: "item.completed",
      item: { id: randomUUID(), type: "agent_message", text: content },
    })}\n`,
  );
};
const writeCodexResult = (child: MockChildProcess): void => {
  child.stdout.write(
    `${JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 100,
        cached_input_tokens: 50,
        cache_write_input_tokens: 0,
        output_tokens: 20,
        reasoning_output_tokens: 5,
      },
    })}\n`,
  );
};
const writeStructuredAnswer = (call: SpawnCall, content: string): void => {
  if (call.args.includes("--json")) {
    writeCodexMessage(call.child, content);
    writeCodexResult(call.child);
    return;
  }

  if (call.args.includes("stream-json")) {
    call.child.stdout.write(
      `${JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 1,
        result: content,
        usage: { input_tokens: 100, output_tokens: 20 },
      })}\n`,
    );
    return;
  }

  writeCopilotAssistantMessage(call.child, content);
  writeCopilotResult(call.child);
};
const waitForCondition = async (callback: () => unknown): Promise<void> => {
  await vi.waitFor(callback, { timeout: 5_000 });
};

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn((_executable: string, args: string[]) => ({
    status: 0,
    stdout: args.includes("--help")
      ? [
          "--config",
          "--json",
          "--append-system-prompt-file",
          "--mcp-config",
          "--setting-sources",
          "--strict-mcp-config",
          "--agent",
          "--attachment",
          "--context",
          "--effort",
          "--no-auto-update",
          "--no-custom-instructions",
          "--output-format",
          "--verbose",
          "--stream",
          "--additional-mcp-config",
          "--disable-builtin-mcps",
          "--disable-mcp-server",
        ].join("\n")
      : "fixture-cli 1.0.0",
    stderr: "",
  })),
  spawn: vi.fn(
    (executable: string, args: string[], options: Record<string, unknown>) => {
      const child = new EventEmitter() as MockChildProcess;

      child.pid = 10_000 + spawnCalls.length;
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
    },
  ),
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
  "MY_GH_TOKEN",
  "GH_TOKEN_BACKUP",
  "LC_UNTRUSTED_SECRET",
  "UNTRUSTED_PROXY",
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
  process.env.CODEX_HOME = join(workspaceRoot, ".provider-state", "codex");
  process.env.CLAUDE_CONFIG_DIR = join(
    workspaceRoot,
    ".provider-state",
    "claude",
  );
  process.env.COPILOT_HOME = join(workspaceRoot, ".provider-state", "copilot");
  return workspaceRoot;
};

const createConfig = (
  workspaceRoot: string,
  overrides: Partial<
    Pick<
      RuntimeConfig,
      | "mode"
      | "provider"
      | "model"
      | "reasoning"
      | "contextWindow"
      | "agentLimits"
    >
  > = {},
): RuntimeConfig => ({
  workspaceRoot,
  mode: overrides.mode ?? "machdoch",
  provider: overrides.provider ?? "codex-cli",
  model: overrides.model ?? "gpt-5.5",
  reasoning: overrides.reasoning ?? "default",
  contextWindow: overrides.contextWindow ?? "default",
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
  internalTaskModel: {
    provider: overrides.provider ?? "codex-cli",
    model: overrides.model ?? "gpt-5.5",
    reasoning: "default",
  },
});

const preparedConversationContext: PreparedConversationPromptContext = {
  workspace: {
    selection: "selected",
    root: "C:/workspace",
  },
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

const createExternalInstructionPlan = (
  resolution: ReturnType<typeof createInstructionResolutionFixture>,
) =>
  createInstructionDeliveryPlan(resolution, {
    capability: createCliInstructionCapabilityFromProbe(resolution, {
      provider: resolution.providerId as
        | "codex-cli"
        | "claude-cli"
        | "copilot-cli",
      executable: process.execPath,
      available: true,
      version: "fixture-cli 1.0.0",
      features:
        resolution.providerId === "claude-cli"
          ? [
              "--append-system-prompt-file",
              "--effort",
              "--mcp-config",
              "--output-format",
              "--setting-sources",
              "--strict-mcp-config",
              "--verbose",
            ]
          : resolution.providerId === "copilot-cli"
            ? [
                "--agent",
                "--attachment",
                "--context",
                "--effort",
                "--no-auto-update",
                "--no-custom-instructions",
                "--output-format",
                "--stream",
                "--additional-mcp-config",
                "--disable-builtin-mcps",
                "--disable-mcp-server",
              ]
            : ["--config", "--json"],
      warnings: [],
    }),
  });

const createParams = (
  workspaceRoot: string,
  overrides: Partial<
    Pick<
      RuntimeConfig,
      | "mode"
      | "provider"
      | "model"
      | "reasoning"
      | "contextWindow"
      | "agentLimits"
    >
  > & {
    executionRole?: TaskExecutionRole;
    instructionBody?: string;
    onActionOutput?: ModelDrivenExecutionParams["onActionOutput"];
    onStateChange?: ModelDrivenExecutionParams["onStateChange"];
    task?: string;
  } = {},
): ModelDrivenExecutionParams & {
  preparedConversationContext: PreparedConversationPromptContext;
} => {
  const config = createConfig(workspaceRoot, overrides);

  if (config.provider === "unconfigured") {
    throw new Error("The external-provider fixture requires a provider.");
  }

  const instructionResolution = createInstructionResolutionFixture({
    providerId: config.provider,
    surface: "cli",
    model: config.model,
    ...(overrides.instructionBody === undefined
      ? {}
      : { body: overrides.instructionBody }),
  });
  return {
    task: overrides.task ?? "inspect README.md",
    config,
    taskContext: {
      task: overrides.task ?? "inspect README.md",
      effectiveTask: overrides.task ?? "inspect README.md",
      taskContextText: "",
      workspacePaths: [],
      suggestedTools: [],
      executionRole: overrides.executionRole ?? "executor",
      applicableInstructions: [],
      instructionResolution,
    },
    contextSections,
    instructionDeliveryPlan: createExternalInstructionPlan(
      instructionResolution,
    ),
    ...(overrides.onActionOutput
      ? { onActionOutput: overrides.onActionOutput }
      : {}),
    ...(overrides.onStateChange
      ? { onStateChange: overrides.onStateChange }
      : {}),
    preparedConversationContext,
  };
};

const readRunScopedSystemInstructions = async (
  provider: "codex-cli" | "claude-cli" | "copilot-cli",
  call: SpawnCall,
): Promise<string> => {
  const childEnv = call.options.env as NodeJS.ProcessEnv;
  if (provider === "codex-cli") {
    const config = await readFile(
      join(childEnv.CODEX_HOME!, "config.toml"),
      "utf8",
    );
    const serialized = config
      .split("\n")
      .find((line) => line.startsWith("developer_instructions = "))
      ?.slice("developer_instructions = ".length);
    expect(serialized).toBeDefined();
    return JSON.parse(serialized!) as string;
  }
  if (provider === "claude-cli") {
    const instructionFlagIndex = call.args.indexOf(
      "--append-system-prompt-file",
    );
    return await readFile(call.args[instructionFlagIndex + 1]!, "utf8");
  }
  const agentId = call.args
    .find((argument) => argument.startsWith("--agent="))
    ?.slice("--agent=".length);
  expect(agentId).toBeDefined();
  return await readFile(
    join(childEnv.COPILOT_HOME!, "agents", `${agentId}.agent.md`),
    "utf8",
  );
};

beforeEach(() => {
  isolateEnvironment();
  spawnCalls.splice(0);
  vi.mocked(spawn).mockClear();
});

afterEach(async () => {
  vi.useRealTimers();
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

    await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0];

    expect(call?.executable).toBe(process.execPath);
    expect(call?.args.slice(0, 10)).toEqual([
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "--ephemeral",
      "--json",
      "--skip-git-repo-check",
      "--ignore-rules",
      "--cd",
      workspaceRoot,
      "--model",
      "gpt-5.5",
    ]);
    expect(call?.args).not.toContain("--ask-for-approval");
    expect(call?.args).not.toContain("--sandbox");
    expect(call?.args).toContain("--ephemeral");
    expect(call?.args).not.toContain("--ignore-user-config");
    expect(call?.args).toContain("skills.bundled.enabled=false");
    expect(call?.args).toContain("--skip-git-repo-check");
    expect(call?.args).toContain("--ignore-rules");
    expect(call?.args).not.toContain("--dangerously-bypass-hook-trust");
    expect(call?.args.at(-1)).toBe("-");
    expect(call?.child.stdinText).toContain("User task:");
    expect(call?.options.cwd).toBe(workspaceRoot);

    writeStructuredAnswer(call!, "Codex delegated answer.");
    call?.child.emit("close", 0, null);

    const result = await resultPromise;

    expect(result?.status).toBe("executed");
    expect(result?.executedTools).toEqual(["shell"]);
    expect(result?.response?.markdown).toBe("Codex delegated answer.");
    expect(spawnCalls).toHaveLength(1);
    expect(call?.child.stdout.destroyed).toBe(true);
    expect(call?.child.stderr.destroyed).toBe(true);
    expect(call?.child.listenerCount("exit")).toBe(0);
    expect(call?.child.listenerCount("close")).toBe(0);
    expect(call?.child.listenerCount("error")).toBe(0);
  });

  it.each([
    ["codex-cli", "gpt-5.5", "MACHDOCH_CODEX_CLI_PATH"],
    ["claude-cli", "claude-opus-4-6", "MACHDOCH_CLAUDE_CLI_PATH"],
    ["copilot-cli", "gpt-5.4", "MACHDOCH_COPILOT_CLI_PATH"],
  ] as const)(
    "preserves structured RALPH controls through %s",
    async (provider, model, binaryEnvironmentKey) => {
      const workspaceRoot = await createWorkspace();
      process.env[binaryEnvironmentKey] = process.execPath;
      const protocol = { kind: "ralph-iteration" } as const;
      const doneLine = createExternalAgentResultProtocolInstructions(protocol)
        .find((line) => line.startsWith("DONE: "))
        ?.slice("DONE: ".length);
      expect(doneLine).toBeDefined();
      const params = createParams(workspaceRoot, { provider, model });
      params.resultProtocol = protocol;

      const resultPromise = maybeExecuteExternalAgentProviderTask(params);

      await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
      const call = spawnCalls[0]!;
      const systemInstructions = await readRunScopedSystemInstructions(
        provider,
        call,
      );
      expect(systemInstructions).toContain(
        "exactly one Machdoch control record",
      );

      writeStructuredAnswer(call, `Completed delegated work.\n${doneLine}`);
      call.child.emit("close", 0, null);

      const result = await resultPromise;
      expect(result).toMatchObject({
        status: "executed",
        control: { kind: "ralph-iteration", decision: "DONE" },
        response: { markdown: "Completed delegated work." },
      });
      expect(result?.response?.markdown).not.toContain("MACHDOCH_CONTROL");
    },
  );

  it("fails closed when an external agent omits required RALPH control", async () => {
    const workspaceRoot = await createWorkspace();
    process.env.MACHDOCH_CODEX_CLI_PATH = process.execPath;
    const params = createParams(workspaceRoot);
    params.resultProtocol = { kind: "ralph-validator" };

    const resultPromise = maybeExecuteExternalAgentProviderTask(params);

    await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0]!;
    writeStructuredAnswer(call, "Completed without controller data.");
    call.child.emit("close", 0, null);

    await expect(resultPromise).resolves.toMatchObject({
      status: "blocked",
      summary: expect.stringContaining("valid Machdoch control record"),
    });
  });

  it("cancels pending Codex recovery after a normal close", async () => {
    const workspaceRoot = await createWorkspace();
    const processKillSpy =
      process.platform === "win32"
        ? undefined
        : vi.spyOn(process, "kill").mockReturnValue(true);

    try {
      process.env.MACHDOCH_CODEX_CLI_PATH = process.execPath;
      const resultPromise = maybeExecuteExternalAgentProviderTask(
        createParams(workspaceRoot),
      );

      await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
      const call = spawnCalls[0]!;
      vi.useFakeTimers();
      writeStructuredAnswer(call, "Codex delegated answer.");
      call.child.emit("exit", 0, null);
      call.child.emit("close", 0, null);

      await expect(resultPromise).resolves.toMatchObject({
        status: "executed",
        response: { markdown: "Codex delegated answer." },
      });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(spawnCalls).toHaveLength(1);
      if (processKillSpy) {
        expect(processKillSpy).not.toHaveBeenCalled();
      }
    } finally {
      processKillSpy?.mockRestore();
    }
  });

  it.each([
    { scenario: "the main process stays alive", exitBeforeRecovery: false },
    {
      scenario: "the main process exits but inherited stdio stays open",
      exitBeforeRecovery: true,
    },
  ])(
    "preserves a final Codex answer when $scenario",
    async ({ exitBeforeRecovery }) => {
      const workspaceRoot = await createWorkspace();
      const processKillSpy =
        process.platform === "win32"
          ? undefined
          : vi.spyOn(process, "kill").mockReturnValue(true);

      try {
        process.env.MACHDOCH_CODEX_CLI_PATH = process.execPath;

        const resultPromise = maybeExecuteExternalAgentProviderTask(
          createParams(workspaceRoot),
        );

        await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
        const call = spawnCalls[0]!;

        vi.useFakeTimers();
        writeStructuredAnswer(call, "Codex completed answer.");
        if (exitBeforeRecovery) {
          call.child.emit("exit", 0, null);
        }
        await vi.advanceTimersByTimeAsync(10_000);

        if (process.platform === "win32") {
          expect(spawnCalls[1]).toMatchObject({
            executable: "taskkill",
            args: ["/PID", String(call.child.pid), "/T", "/F"],
          });
          spawnCalls[1]?.child.emit("close", 0, null);
        } else {
          expect(processKillSpy).toHaveBeenCalledWith(
            -Number(call.child.pid),
            "SIGTERM",
          );
          call.child.emit("close", null, "SIGTERM");
        }

        const result = await resultPromise;

        expect(result).toMatchObject({
          status: "executed",
          response: { markdown: "Codex completed answer." },
          metadata: {
            providerShutdownRecovered: true,
            providerShutdownRecoveryKind: exitBeforeRecovery
              ? "child-exit-close-timeout"
              : "final-output-exit-timeout",
            providerShutdownRecoveryGraceMs: 10_000,
            providerChildExitObservedBeforeRecovery: exitBeforeRecovery,
            providerChildExitCode: exitBeforeRecovery ? 0 : "unknown",
            providerChildExitSignal: "none",
          },
        });
        expect(
          result?.outputSections
            .find((section) => section.title === "Codex CLI")
            ?.lines.join("\n"),
        ).toContain(
          exitBeforeRecovery
            ? "provider shutdown: child exited but inherited stdio did not close within 10 seconds; descendant-tree termination requested and inherited streams closed"
            : "provider shutdown: final answer received; process-tree termination requested after the child did not exit within 10 seconds",
        );
        expect(
          result?.outputSections
            .find((section) => section.title === "Codex CLI")
            ?.lines.join("\n"),
        ).toContain(
          `provider child exit before recovery: ${exitBeforeRecovery ? "yes (code 0, signal none)" : "no"}`,
        );
        expect(
          result?.outputSections.find(
            (section) => section.title === "Codex CLI",
          )?.lines,
        ).toContain("exit code: 0");
        expect(
          spawnCalls.filter((spawnCall) => spawnCall.executable !== "taskkill"),
        ).toHaveLength(1);
        expect(call.child.stdout.destroyed).toBe(true);
        expect(call.child.stderr.destroyed).toBe(true);
        expect(call.child.listenerCount("exit")).toBe(0);
        expect(call.child.listenerCount("close")).toBe(0);
        expect(call.child.listenerCount("error")).toBe(0);
        const spawnCountAfterSettlement = spawnCalls.length;
        const killCountAfterSettlement = processKillSpy?.mock.calls.length;
        call.child.emit("close", 0, null);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(spawnCalls).toHaveLength(spawnCountAfterSettlement);
        if (processKillSpy) {
          expect(processKillSpy).toHaveBeenCalledTimes(
            killCountAfterSettlement ?? 0,
          );
        }
      } finally {
        processKillSpy?.mockRestore();
      }
    },
  );

  it("starts completion recovery only after a chunked Codex terminal event", async () => {
    const workspaceRoot = await createWorkspace();
    const processKillSpy =
      process.platform === "win32"
        ? undefined
        : vi.spyOn(process, "kill").mockReturnValue(true);

    try {
      process.env.MACHDOCH_CODEX_CLI_PATH = process.execPath;
      const resultPromise = maybeExecuteExternalAgentProviderTask(
        createParams(workspaceRoot),
      );

      await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
      const call = spawnCalls[0]!;
      vi.useFakeTimers();

      const structuredOutput = [
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "chunked-answer",
            type: "agent_message",
            text: "Codex completed in chunks.",
          },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 100, output_tokens: 20 },
        }),
        "",
      ].join("\n");
      const splitIndex = structuredOutput.indexOf(" in chunks");
      call.child.stdout.write(structuredOutput.slice(0, splitIndex));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(spawnCalls).toHaveLength(1);
      if (processKillSpy) {
        expect(processKillSpy).not.toHaveBeenCalled();
      }

      call.child.stdout.write(structuredOutput.slice(splitIndex));
      await vi.advanceTimersByTimeAsync(10_000);

      if (process.platform === "win32") {
        expect(spawnCalls[1]).toMatchObject({
          executable: "taskkill",
          args: ["/PID", String(call.child.pid), "/T", "/F"],
        });
        spawnCalls[1]?.child.emit("close", 0, null);
      } else {
        expect(processKillSpy).toHaveBeenCalledWith(
          -Number(call.child.pid),
          "SIGTERM",
        );
        call.child.emit("close", null, "SIGTERM");
      }

      await expect(resultPromise).resolves.toMatchObject({
        status: "executed",
        response: { markdown: "Codex completed in chunks." },
        metadata: {
          providerShutdownRecoveryKind: "final-output-exit-timeout",
        },
      });
    } finally {
      processKillSpy?.mockRestore();
    }
  });

  it("preserves a completed answer when cancellation races with active teardown recovery", async () => {
    const workspaceRoot = await createWorkspace();
    const controller = new AbortController();
    const processKillSpy =
      process.platform === "win32"
        ? undefined
        : vi.spyOn(process, "kill").mockReturnValue(true);

    try {
      process.env.MACHDOCH_CODEX_CLI_PATH = process.execPath;
      const resultPromise = maybeExecuteExternalAgentProviderTask({
        ...createParams(workspaceRoot),
        signal: controller.signal,
      });

      await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
      const call = spawnCalls[0]!;
      vi.useFakeTimers();
      writeStructuredAnswer(call, "Codex completed answer.");
      await vi.advanceTimersByTimeAsync(10_000);
      controller.abort("late cancellation");

      if (process.platform === "win32") {
        expect(
          spawnCalls.filter((spawnCall) => spawnCall.executable === "taskkill"),
        ).toHaveLength(1);
        spawnCalls[1]?.child.emit("close", 0, null);
      } else {
        expect(processKillSpy).toHaveBeenCalledTimes(1);
        expect(processKillSpy).toHaveBeenCalledWith(
          -Number(call.child.pid),
          "SIGTERM",
        );
        call.child.emit("close", null, "SIGTERM");
      }

      await expect(resultPromise).resolves.toMatchObject({
        status: "executed",
        response: { markdown: "Codex completed answer." },
        metadata: { providerShutdownRecovered: true },
      });
      expect(
        spawnCalls.filter((spawnCall) => spawnCall.executable !== "taskkill"),
      ).toHaveLength(1);
      if (processKillSpy) {
        expect(processKillSpy).toHaveBeenCalledTimes(2);
      }
    } finally {
      processKillSpy?.mockRestore();
    }
  });

  it("does not latch partial cleanup noise as a Codex final answer", async () => {
    const workspaceRoot = await createWorkspace();
    const processKillSpy =
      process.platform === "win32"
        ? undefined
        : vi.spyOn(process, "kill").mockReturnValue(true);

    try {
      process.env.MACHDOCH_CODEX_CLI_PATH = process.execPath;
      const resultPromise = maybeExecuteExternalAgentProviderTask(
        createParams(workspaceRoot),
      );

      await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
      const call = spawnCalls[0]!;
      vi.useFakeTimers();

      call.child.stdout.write(
        "SUCCESS: The process with PID 1234 (child process of PID 5678) has been terminated.\r\n",
      );
      await vi.advanceTimersByTimeAsync(10_000);

      expect(spawnCalls).toHaveLength(1);
      if (processKillSpy) {
        expect(processKillSpy).not.toHaveBeenCalled();
      }

      writeStructuredAnswer(call, "Actual Codex answer.");
      call.child.emit("close", 0, null);
      const result = await resultPromise;
      expect(result).toMatchObject({
        status: "executed",
        response: { markdown: "Actual Codex answer." },
      });
      expect(result?.metadata).not.toHaveProperty("providerShutdownRecovered");
    } finally {
      processKillSpy?.mockRestore();
    }
  });

  it("rejects a successful Codex exit without a terminal result event", async () => {
    const workspaceRoot = await createWorkspace();
    const processKillSpy =
      process.platform === "win32"
        ? undefined
        : vi.spyOn(process, "kill").mockReturnValue(true);

    try {
      process.env.MACHDOCH_CODEX_CLI_PATH = process.execPath;
      const resultPromise = maybeExecuteExternalAgentProviderTask(
        createParams(workspaceRoot),
      );

      await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
      const call = spawnCalls[0]!;
      vi.useFakeTimers();
      call.child.stdout.write(" \r\n\t");
      call.child.emit("exit", 0, null);
      await vi.advanceTimersByTimeAsync(10_000);

      if (process.platform === "win32") {
        expect(spawnCalls[1]?.executable).toBe("taskkill");
        spawnCalls[1]?.child.emit("close", 0, null);
      } else {
        expect(processKillSpy).toHaveBeenCalledWith(
          -Number(call.child.pid),
          "SIGTERM",
        );
        call.child.emit("close", 0, null);
      }

      await expect(resultPromise).resolves.toMatchObject({
        status: "blocked",
        metadata: {
          providerShutdownRecoveryKind: "child-exit-close-timeout",
          providerChildExitObservedBeforeRecovery: true,
          providerChildExitCode: 0,
        },
      });
    } finally {
      processKillSpy?.mockRestore();
    }
  });

  it("preserves a known nonzero Codex exit instead of converting teardown recovery into success", async () => {
    const workspaceRoot = await createWorkspace();
    const processKillSpy =
      process.platform === "win32"
        ? undefined
        : vi.spyOn(process, "kill").mockReturnValue(true);

    try {
      process.env.MACHDOCH_CODEX_CLI_PATH = process.execPath;
      const resultPromise = maybeExecuteExternalAgentProviderTask(
        createParams(workspaceRoot),
      );

      await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
      const call = spawnCalls[0]!;
      vi.useFakeTimers();
      call.child.stdout.write(
        "ERROR: Quota exceeded. Check your plan and billing details.",
      );
      call.child.emit("exit", 1, null);
      await vi.advanceTimersByTimeAsync(10_000);

      if (process.platform === "win32") {
        expect(spawnCalls[1]?.executable).toBe("taskkill");
        spawnCalls[1]?.child.emit("close", 0, null);
      } else {
        expect(processKillSpy).toHaveBeenCalledWith(
          -Number(call.child.pid),
          "SIGTERM",
        );
        call.child.emit("close", 1, null);
      }

      const result = await resultPromise;
      expect(result).toMatchObject({
        status: "blocked",
        metadata: {
          providerShutdownRecovered: true,
          providerShutdownRecoveryKind: "child-exit-close-timeout",
          providerChildExitObservedBeforeRecovery: true,
          providerChildExitCode: 1,
        },
      });
      expect(result?.reason).toContain("quota exceeded");
      expect(result?.response).toBeUndefined();
      expect(
        spawnCalls.filter((spawnCall) => spawnCall.executable !== "taskkill"),
      ).toHaveLength(1);
    } finally {
      processKillSpy?.mockRestore();
    }
  });

  it("settles recovery when process-tree termination itself never closes", async () => {
    const workspaceRoot = await createWorkspace();
    const processKillSpy =
      process.platform === "win32"
        ? undefined
        : vi.spyOn(process, "kill").mockReturnValue(true);

    try {
      process.env.MACHDOCH_CODEX_CLI_PATH = process.execPath;
      const resultPromise = maybeExecuteExternalAgentProviderTask(
        createParams(workspaceRoot),
      );

      await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
      const call = spawnCalls[0]!;
      vi.useFakeTimers();
      writeStructuredAnswer(call, "Codex completed answer.");
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(
        process.platform === "win32" ? 5_000 : 6_000,
      );

      await expect(resultPromise).resolves.toMatchObject({
        status: "executed",
        response: { markdown: "Codex completed answer." },
      });
      if (process.platform === "win32") {
        expect(spawnCalls[1]?.child.kill).toHaveBeenCalledTimes(1);
        expect(call.child.kill).toHaveBeenCalledWith("SIGTERM");
      } else {
        expect(processKillSpy).toHaveBeenCalledWith(
          -Number(call.child.pid),
          "SIGKILL",
        );
      }
      expect(call.child.stdout.destroyed).toBe(true);
      expect(call.child.stderr.destroyed).toBe(true);
    } finally {
      processKillSpy?.mockRestore();
    }
  });

  it("preserves the completed result when process-tree signaling fails", async () => {
    const workspaceRoot = await createWorkspace();
    const processKillSpy =
      process.platform === "win32"
        ? undefined
        : vi.spyOn(process, "kill").mockImplementation(() => {
            throw new Error("simulated process-group kill failure");
          });

    try {
      process.env.MACHDOCH_CODEX_CLI_PATH = process.execPath;
      const resultPromise = maybeExecuteExternalAgentProviderTask(
        createParams(workspaceRoot),
      );

      await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
      const call = spawnCalls[0]!;
      call.child.kill.mockImplementation(() => {
        throw new Error("simulated direct-child kill failure");
      });
      vi.useFakeTimers();
      writeStructuredAnswer(call, "Codex completed answer.");
      await vi.advanceTimersByTimeAsync(10_000);

      if (process.platform === "win32") {
        spawnCalls[1]?.child.emit(
          "error",
          new Error("simulated taskkill failure"),
        );
      } else {
        await vi.advanceTimersByTimeAsync(6_000);
      }

      await expect(resultPromise).resolves.toMatchObject({
        status: "executed",
        response: { markdown: "Codex completed answer." },
        metadata: { providerShutdownRecovered: true },
      });
      expect(call.child.stdout.destroyed).toBe(true);
      expect(call.child.stderr.destroyed).toBe(true);
    } finally {
      processKillSpy?.mockRestore();
    }
  });

  it("recovers a non-exiting Claude CLI only after its terminal result event", async () => {
    const workspaceRoot = await createWorkspace();
    const processKillSpy =
      process.platform === "win32"
        ? undefined
        : vi.spyOn(process, "kill").mockReturnValue(true);

    try {
      process.env.MACHDOCH_CLAUDE_CLI_PATH = process.execPath;
      const resultPromise = maybeExecuteExternalAgentProviderTask(
        createParams(workspaceRoot, {
          provider: "claude-cli",
          model: "claude-sonnet-4-6",
        }),
      );

      await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
      const call = spawnCalls[0]!;
      vi.useFakeTimers();
      writeStructuredAnswer(call, "Delegated answer.");
      await vi.advanceTimersByTimeAsync(10_000);

      if (process.platform === "win32") {
        expect(spawnCalls[1]).toMatchObject({
          executable: "taskkill",
          args: ["/PID", String(call.child.pid), "/T", "/F"],
        });
        spawnCalls[1]?.child.emit("close", 0, null);
      } else {
        expect(processKillSpy).toHaveBeenCalledWith(
          -Number(call.child.pid),
          "SIGTERM",
        );
        call.child.emit("close", null, "SIGTERM");
      }

      await expect(resultPromise).resolves.toMatchObject({
        status: "executed",
        response: { markdown: "Delegated answer." },
        metadata: {
          providerShutdownRecoveryKind: "final-output-exit-timeout",
        },
      });
    } finally {
      processKillSpy?.mockRestore();
    }
  });

  it("bounds captured and streamed delegated output", async () => {
    const workspaceRoot = await createWorkspace();
    const streamedChunks: string[] = [];

    process.env.MACHDOCH_CODEX_CLI_PATH = process.execPath;

    const resultPromise = maybeExecuteExternalAgentProviderTask(
      createParams(workspaceRoot, {
        onActionOutput: (event) => {
          streamedChunks.push(event.chunk);
        },
      }),
    );

    await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0];

    writeStructuredAnswer(
      call!,
      `${"x".repeat(511_999)}\ud83e\udd8a${"x".repeat(100_000)}`,
    );
    call?.child.emit("close", 0, null);

    const result = await resultPromise;
    const markdown = result?.response?.markdown ?? "";

    expect(markdown.length).toBeLessThan(513_000);
    expect(markdown).toContain("[output truncated by machdoch]");
    expect(hasUnpairedUtf16Surrogate(markdown)).toBe(false);
    expect(
      result?.outputSections
        .find((section) => section.title === "Codex CLI answer")
        ?.lines.join("\n").length,
    ).toBeLessThan(13_000);
    expect(streamedChunks.length).toBeGreaterThan(0);
    expect(streamedChunks.every((chunk) => chunk.length <= 32_000)).toBe(true);
  });

  it.each([
    ["codex-cli", "MACHDOCH_CODEX_CLI_PATH"],
    ["claude-cli", "MACHDOCH_CLAUDE_CLI_PATH"],
    ["copilot-cli", "MACHDOCH_COPILOT_CLI_PATH"],
  ] as const)(
    "delivers a command-line-sized request intact to %s over stdin",
    async (provider, binaryKey) => {
      const workspaceRoot = await createWorkspace();
      process.env[binaryKey] = process.execPath;
      const task = [
        `long-request-start-${provider}`,
        '"quotes", backslashes \\\\, shell & | < > ^ % !, CRLF\r\nand Unicode 🦊',
        "z".repeat(96_000),
        `long-request-end-${provider}`,
      ].join("\n");
      const resultPromise = maybeExecuteExternalAgentProviderTask(
        createParams(workspaceRoot, {
          provider,
          model:
            provider === "codex-cli"
              ? "gpt-5.5"
              : provider === "claude-cli"
                ? "claude-sonnet-4-6"
                : "auto",
          task,
        }),
      );

      await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
      const call = spawnCalls[0]!;
      await waitForCondition(() => {
        expect(call.child.stdinText).toContain(`long-request-end-${provider}`);
      });

      expect(call.args.join(" ").length).toBeLessThan(8_191);
      expect(call.args.join("\n")).not.toContain(
        `long-request-start-${provider}`,
      );
      expect(call.child.stdinText).toContain(task);
      expect(
        call.child.stdinText.match(
          new RegExp(`long-request-start-${provider}`, "gu"),
        ),
      ).toHaveLength(1);
      expect(call.child.stdinText).not.toContain(
        "truncated after 64000 characters",
      );

      const childEnv = call.options.env as NodeJS.ProcessEnv;
      const invocationHome =
        provider === "codex-cli"
          ? childEnv.CODEX_HOME
          : provider === "claude-cli"
            ? childEnv.CLAUDE_CONFIG_DIR
            : childEnv.COPILOT_HOME;

      writeStructuredAnswer(call, "Delegated answer.");
      call.child.emit("close", 0, null);

      await expect(resultPromise).resolves.toMatchObject({
        status: "executed",
      });
      await expect(access(invocationHome ?? "")).rejects.toBeDefined();
    },
  );

  it("delivers prepared conversation context exactly once", async () => {
    const workspaceRoot = await createWorkspace();
    const marker = "conversation-context-exact-once";
    process.env.MACHDOCH_CODEX_CLI_PATH = process.execPath;
    const params = createParams(workspaceRoot);
    params.preparedConversationContext = {
      ...preparedConversationContext,
      promptBlock: [
        "<conversation_context>",
        marker,
        "</conversation_context>",
      ].join("\n"),
      sections: [
        {
          title: "Recent conversation",
          lines: [marker],
        },
      ],
    };

    const resultPromise = maybeExecuteExternalAgentProviderTask(params);
    await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0]!;

    expect(call.child.stdinText.match(new RegExp(marker, "gu"))).toHaveLength(
      1,
    );
    expect(call.child.stdinText).not.toContain("### Recent conversation");

    writeStructuredAnswer(call, "Codex delegated answer.");
    call.child.emit("close", 0, null);
    await expect(resultPromise).resolves.toMatchObject({ status: "executed" });
  });

  it.each([
    ["codex-cli", "MACHDOCH_CODEX_CLI_PATH", "--image"],
    ["copilot-cli", "MACHDOCH_COPILOT_CLI_PATH", "--attachment"],
  ] as const)(
    "passes many attachments through %s native repeated flags without instruction duplication",
    async (provider, binaryKey, attachmentFlag) => {
      const workspaceRoot = await createWorkspace();
      process.env[binaryKey] = process.execPath;
      const params = createParams(workspaceRoot, {
        provider,
        model: provider === "codex-cli" ? "gpt-5.5" : "auto",
        instructionBody: `attachment-instruction-${provider}`,
      });
      params.imageInputs = Array.from({ length: 64 }, (_, index) => ({
        path: join(workspaceRoot, `attachment-${index}.png`),
        mediaType: "image/png" as const,
        data: "",
      }));

      const resultPromise = maybeExecuteExternalAgentProviderTask(params);
      await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
      const call = spawnCalls[0]!;

      expect(
        call.args.filter((argument) => argument === attachmentFlag),
      ).toHaveLength(64);
      expect(() =>
        assertWindowsCommandLineLength(process.execPath, call.args, true),
      ).not.toThrow();
      expect(
        (await readRunScopedSystemInstructions(provider, call)).match(
          new RegExp(`attachment-instruction-${provider}`, "gu"),
        ),
      ).toHaveLength(1);

      writeStructuredAnswer(call, "Delegated answer.");
      call.child.emit("close", 0, null);
      await expect(resultPromise).resolves.toMatchObject({
        status: "executed",
      });
    },
  );

  it("rejects a Windows command line above the portable wrapper bound", () => {
    expect(() =>
      assertWindowsCommandLineLength(
        "C:\\tools\\copilot.cmd",
        ["--attachment", `C:\\workspace\\${"x".repeat(8_000)}.png`],
        true,
      ),
    ).toThrow("portable 7500-character cmd.exe wrapper bound");
  });

  it("fails before launch when a Claude stdin request exceeds its documented limit", async () => {
    const workspaceRoot = await createWorkspace();
    process.env.MACHDOCH_CLAUDE_CLI_PATH = process.execPath;

    const result = await maybeExecuteExternalAgentProviderTask(
      createParams(workspaceRoot, {
        provider: "claude-cli",
        model: "claude-sonnet-4-6",
        task: "x".repeat(10 * 1024 * 1024 + 1),
      }),
    );

    expect(spawnCalls).toHaveLength(0);
    expect(result).toMatchObject({
      status: "blocked",
      reason: expect.stringContaining(
        "Claude CLI accepts at most 10485760 bytes",
      ),
    });
  });

  it("does not block delegated execution on conservative request-budget telemetry", async () => {
    const workspaceRoot = await createWorkspace();
    process.env.MACHDOCH_CODEX_CLI_PATH = process.execPath;
    const params = createParams(workspaceRoot);
    const resolution = {
      ...params.taskContext.instructionResolution!,
      budget: {
        ...params.taskContext.instructionResolution!.budget,
        providerLimitTokens: 16_400,
      },
    };
    params.taskContext.instructionResolution = resolution;
    params.instructionDeliveryPlan = createExternalInstructionPlan(resolution);
    const runId = `request-preflight-cleanup-${randomUUID()}`;
    params.runId = runId;

    const resultPromise = maybeExecuteExternalAgentProviderTask(params);
    await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0];
    writeStructuredAnswer(call!, "Budget telemetry did not block execution.");
    call?.child.emit("close", 0, null);

    await expect(resultPromise).resolves.toMatchObject({ status: "executed" });
    const leakedMarkers = await Promise.all(
      (await readdir(tmpdir(), { withFileTypes: true }))
        .filter(
          (entry) =>
            entry.isDirectory() &&
            entry.name.startsWith("machdoch-instruction-run-"),
        )
        .map(async (entry) =>
          readFile(
            join(tmpdir(), entry.name, ".machdoch-instruction-session.json"),
            "utf8",
          ).catch(() => ""),
        ),
    );
    expect(leakedMarkers.some((marker) => marker.includes(runId))).toBe(false);
  });

  it("cleans run-scoped instructions when progress reporting fails before launch", async () => {
    const workspaceRoot = await createWorkspace();
    process.env.MACHDOCH_CODEX_CLI_PATH = process.execPath;
    const runId = `progress-failure-cleanup-${randomUUID()}`;
    const params = createParams(workspaceRoot, {
      onStateChange: () => {
        throw new Error("Progress bridge unavailable.");
      },
    });
    params.runId = runId;

    await expect(maybeExecuteExternalAgentProviderTask(params)).rejects.toThrow(
      "Progress bridge unavailable.",
    );
    expect(spawnCalls).toHaveLength(0);

    const leakedMarkers = await Promise.all(
      (await readdir(tmpdir(), { withFileTypes: true }))
        .filter(
          (entry) =>
            entry.isDirectory() &&
            entry.name.startsWith("machdoch-instruction-run-"),
        )
        .map(async (entry) =>
          readFile(
            join(tmpdir(), entry.name, ".machdoch-instruction-session.json"),
            "utf8",
          ).catch(() => ""),
        ),
    );
    expect(leakedMarkers.some((marker) => marker.includes(runId))).toBe(false);
  });

  it("passes GPT-5.6 Ultra through to Codex CLI", async () => {
    const workspaceRoot = await createWorkspace();

    process.env.MACHDOCH_CODEX_CLI_PATH = process.execPath;

    const resultPromise = maybeExecuteExternalAgentProviderTask(
      createParams(workspaceRoot, {
        provider: "codex-cli",
        model: "gpt-5.6-sol",
        reasoning: "ultra",
        contextWindow: 1_050_000,
      }),
    );

    await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0];

    expect(call?.args).toContain("--config");
    expect(call?.args).toContain('model_reasoning_effort="ultra"');
    expect(call?.args).toContain("model_context_window=1050000");

    writeStructuredAnswer(call!, "Codex Ultra answer.");
    call?.child.emit("close", 0, null);

    await expect(resultPromise).resolves.toMatchObject({
      status: "executed",
      response: { markdown: "Codex Ultra answer." },
    });
  });

  it("ignores non-JSON process diagnostics around Codex result events", async () => {
    const workspaceRoot = await createWorkspace();

    process.env.MACHDOCH_CODEX_CLI_PATH = process.execPath;

    const resultPromise = maybeExecuteExternalAgentProviderTask(
      createParams(workspaceRoot),
    );

    await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0];

    call?.child.stdout.write(
      "SUCCESS: The process with PID 1234 (child process of PID 5678) has been terminated.\r\n",
    );
    writeStructuredAnswer(call!, "Codex delegated answer.");
    call?.child.stdout.write(
      "SUCCESS: The process with PID 9012 has been terminated.\r\n",
    );
    call?.child.emit("close", 0, null);

    const result = await resultPromise;

    expect(result?.status).toBe("executed");
    expect(result?.summary).toBe("Codex delegated answer.");
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

    await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0];
    const cdIndex = call?.args.indexOf("--cd") ?? -1;

    expect(call?.options.cwd).toBe(workspaceRoot);
    expect(cdIndex).toBeGreaterThanOrEqual(0);
    expect(call?.args[cdIndex + 1]).toBe(workspaceRoot);
    expect(await readRunScopedSystemInstructions("codex-cli", call!)).toContain(
      `Workspace: ${workspaceRoot}`,
    );

    writeStructuredAnswer(call!, "Codex delegated answer.");
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
        reasoning: "low",
        executionRole: "generator",
        task: [
          "Create or update a Ralph flow graph.",
          "Output contract:",
          "- Return one complete Ralph flow JSON object in your final answer.",
          "- Wrap the JSON in <ralph_flow_json>...</ralph_flow_json> tags.",
        ].join("\n"),
      }),
    );

    await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0];

    expect(call?.args).toContain("--sandbox");
    expect(call?.args).toContain("read-only");
    expect(call?.args).toContain("--ephemeral");
    expect(call?.args).not.toContain("--ignore-user-config");
    expect(call?.args).not.toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
    expect(call?.args).not.toContain("--dangerously-bypass-hook-trust");
    expect(call?.args).toContain("--config");
    expect(call?.args).toContain('model_reasoning_effort="low"');
    expect(call?.args).toContain('model_verbosity="low"');
    const systemInstructions = await readRunScopedSystemInstructions(
      "codex-cli",
      call!,
    );
    expect(systemInstructions).toContain(
      "Run as a bounded artifact worker for Machdoch.",
    );
    expect(systemInstructions).toContain(
      "Use available tools when they materially reduce uncertainty; prefer short read-only workspace inspection.",
    );
    expect(systemInstructions).toContain(
      "Do not modify files, start or restart servers, install packages, run long-running commands, or perform broad workspace verification.",
    );
    expect(systemInstructions).toContain(
      "Return exactly the artifact or answer requested by the user task.",
    );
    expect(systemInstructions).not.toContain("Run with full local access");
    expect(systemInstructions).not.toContain("make requested changes");
    expect(systemInstructions).not.toContain(
      "Final response must summarize what changed",
    );
    expect(call?.child.stdinText).not.toContain(
      "Run as a bounded artifact worker for Machdoch.",
    );

    writeStructuredAnswer(call!, "<ralph_flow_json>{}</ralph_flow_json>");
    call?.child.emit("close", 0, null);

    await expect(resultPromise).resolves.toMatchObject({ status: "executed" });
  });

  it("returns a blocked result when codex exec exits nonzero", async () => {
    const workspaceRoot = await createWorkspace();

    process.env.MACHDOCH_CODEX_CLI_PATH = process.execPath;

    const resultPromise = maybeExecuteExternalAgentProviderTask(
      createParams(workspaceRoot),
    );

    await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0];

    call?.child.stderr.write("authentication failed");
    call?.child.emit("close", 1, null);

    const result = await resultPromise;

    expect(result?.status).toBe("blocked");
    expect(result?.reason).toContain("authentication failed");
  });

  it("does not infer completion from human-readable Codex diagnostics", async () => {
    const workspaceRoot = await createWorkspace();
    const processKillSpy =
      process.platform === "win32"
        ? undefined
        : vi.spyOn(process, "kill").mockReturnValue(true);

    try {
      process.env.MACHDOCH_CODEX_CLI_PATH = process.execPath;

      const resultPromise = maybeExecuteExternalAgentProviderTask(
        createParams(workspaceRoot),
      );

      await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
      const call = spawnCalls[0]!;

      vi.useFakeTimers();
      call.child.stderr.write(
        'ERROR: unexpected status 503 Service Unavailable: {"error":"Too many concurrent requests"}\ntokens used\n174,659\n',
      );
      await vi.advanceTimersByTimeAsync(10_000);

      expect(spawnCalls).toHaveLength(1);
      if (processKillSpy) {
        expect(processKillSpy).not.toHaveBeenCalled();
      }

      call.child.emit("close", 1, null);
      const result = await resultPromise;

      expect(result?.status).toBe("blocked");
      expect(result?.metadata).not.toHaveProperty("providerShutdownRecovered");
      expect(result?.reason).toContain("Too many concurrent requests");
    } finally {
      processKillSpy?.mockRestore();
    }
  });

  it("terminates and cleans up once when a spawned child errors before close", async () => {
    const workspaceRoot = await createWorkspace();
    const processKillSpy =
      process.platform === "win32"
        ? undefined
        : vi.spyOn(process, "kill").mockReturnValue(true);

    try {
      process.env.MACHDOCH_CODEX_CLI_PATH = process.execPath;
      const resultPromise = maybeExecuteExternalAgentProviderTask(
        createParams(workspaceRoot),
      );

      await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
      const call = spawnCalls[0]!;
      call.child.emit("error", new Error("simulated child process error"));

      if (process.platform === "win32") {
        expect(spawnCalls[1]?.executable).toBe("taskkill");
        call.child.emit("close", 1, null);
        spawnCalls[1]?.child.emit("close", 0, null);
      } else {
        expect(processKillSpy).toHaveBeenCalledWith(
          -Number(call.child.pid),
          "SIGKILL",
        );
        call.child.emit("close", 1, null);
      }

      await expect(resultPromise).rejects.toThrow(
        "simulated child process error",
      );
      expect(call.child.stdout.destroyed).toBe(true);
      expect(call.child.stderr.destroyed).toBe(true);
      expect(call.child.listenerCount("exit")).toBe(0);
      expect(call.child.listenerCount("close")).toBe(0);
      expect(call.child.listenerCount("error")).toBe(0);
      expect(() => call.child.emit("close", 1, null)).not.toThrow();
      expect(
        spawnCalls.filter((spawnCall) => spawnCall.executable !== "taskkill"),
      ).toHaveLength(1);
    } finally {
      processKillSpy?.mockRestore();
    }
  });

  it("rejects promptly and starts process cleanup when codex exec is aborted", async () => {
    const workspaceRoot = await createWorkspace();
    const controller = new AbortController();
    const processKillSpy =
      process.platform === "win32"
        ? undefined
        : vi.spyOn(process, "kill").mockReturnValue(true);

    try {
      process.env.MACHDOCH_CODEX_CLI_PATH = process.execPath;

      const resultPromise = maybeExecuteExternalAgentProviderTask({
        ...createParams(workspaceRoot),
        signal: controller.signal,
      });
      let resultSettled = false;
      void resultPromise
        .finally(() => {
          resultSettled = true;
        })
        .catch(() => undefined);

      await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
      const call = spawnCalls[0];

      writeCodexMessage(call!.child, "Codex completed-looking answer.");
      controller.abort(
        "Execution stopped after exceeding the safety timeout of 25ms.",
      );

      if (process.platform === "win32") {
        expect(spawnCalls[1]).toMatchObject({
          executable: "taskkill",
          args: ["/PID", String(call?.child.pid), "/T", "/F"],
        });
        call?.child.emit("close", null, "SIGTERM");
        await Promise.resolve();
        expect(resultSettled).toBe(false);
        spawnCalls[1]?.child.emit("close", 0, null);
      } else {
        expect(call?.options.detached).toBe(true);
        expect(processKillSpy).toHaveBeenCalledWith(
          -Number(call?.child.pid),
          "SIGTERM",
        );
        call?.child.emit("close", null, "SIGTERM");
      }

      await expect(resultPromise).rejects.toThrow(
        "Execution stopped after exceeding the safety timeout of 25ms.",
      );
      if (processKillSpy) {
        expect(processKillSpy).toHaveBeenCalledWith(
          -Number(call?.child.pid),
          "SIGKILL",
        );
      }
      expect(
        spawnCalls.filter((spawnCall) => spawnCall.executable !== "taskkill"),
      ).toHaveLength(1);
      expect(call?.child.stdout.destroyed).toBe(true);
      expect(call?.child.stderr.destroyed).toBe(true);
      expect(call?.child.listenerCount("exit")).toBe(0);
      expect(call?.child.listenerCount("close")).toBe(0);
      expect(call?.child.listenerCount("error")).toBe(0);
    } finally {
      processKillSpy?.mockRestore();
    }
  });

  it("does not dispose run-scoped instructions before stdin failure cleanup finishes", async () => {
    const workspaceRoot = await createWorkspace();
    const processKillSpy =
      process.platform === "win32"
        ? undefined
        : vi.spyOn(process, "kill").mockReturnValue(true);

    try {
      process.env.MACHDOCH_CODEX_CLI_PATH = process.execPath;

      const resultPromise = maybeExecuteExternalAgentProviderTask(
        createParams(workspaceRoot),
      );
      let resultSettled = false;
      void resultPromise
        .finally(() => {
          resultSettled = true;
        })
        .catch(() => undefined);

      await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
      const call = spawnCalls[0]!;
      call.child.stdin.emit("error", new Error("simulated stdin failure"));

      if (process.platform === "win32") {
        expect(spawnCalls[1]).toMatchObject({
          executable: "taskkill",
          args: ["/PID", String(call.child.pid), "/T", "/F"],
        });
        call.child.emit("close", null, "SIGTERM");
        await Promise.resolve();
        expect(resultSettled).toBe(false);
        spawnCalls[1]?.child.emit("close", 0, null);
      } else {
        expect(processKillSpy).toHaveBeenCalledWith(
          -Number(call.child.pid),
          "SIGKILL",
        );
        call.child.emit("close", null, "SIGKILL");
      }

      await expect(resultPromise).rejects.toThrow("simulated stdin failure");
    } finally {
      processKillSpy?.mockRestore();
    }
  });

  it("summarizes codex quota failures without echoing the delegated prompt", async () => {
    const workspaceRoot = await createWorkspace();

    process.env.MACHDOCH_CODEX_CLI_PATH = process.execPath;

    const resultPromise = maybeExecuteExternalAgentProviderTask(
      createParams(workspaceRoot),
    );

    await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
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

    await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
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

    await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0];
    const childEnv = call?.options.env as NodeJS.ProcessEnv | undefined;

    expect(childEnv?.OPENAI_API_KEY).toBeUndefined();
    expect(childEnv?.CODEX_API_KEY).toBeUndefined();

    writeStructuredAnswer(call!, "Codex delegated answer.");
    call?.child.emit("close", 0, null);

    await expect(resultPromise).resolves.toMatchObject({ status: "executed" });
  });

  it("passes explicit Codex auth through an isolated managed Codex home", async () => {
    const workspaceRoot = await createWorkspace();

    process.env.MACHDOCH_CODEX_CLI_PATH = process.execPath;
    process.env.CODEX_HOME = join(workspaceRoot, ".codex-home");
    process.env.CODEX_API_KEY = "codex-explicit-key";
    process.env.OPENAI_API_KEY = "openai-process-key";
    process.env.GOOGLE_API_KEY = "google-process-key";

    const resultPromise = maybeExecuteExternalAgentProviderTask(
      createParams(workspaceRoot),
    );

    await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0];
    const childEnv = call?.options.env as NodeJS.ProcessEnv | undefined;

    expect(childEnv?.CODEX_API_KEY).toBe("codex-explicit-key");
    expect(childEnv?.CODEX_HOME).toContain("machdoch-instruction-run-");
    expect(childEnv?.CODEX_HOME).not.toBe(join(workspaceRoot, ".codex-home"));
    expect(childEnv?.OPENAI_API_KEY).toBeUndefined();
    expect(childEnv?.GOOGLE_API_KEY).toBeUndefined();

    writeStructuredAnswer(call!, "Codex delegated answer.");
    call?.child.emit("close", 0, null);

    await expect(resultPromise).resolves.toMatchObject({ status: "executed" });
    await expect(access(childEnv?.CODEX_HOME ?? "")).rejects.toBeDefined();
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

    await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0];
    const childEnv = call?.options.env as NodeJS.ProcessEnv | undefined;

    expect(childEnv?.CODEX_API_KEY).toBeUndefined();
    expect(childEnv?.GOOGLE_API_KEY).toBeUndefined();
    expect(childEnv?.PERPLEXITY_API_KEY).toBeUndefined();

    writeStructuredAnswer(call!, "Codex delegated answer.");
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
        contextWindow: "long",
        agentLimits: {
          executorTurns: 7,
          autopilotExecutorIterations: 3,
        },
      }),
    );

    await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0];

    expect(call?.executable).toBe(process.execPath);
    expect(call?.args).toEqual(
      expect.arrayContaining([
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        "claude-sonnet-4-6[1m]",
        "--dangerously-skip-permissions",
        "--no-session-persistence",
        "--append-system-prompt-file",
        "--mcp-config",
        "--strict-mcp-config",
        "--effort",
        "high",
        "--max-turns",
        "7",
      ]),
    );
    expect(call?.args).not.toContain(
      "Follow the Machdoch delegated task prompt supplied on stdin.",
    );
    expect(
      call?.args.filter((arg) => arg === "--strict-mcp-config"),
    ).toHaveLength(1);
    expect(call?.child.stdinText).not.toContain(
      "You are running as a delegated Claude CLI agent for Machdoch.",
    );
    expect(
      await readRunScopedSystemInstructions("claude-cli", call!),
    ).toContain(
      "You are running as a delegated Claude CLI agent for Machdoch.",
    );
    expect(call?.child.stdinText).toContain("User task:");

    writeStructuredAnswer(call!, "Claude delegated answer.");
    call?.child.emit("close", 0, null);

    const result = await resultPromise;

    expect(result?.status).toBe("executed");
    expect(result?.response?.markdown).toBe("Claude delegated answer.");
  });

  it.each([
    ["codex-cli", "MACHDOCH_CODEX_CLI_PATH"],
    ["claude-cli", "MACHDOCH_CLAUDE_CLI_PATH"],
    ["copilot-cli", "MACHDOCH_COPILOT_CLI_PATH"],
  ] as const)(
    "delivers the canonical Machdoch instructions exactly once for %s",
    async (provider, binaryKey) => {
      const workspaceRoot = await createWorkspace();
      process.env[binaryKey] = process.execPath;
      const canary = `exact-once-${provider}`;
      const params = createParams(workspaceRoot, {
        provider,
        instructionBody: canary,
      });
      params.taskContext.applicableInstructions = [
        {
          id: "profile:exact-once",
          digest: "a".repeat(64),
          kind: "profile-global",
          name: "Exact once policy",
          body: canary,
          scopePath: ".",
          precedence: 1,
        },
      ];
      params.contextSections = [
        ...contextSections,
        {
          title: "Instruction context",
          audience: "internal",
          lines: [`body: ${canary}`],
        },
      ];

      const resultPromise = maybeExecuteExternalAgentProviderTask(params);
      await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
      const call = spawnCalls[0]!;
      const childEnv = call.options.env as NodeJS.ProcessEnv;
      const nativeInstructionText = await readRunScopedSystemInstructions(
        provider,
        call,
      );
      expect(childEnv.COPILOT_CUSTOM_INSTRUCTIONS_DIRS).toBeUndefined();

      const stdinOccurrences =
        call.child.stdinText.match(new RegExp(canary, "gu"))?.length ?? 0;
      const nativeOccurrences =
        nativeInstructionText?.match(new RegExp(canary, "gu"))?.length ?? 0;
      expect(stdinOccurrences + nativeOccurrences).toBe(1);
      expect(stdinOccurrences).toBe(0);
      expect(nativeOccurrences).toBe(1);
      writeStructuredAnswer(call, "Delegated answer.");
      call.child.emit("close", 0, null);
      await expect(resultPromise).resolves.toMatchObject({
        status: "executed",
      });
    },
  );

  it("does not retry a potentially mutating CLI step after native adaptation is rejected", async () => {
    const workspaceRoot = await createWorkspace();
    process.env.MACHDOCH_CLAUDE_CLI_PATH = process.execPath;
    const params = createParams(workspaceRoot, {
      provider: "claude-cli",
      instructionBody: "Apply the native fallback canary.",
    });
    params.taskContext.applicableInstructions = [
      {
        id: "profile:fallback",
        digest: "b".repeat(64),
        kind: "profile-global",
        name: "Fallback policy",
        body: "Apply the native fallback canary.",
        scopePath: ".",
        precedence: 1,
      },
    ];
    params.contextSections = [
      ...contextSections,
      {
        title: "Instruction context",
        audience: "internal",
        lines: ["body: Apply the native fallback canary."],
      },
    ];

    const resultPromise = maybeExecuteExternalAgentProviderTask(params);
    await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
    spawnCalls[0]?.child.stderr.write(
      "error: unknown option --append-system-prompt-file",
    );
    spawnCalls[0]?.child.emit("close", 1, null);

    await expect(resultPromise).resolves.toMatchObject({
      status: "blocked",
    });
    expect(spawnCalls).toHaveLength(1);
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

    await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0];
    const childEnv = call?.options.env as NodeJS.ProcessEnv | undefined;

    expect(childEnv?.ANTHROPIC_API_KEY).toBeUndefined();

    writeStructuredAnswer(call!, "Claude delegated answer.");
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

    await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0];
    const childEnv = call?.options.env as NodeJS.ProcessEnv | undefined;

    expect(childEnv?.ANTHROPIC_API_KEY).toBe("anthropic-process-key");
    expect(childEnv?.CLAUDE_CONFIG_DIR).toContain("machdoch-instruction-run-");
    expect(childEnv?.CLAUDE_CONFIG_DIR).not.toBe(
      join(workspaceRoot, ".claude-config"),
    );
    expect(childEnv?.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe("1");
    expect(childEnv?.ANTHROPIC_MODEL).toBeUndefined();
    expect(childEnv?.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
    expect(childEnv?.PERPLEXITY_API_KEY).toBeUndefined();

    writeStructuredAnswer(call!, "Claude delegated answer.");
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

    await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0];

    expect(call?.args).toContain("--dangerously-skip-permissions");
    expect(call?.args).not.toContain("--permission-mode");
    expect(call?.args).not.toContain("plan");
    expect(call?.child.stdinText).not.toContain("Run with full local access");
    expect(
      await readRunScopedSystemInstructions("claude-cli", call!),
    ).toContain("Run with full local access");
    expect(call?.child.stdinText).not.toContain("Run in read-only mode");

    writeStructuredAnswer(call!, "Claude delegated answer.");
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

    await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0];

    expect(call?.executable).toBe(process.execPath);
    expect(call?.args).toContain("-s");
    expect(call?.args).toContain("--stream=off");
    expect(call?.args).toContain("--output-format=json");
    expect(call?.args).not.toContain("-p");
    expect(call?.args).not.toContain("--prompt");
    expect(call?.args).toContain("--autopilot");
    expect(call?.args).toContain("--no-ask-user");
    expect(call?.args).toContain("--allow-all");
    expect(call?.args).toContain(
      "--secret-env-vars=COPILOT_GITHUB_TOKEN,GH_TOKEN,GITHUB_TOKEN",
    );
    expect(call?.args.some((argument) => argument.startsWith("--agent="))).toBe(
      true,
    );
    expect(call?.args).not.toContain("--add-dir");
    expect(call?.args).not.toContain("--deny-tool=write,shell,memory");
    expect(call?.args).toContain("--model=auto");
    expect(call?.args.some((argument) => argument.startsWith("--effort"))).toBe(
      false,
    );
    expect(call?.child.stdinText).not.toContain(
      "You are running as a delegated Copilot CLI agent for Machdoch.",
    );
    expect(
      await readRunScopedSystemInstructions("copilot-cli", call!),
    ).toContain(
      "You are running as a delegated Copilot CLI agent for Machdoch.",
    );
    expect(call?.child.stdinText).toContain("User task:");

    writeStructuredAnswer(call!, "Copilot delegated answer.");
    call?.child.emit("close", 0, null);

    const result = await resultPromise;

    expect(result?.status).toBe("executed");
    expect(result?.response?.markdown).toBe("Copilot delegated answer.");
  });

  it("waits for Copilot's result record before recovering a non-exiting CLI", async () => {
    const workspaceRoot = await createWorkspace();
    const processKillSpy =
      process.platform === "win32"
        ? undefined
        : vi.spyOn(process, "kill").mockReturnValue(true);

    try {
      process.env.MACHDOCH_COPILOT_CLI_PATH = process.execPath;
      const resultPromise = maybeExecuteExternalAgentProviderTask(
        createParams(workspaceRoot, {
          provider: "copilot-cli",
          model: "auto",
        }),
      );

      await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
      const call = spawnCalls[0]!;
      vi.useFakeTimers();
      writeCopilotAssistantMessage(
        call.child,
        "Copilot is still inspecting the repository.",
      );
      await vi.advanceTimersByTimeAsync(10_000);

      expect(spawnCalls).toHaveLength(1);
      if (processKillSpy) {
        expect(processKillSpy).not.toHaveBeenCalled();
      }

      writeCopilotAssistantMessage(call.child, "Copilot completed answer.");
      writeCopilotResult(call.child);
      await vi.advanceTimersByTimeAsync(10_000);

      if (process.platform === "win32") {
        expect(spawnCalls[1]).toMatchObject({
          executable: "taskkill",
          args: ["/PID", String(call.child.pid), "/T", "/F"],
        });
        spawnCalls[1]?.child.emit("close", 0, null);
      } else {
        expect(processKillSpy).toHaveBeenCalledWith(
          -Number(call.child.pid),
          "SIGTERM",
        );
        call.child.emit("close", null, "SIGTERM");
      }

      await expect(resultPromise).resolves.toMatchObject({
        status: "executed",
        response: { markdown: "Copilot completed answer." },
        metadata: {
          providerShutdownRecovered: true,
          providerShutdownRecoveryKind: "final-output-exit-timeout",
          providerShutdownRecoveryGraceMs: 10_000,
          providerChildExitObservedBeforeRecovery: false,
        },
      });
      expect(call.child.stdout.destroyed).toBe(true);
      expect(call.child.stderr.destroyed).toBe(true);
    } finally {
      processKillSpy?.mockRestore();
    }
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

    await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0];

    expect(call?.args).toContain("--no-ask-user");
    expect(call?.args).toContain("--autopilot");
    expect(call?.args).toContain("--allow-all");
    expect(call?.args).toContain(
      "--secret-env-vars=COPILOT_GITHUB_TOKEN,GH_TOKEN,GITHUB_TOKEN",
    );
    expect(call?.args.some((arg) => arg.startsWith("--add-dir="))).toBe(false);
    expect(call?.args).not.toContain("--allow-tool=read,url");
    expect(call?.args).not.toContain("--deny-tool=write,shell,memory");
    expect(call?.args).not.toContain("-p");
    expect(call?.child.stdinText).not.toContain("Run with full local access");
    expect(
      await readRunScopedSystemInstructions("copilot-cli", call!),
    ).toContain("Run with full local access");
    expect(call?.child.stdinText).not.toContain("Run in read-only mode");

    writeStructuredAnswer(call!, "Copilot delegated answer.");
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

    await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0];
    const childEnv = call?.options.env as NodeJS.ProcessEnv | undefined;

    expect(childEnv?.GITHUB_TOKEN).toBeUndefined();

    writeStructuredAnswer(call!, "Copilot delegated answer.");
    call?.child.emit("close", 0, null);

    await expect(resultPromise).resolves.toMatchObject({ status: "executed" });
  });

  it("keeps central MCP secret variables available to Copilot's projected proxy", async () => {
    const workspaceRoot = await createWorkspace();
    const mcpDirectory = join(workspaceRoot, ".machdoch", "mcp");
    await mkdir(mcpDirectory, { recursive: true });
    await writeFile(
      join(mcpDirectory, "mcp.json"),
      JSON.stringify({
        schemaVersion: 1,
        servers: [
          {
            id: "github-token-server",
            enabled: true,
            transport: {
              type: "stdio",
              command: "node",
              env: { TOKEN: "${env:GITHUB_TOKEN}" },
            },
          },
        ],
      }),
      "utf8",
    );
    process.env.MACHDOCH_COPILOT_CLI_PATH = process.execPath;
    process.env.GITHUB_TOKEN = "central-mcp-token";

    const resultPromise = maybeExecuteExternalAgentProviderTask(
      createParams(workspaceRoot, {
        provider: "copilot-cli",
        model: "auto",
      }),
    );

    await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0];
    const childEnv = call?.options.env as NodeJS.ProcessEnv | undefined;

    expect(childEnv?.GITHUB_TOKEN).toBe("central-mcp-token");
    expect(call?.args).toContain(
      "--secret-env-vars=COPILOT_GITHUB_TOKEN,GH_TOKEN",
    );
    expect(call?.args).not.toContain(
      "--secret-env-vars=COPILOT_GITHUB_TOKEN,GH_TOKEN,GITHUB_TOKEN",
    );

    writeStructuredAnswer(call!, "Copilot delegated answer.");
    call?.child.emit("close", 0, null);

    await expect(resultPromise).resolves.toMatchObject({ status: "executed" });
  });

  it("uses an explicit empty Copilot secret filter when every provider token is required by MCP", async () => {
    const workspaceRoot = await createWorkspace();
    const mcpDirectory = join(workspaceRoot, ".machdoch", "mcp");
    await mkdir(mcpDirectory, { recursive: true });
    await writeFile(
      join(mcpDirectory, "mcp.json"),
      JSON.stringify({
        schemaVersion: 1,
        servers: [
          {
            id: "provider-token-server",
            enabled: true,
            transport: {
              type: "stdio",
              command: "node",
              env: {
                COPILOT_TOKEN: "${env:COPILOT_GITHUB_TOKEN}",
                GH_TOKEN: "${env:GH_TOKEN}",
                GITHUB_TOKEN: "${env:GITHUB_TOKEN}",
              },
            },
          },
        ],
      }),
      "utf8",
    );
    process.env.MACHDOCH_COPILOT_CLI_PATH = process.execPath;
    process.env.COPILOT_GITHUB_TOKEN = "central-copilot-token";
    process.env.GH_TOKEN = "central-gh-token";
    process.env.GITHUB_TOKEN = "central-github-token";

    const resultPromise = maybeExecuteExternalAgentProviderTask(
      createParams(workspaceRoot, {
        provider: "copilot-cli",
        model: "auto",
      }),
    );

    await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0];
    const childEnv = call?.options.env as NodeJS.ProcessEnv | undefined;

    expect(childEnv).toMatchObject({
      COPILOT_GITHUB_TOKEN: "central-copilot-token",
      GH_TOKEN: "central-gh-token",
      GITHUB_TOKEN: "central-github-token",
    });
    expect(call?.args).toContain("--secret-env-vars=");

    writeStructuredAnswer(call!, "Copilot delegated answer.");
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
    process.env.MY_GH_TOKEN = "prefixed-token";
    process.env.GH_TOKEN_BACKUP = "suffixed-token";
    process.env.LC_UNTRUSTED_SECRET = "locale-prefix-secret";
    process.env.UNTRUSTED_PROXY = "proxy-suffix-secret";

    const resultPromise = maybeExecuteExternalAgentProviderTask(
      createParams(workspaceRoot, {
        provider: "copilot-cli",
        model: "auto",
      }),
    );

    await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0];
    const childEnv = call?.options.env as NodeJS.ProcessEnv | undefined;

    expect(childEnv?.COPILOT_GITHUB_TOKEN).toBe("copilot-process-token");
    expect(childEnv?.GH_TOKEN).toBe("gh-process-token");
    expect(childEnv?.COPILOT_HOME).toContain("copilot-home");
    expect(childEnv?.COPILOT_HOME).not.toBe(
      join(workspaceRoot, ".copilot-home"),
    );
    expect(childEnv?.COPILOT_MODEL).toBeUndefined();
    expect(childEnv?.OPENAI_API_KEY).toBeUndefined();
    expect(childEnv?.MY_GH_TOKEN).toBeUndefined();
    expect(childEnv?.GH_TOKEN_BACKUP).toBeUndefined();
    expect(childEnv?.LC_UNTRUSTED_SECRET).toBeUndefined();
    expect(childEnv?.UNTRUSTED_PROXY).toBeUndefined();
    expect(call?.args).toContain(
      "--secret-env-vars=COPILOT_GITHUB_TOKEN,GH_TOKEN,GITHUB_TOKEN",
    );

    writeStructuredAnswer(call!, "Copilot delegated answer.");
    call?.child.emit("close", 0, null);

    await expect(resultPromise).resolves.toMatchObject({ status: "executed" });
  });

  it("passes explicit copilot models and reports nonzero results as blocked", async () => {
    const workspaceRoot = await createWorkspace();

    process.env.MACHDOCH_COPILOT_CLI_PATH = process.execPath;

    const resultPromise = maybeExecuteExternalAgentProviderTask(
      createParams(workspaceRoot, {
        provider: "copilot-cli",
        model: "gpt-5.3-codex",
      }),
    );

    await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0];

    expect(call?.args).toContain("--model=gpt-5.3-codex");

    call?.child.stderr.write("Copilot authentication required");
    writeCopilotResult(call!.child, 1);
    call?.child.emit("close", 0, null);

    const result = await resultPromise;

    expect(result?.status).toBe("blocked");
    expect(result?.summary).toContain("Copilot CLI execution failed");
    expect(result?.reason).toContain("Copilot authentication required");
  });

  it("passes explicit copilot reasoning effort and context tier when configured", async () => {
    const workspaceRoot = await createWorkspace();

    process.env.MACHDOCH_COPILOT_CLI_PATH = process.execPath;

    const resultPromise = maybeExecuteExternalAgentProviderTask(
      createParams(workspaceRoot, {
        provider: "copilot-cli",
        model: "gpt-5.3-codex",
        reasoning: "xhigh",
        contextWindow: "long",
      }),
    );

    await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0];

    expect(call?.args).toContain("--model=gpt-5.3-codex");
    expect(call?.args).toContain("--effort=xhigh");
    expect(call?.args).toContain("--context=long_context");

    writeStructuredAnswer(call!, "Copilot delegated answer.");
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

    await waitForCondition(() => expect(spawnCalls).toHaveLength(1));
    const call = spawnCalls[0];

    expect(call?.args).toContain("--autopilot");
    expect(call?.args).toContain("--max-autopilot-continues=9");

    writeStructuredAnswer(call!, "Copilot delegated answer.");
    call?.child.emit("close", 0, null);

    const result = await resultPromise;

    expect(result?.status).toBe("executed");
  });
});
