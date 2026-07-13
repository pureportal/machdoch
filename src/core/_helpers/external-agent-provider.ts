import { spawn, type ChildProcess } from "node:child_process";
import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { loadWorkspaceEnv } from "../env.js";
import {
  createExecutionResult,
  emitAgentProgress,
  normalizeFinalSummary,
} from "./agent-runtime-shared.js";
import type {
  AgentLoopState,
  ModelDrivenExecutionParams,
} from "./agent-runtime-types.js";
import {
  getAgentCliProviderLabel,
  isAgentCliProvider,
  resolveAgentCliProviderBinary,
} from "./agent-cli-providers.js";
import type { PreparedConversationPromptContext } from "./conversation-prompt-context.js";
import { createTextSection, limitText } from "./runtime-text.js";
import type {
  TaskActionOutputHandler,
  TaskExecutionResult,
  TaskExecutionSection,
} from "../types.js";
import type {
  AgentCliProvider,
  ReasoningMode,
  RuntimeConfig,
} from "../runtime-contract.generated.js";
import { normalizeReasoningModeForProviderModel } from "../reasoning-modes.js";
import { normalizeLocalCommandCwd } from "./process-execution.js";

interface SpawnedAgentResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface ExternalAgentExecutionParams extends ModelDrivenExecutionParams {
  preparedConversationContext: PreparedConversationPromptContext;
}

const MAX_DIAGNOSTIC_CHARS = 12_000;
const EXTERNAL_AGENT_PROCESS_TREE_KILL_TIMEOUT_MS = 5_000;
const MAX_CAPTURED_STDOUT_CHARS = 512_000;
const MAX_CAPTURED_STDERR_CHARS = 128_000;
const MAX_ACTION_OUTPUT_BATCH_CHARS = 32_000;
const ACTION_OUTPUT_BATCH_INTERVAL_MS = 150;
const ISOLATED_CODEX_HOME_PREFIX = "machdoch-codex-home-";
const MAX_EXTERNAL_AGENT_PROMPT_CHARS = 256_000;
const MAX_EXTERNAL_AGENT_TASK_CHARS = 64_000;
const MAX_EXTERNAL_AGENT_INSTRUCTION_CHARS = 64_000;
const MAX_EXTERNAL_AGENT_CONVERSATION_CHARS = 32_000;
const MAX_EXTERNAL_AGENT_CONTEXT_CHARS = 64_000;
const MAX_EXTERNAL_AGENT_ATTACHMENT_CHARS = 16_000;
const MAX_EXTERNAL_AGENT_CONTEXT_SECTION_CHARS = 24_000;
const TRUNCATED_OUTPUT_MARKER = "\n[output truncated by machdoch]\n";
const ANSI_ESCAPE_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/gu;
const WINDOWS_TASKKILL_SUCCESS_LINE_PATTERN =
  /^[ \t]*SUCCESS: The process with PID \d+(?: \(child process of PID \d+\))? has been terminated\.[ \t]*(?:\r?\n|$)/gmu;

type CodexCliReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";

type ClaudeCliReasoningEffort =
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

type CopilotCliReasoningEffort =
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

const mapReasoningToCodexCliEffort = (
  model: string,
  reasoning: ReasoningMode,
): CodexCliReasoningEffort | undefined => {
  const normalizedReasoning = normalizeReasoningModeForProviderModel(
    reasoning,
    "codex-cli",
    model,
  );

  if (normalizedReasoning === "default") {
    return undefined;
  }

  switch (normalizedReasoning) {
    case "none":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
    case "ultra":
      return normalizedReasoning;
  }
};

const mapReasoningToClaudeCliEffort = (
  model: string,
  reasoning: ReasoningMode,
): ClaudeCliReasoningEffort | undefined => {
  const normalizedReasoning = normalizeReasoningModeForProviderModel(
    reasoning,
    "claude-cli",
    model,
  );

  switch (normalizedReasoning) {
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return normalizedReasoning;
    case "ultra":
      return "max";
    case "default":
    case "none":
    case "minimal":
      return undefined;
  }
};

const mapReasoningToCopilotCliEffort = (
  model: string,
  reasoning: ReasoningMode,
): CopilotCliReasoningEffort | undefined => {
  const normalizedReasoning = normalizeReasoningModeForProviderModel(
    reasoning,
    "copilot-cli",
    model,
  );

  switch (normalizedReasoning) {
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return normalizedReasoning;
    case "ultra":
      return "max";
    case "default":
    case "none":
    case "minimal":
      return undefined;
  }
};

const cleanCliText = (value: string): string => {
  return value
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(WINDOWS_TASKKILL_SUCCESS_LINE_PATTERN, "")
    .trim();
};

const extractStructuredErrorMessage = (value: string): string | undefined => {
  const messageMatch = /"message"\s*:\s*"(?<message>(?:\\.|[^"\\])*)"/u.exec(
    value,
  );
  const message = messageMatch?.groups?.message;

  return message ? cleanCliText(message.replace(/\\"/gu, '"')) : undefined;
};

const createExternalAgentFailureReason = (
  providerLabel: string,
  stdout: string,
  stderr: string,
  exitCode: number | null,
): string => {
  const combined = [stderr, stdout].filter(Boolean).join("\n");
  const quotaLine = combined
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => /quota exceeded|billing details|insufficient_quota/iu.test(line));

  if (quotaLine) {
    return `${providerLabel} quota exceeded: ${quotaLine.replace(/^ERROR:\s*/iu, "")}`;
  }

  const structuredErrorMessage = extractStructuredErrorMessage(combined);

  if (structuredErrorMessage) {
    return `${providerLabel} failed: ${structuredErrorMessage}`;
  }

  const errorLines = combined
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^ERROR:/iu.test(line));

  if (errorLines.length > 0) {
    return errorLines.slice(-3).join("\n");
  }

  return (
    stderr ||
    stdout ||
    `${providerLabel} exited with code ${exitCode ?? "unknown"}.`
  );
};

const createExternalAgentLoopState = (
  sections: TaskExecutionSection[],
): AgentLoopState => ({
  executedTools: [],
  outputSections: sections,
  traceLines: [],
  memoryUpdates: [],
});

const formatSectionForPrompt = (section: TaskExecutionSection): string => {
  return limitText(
    [
      `### ${section.title}`,
      ...section.lines.map((line) => `- ${line}`),
    ].join("\n"),
    MAX_EXTERNAL_AGENT_CONTEXT_SECTION_CHARS,
  );
};

const getExternalAgentDelegationMode = (
  params: ExternalAgentExecutionParams,
): ExternalAgentDelegationMode => {
  const audience = params.taskContext.instructionAudience;

  return params.config.mode === "ask" &&
    (audience === "generator" || audience === "validator")
    ? "read-only-artifact"
    : "full-access";
};

const createExternalAgentOperatingInstructions = (
  delegationMode: ExternalAgentDelegationMode,
): string[] => {
  if (delegationMode === "read-only-artifact") {
    return [
      "Run as a bounded artifact worker for Machdoch.",
      "Use available tools when they materially reduce uncertainty; prefer short read-only workspace inspection.",
      "For simple self-contained requests, produce the artifact directly from the supplied task and resolved context.",
      "Do not modify files, start or restart servers, install packages, run long-running commands, or perform broad workspace verification.",
      "Keep tool use tight and stop inspecting as soon as the artifact can be produced.",
      "Do not ask the user for permission or clarification; return a concise blocker only if the requested artifact cannot be produced from the supplied prompt.",
    ];
  }

  return [
    "Run with full local access: make requested changes, run commands, and use available tools without asking for permission.",
    "Run autonomously. Do not ask the user for permission or clarification; stop only when the task is complete or a concrete blocker prevents progress.",
    "Follow all repository instructions discovered in the workspace. Do not start dev servers unless the repository instructions explicitly allow it.",
  ];
};

const createExternalAgentCompletionContract = (
  delegationMode: ExternalAgentDelegationMode,
): string[] => {
  if (delegationMode === "read-only-artifact") {
    return [
      "Return exactly the artifact or answer requested by the user task.",
      "Preserve any output contract in the user task exactly.",
      "Do not add change summaries, verification summaries, or follow-up prose unless the user task explicitly asks for them.",
    ];
  }

  return [
    "Work until the task is complete or a concrete blocker prevents progress.",
    "Final response must summarize what changed, verification performed, anything that could not be verified, and remaining assumptions or risks.",
  ];
};

const createExternalAgentPrompt = (
  task: string,
  config: RuntimeConfig,
  contextSections: TaskExecutionSection[],
  conversationContext: PreparedConversationPromptContext,
  systemPromptSections: readonly string[],
  providerLabel: string,
  attachmentPaths: readonly string[],
  delegationMode: ExternalAgentDelegationMode,
): string => {
  const attachmentBlock =
    attachmentPaths.length > 0
      ? limitText(
          [
            "Attached files/images available to the delegated agent:",
            ...attachmentPaths.map((path) => `- ${path}`),
          ].join("\n"),
          MAX_EXTERNAL_AGENT_ATTACHMENT_CHARS,
        )
      : undefined;
  const instructionBlock =
    systemPromptSections.length > 0
      ? limitText(
          [
            "Additional Machdoch system instructions:",
            ...systemPromptSections,
          ].join("\n\n"),
          MAX_EXTERNAL_AGENT_INSTRUCTION_CHARS,
        )
      : undefined;
  const resolvedContext = limitText(
    [...contextSections, ...conversationContext.sections]
      .map(formatSectionForPrompt)
      .join("\n\n"),
    MAX_EXTERNAL_AGENT_CONTEXT_CHARS,
  );
  const prompt = [
    `You are running as a delegated ${providerLabel} agent for Machdoch.`,
    `Workspace: ${config.workspaceRoot}`,
    `Machdoch mode: ${config.mode}`,
    `Reasoning mode: ${config.reasoning}`,
    ...createExternalAgentOperatingInstructions(delegationMode),
    attachmentBlock,
    instructionBlock,
    "User task:",
    limitText(task, MAX_EXTERNAL_AGENT_TASK_CHARS),
    conversationContext.promptBlock
      ? limitText(
          conversationContext.promptBlock,
          MAX_EXTERNAL_AGENT_CONVERSATION_CHARS,
        )
      : undefined,
    "Resolved Machdoch context:",
    resolvedContext,
    "Completion contract:",
    ...createExternalAgentCompletionContract(delegationMode).map(
      (line) => `- ${line}`,
    ),
  ]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join("\n\n");

  return limitText(prompt, MAX_EXTERNAL_AGENT_PROMPT_CHARS);
};

const shouldUseShellForExecutable = (executable: string): boolean => {
  if (process.platform !== "win32") {
    return false;
  }

  const extension = extname(executable).toLowerCase();

  return extension === ".cmd" || extension === ".bat";
};

const unrefTimer = (handle: ReturnType<typeof setTimeout>): void => {
  const candidate = handle as ReturnType<typeof setTimeout> & {
    unref?: () => void;
  };

  candidate.unref?.();
};

const terminateExternalAgentProcessTree = async (
  child: ChildProcess,
): Promise<void> => {
  if (process.platform === "win32" && typeof child.pid === "number") {
    await new Promise<void>((resolve) => {
      const killer = spawn(
        "taskkill",
        ["/PID", String(child.pid), "/T", "/F"],
        {
          stdio: "ignore",
          windowsHide: true,
        },
      );
      let settled = false;
      const settle = (): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeoutHandle);
        resolve();
      };
      const timeoutHandle = setTimeout(() => {
        killer.kill();
        child.kill();
        settle();
      }, EXTERNAL_AGENT_PROCESS_TREE_KILL_TIMEOUT_MS);

      unrefTimer(timeoutHandle);
      killer.once("close", (exitCode) => {
        if (exitCode !== 0) {
          child.kill();
        }

        settle();
      });
      killer.once("error", () => {
        child.kill();
        settle();
      });
    });

    return;
  }

  if (typeof child.pid === "number") {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch {
      // Fall back to killing the direct child if it was not placed in a group.
    }
  }

  child.kill();
};

const CORE_CHILD_ENV_KEYS = new Set([
  "ALL_PROXY",
  "APPDATA",
  "COLORTERM",
  "COMSPEC",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LANG",
  "LOCALAPPDATA",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PATH",
  "PATHEXT",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SSH_AUTH_SOCK",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "USERDNSDOMAIN",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
]);

const PROVIDER_CHILD_ENV_KEYS = {
  "codex-cli": [
    "CODEX_ACCESS_TOKEN",
    "CODEX_API_KEY",
    "CODEX_CA_CERTIFICATE",
    "CODEX_HOME",
    "CODEX_SQLITE_HOME",
    "RUST_LOG",
  ],
  "claude-cli": [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_WORKSPACE_ID",
    "API_FORCE_IDLE_TIMEOUT",
    "API_TIMEOUT_MS",
    "AWS_ACCESS_KEY_ID",
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_DEFAULT_REGION",
    "AWS_PROFILE",
    "AWS_REGION",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "BASH_DEFAULT_TIMEOUT_MS",
    "BASH_MAX_OUTPUT_LENGTH",
    "BASH_MAX_TIMEOUT_MS",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CONFIG_DIR",
    "DISABLE_TELEMETRY",
    "DO_NOT_TRACK",
    "ENABLE_TOOL_SEARCH",
    "GCLOUD_PROJECT",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT",
    "MAX_THINKING_TOKENS",
  ],
  "copilot-cli": [
    "COPILOT_CACHE_HOME",
    "COPILOT_GITHUB_TOKEN",
    "COPILOT_HOME",
    "GH_TOKEN",
    "GITHUB_TOKEN",
  ],
} as const satisfies Record<AgentCliProvider, readonly string[]>;

const PROVIDER_CHILD_ENV_DENY_KEYS = {
  "codex-cli": ["OPENAI_API_KEY"],
  "claude-cli": ["ANTHROPIC_MODEL", "CLAUDE_CODE_EFFORT_LEVEL"],
  "copilot-cli": ["COPILOT_ALLOW_ALL", "COPILOT_MODEL"],
} as const satisfies Record<AgentCliProvider, readonly string[]>;

const isCoreChildEnvKey = (key: string): boolean => {
  const normalizedKey = key.toUpperCase();

  return (
    CORE_CHILD_ENV_KEYS.has(normalizedKey) ||
    normalizedKey.startsWith("LC_") ||
    normalizedKey.startsWith("PROCESSOR_") ||
    normalizedKey.endsWith("_PROXY")
  );
};

const isProviderChildEnvKey = (
  key: string,
  provider: AgentCliProvider,
): boolean => {
  const normalizedKey = key.toUpperCase();

  if (
    (PROVIDER_CHILD_ENV_DENY_KEYS[provider] as readonly string[]).includes(
      normalizedKey,
    )
  ) {
    return false;
  }

  return (PROVIDER_CHILD_ENV_KEYS[provider] as readonly string[]).includes(
    normalizedKey,
  );
};

const createChildEnv = (provider: AgentCliProvider): NodeJS.ProcessEnv => {
  const childEnv: NodeJS.ProcessEnv = {
    NO_COLOR: "1",
  };

  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      (isCoreChildEnvKey(key) || isProviderChildEnvKey(key, provider))
    ) {
      childEnv[key] = value;
    }
  }

  return childEnv;
};

const resolveCodexHome = (): string | undefined => {
  const configuredHome = process.env.CODEX_HOME?.trim();

  if (configuredHome) {
    return configuredHome;
  }

  const userHome = process.env.USERPROFILE?.trim() || process.env.HOME?.trim();
  return userHome ? join(userHome, ".codex") : undefined;
};

const createIsolatedCodexHome = async (): Promise<{
  path: string;
  dispose: () => Promise<void>;
}> => {
  const path = await mkdtemp(join(tmpdir(), ISOLATED_CODEX_HOME_PREFIX));
  const sourceHome = resolveCodexHome();
  await chmod(path, 0o700).catch(() => undefined);

  if (sourceHome) {
    try {
      const authPath = join(path, "auth.json");
      await copyFile(join(sourceHome, "auth.json"), authPath);
      await chmod(authPath, 0o600).catch(() => undefined);
    } catch {
      // Token-based and OS credential-store authentication do not require auth.json.
    }
  }

  return {
    path,
    dispose: async (): Promise<void> => {
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
    },
  };
};

const createAbortError = (signal: AbortSignal): Error => {
  const reason = signal.reason;

  if (reason instanceof Error) {
    return reason;
  }

  return new Error(
    typeof reason === "string" && reason.trim().length > 0
      ? reason
      : "Execution cancelled by user.",
  );
};

const emitActionOutput = (
  onActionOutput: TaskActionOutputHandler | undefined,
  stream: "stdout" | "stderr",
  chunk: string,
): void => {
  if (!onActionOutput || chunk.length === 0) {
    return;
  }

  void Promise.resolve(
    onActionOutput({
      toolName: "shell",
      stream,
      chunk,
    }),
  ).catch(() => undefined);
};

interface BoundedOutputBuffer {
  text: string;
  truncated: boolean;
}

const appendBoundedOutput = (
  buffer: BoundedOutputBuffer,
  chunk: string,
  limit: number,
): void => {
  if (buffer.truncated || chunk.length === 0) {
    return;
  }

  const remaining = Math.max(0, limit - buffer.text.length);

  if (remaining > 0) {
    buffer.text += chunk.slice(0, remaining);
  }

  if (chunk.length > remaining) {
    buffer.truncated = true;
  }
};

const finalizeBoundedOutput = (buffer: BoundedOutputBuffer): string => {
  return buffer.truncated
    ? `${buffer.text}${TRUNCATED_OUTPUT_MARKER}`
    : buffer.text;
};

const createActionOutputBatcher = (
  onActionOutput: TaskActionOutputHandler | undefined,
): {
  enqueue: (stream: "stdout" | "stderr", chunk: string) => void;
  flush: () => void;
  dispose: () => void;
} => {
  const pending: Record<"stdout" | "stderr", string> = {
    stdout: "",
    stderr: "",
  };
  let flushHandle: ReturnType<typeof setTimeout> | undefined;

  const flush = (): void => {
    if (flushHandle) {
      clearTimeout(flushHandle);
      flushHandle = undefined;
    }

    for (const stream of ["stdout", "stderr"] as const) {
      const chunk = pending[stream];
      pending[stream] = "";
      emitActionOutput(onActionOutput, stream, chunk);
    }
  };

  const scheduleFlush = (): void => {
    if (flushHandle || !onActionOutput) {
      return;
    }

    flushHandle = setTimeout(flush, ACTION_OUTPUT_BATCH_INTERVAL_MS);
    unrefTimer(flushHandle);
  };

  return {
    enqueue: (stream, chunk): void => {
      if (!onActionOutput || chunk.length === 0) {
        return;
      }

      pending[stream] = `${pending[stream]}${chunk}`.slice(
        -MAX_ACTION_OUTPUT_BATCH_CHARS,
      );

      if (pending[stream].length >= MAX_ACTION_OUTPUT_BATCH_CHARS) {
        flush();
      } else {
        scheduleFlush();
      }
    },
    flush,
    dispose: (): void => {
      flush();
    },
  };
};

const runExternalAgentCommand = async (
  executable: string,
  args: string[],
  input: string | undefined,
  config: RuntimeConfig,
  provider: AgentCliProvider,
  signal: AbortSignal | undefined,
  onActionOutput: TaskActionOutputHandler | undefined,
): Promise<SpawnedAgentResult> => {
  if (signal?.aborted) {
    throw createAbortError(signal);
  }

  const isolatedCodexHome =
    provider === "codex-cli" ? await createIsolatedCodexHome() : undefined;

  try {
    return await new Promise<SpawnedAgentResult>((resolve, reject) => {
      const cwd = normalizeLocalCommandCwd(config.workspaceRoot);
      const childEnv = createChildEnv(provider);

      if (isolatedCodexHome) {
        childEnv.CODEX_HOME = isolatedCodexHome.path;
      }

      const child = spawn(executable, args, {
        cwd,
        env: childEnv,
        detached: process.platform !== "win32",
        shell: shouldUseShellForExecutable(executable),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdout: BoundedOutputBuffer = { text: "", truncated: false };
      const stderr: BoundedOutputBuffer = { text: "", truncated: false };
      const actionOutputBatcher = createActionOutputBatcher(onActionOutput);
      let settled = false;
      let abortError: Error | undefined;
      let abortSettlementHandle: ReturnType<typeof setTimeout> | undefined;

      const cleanup = (): void => {
        signal?.removeEventListener("abort", handleAbort);
        child.stdin?.removeListener("error", handleStdinError);
        actionOutputBatcher.dispose();
        if (abortSettlementHandle) {
          clearTimeout(abortSettlementHandle);
          abortSettlementHandle = undefined;
        }
      };

      const rejectOnce = (error: Error): void => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        reject(error);
      };

      const resolveOnce = (
        exitCode: number | null,
        exitSignal: NodeJS.Signals | null,
      ): void => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        resolve({
          exitCode,
          signal: exitSignal,
          stdout: finalizeBoundedOutput(stdout),
          stderr: finalizeBoundedOutput(stderr),
        });
      };

      function handleAbort(): void {
        if (settled || abortError) {
          return;
        }

        abortError = signal
          ? createAbortError(signal)
          : new Error("Execution cancelled.");
        void terminateExternalAgentProcessTree(child).catch(() => {
          child.kill();
        });

        abortSettlementHandle = setTimeout(() => {
          child.kill();
          rejectOnce(abortError ?? new Error("Execution cancelled."));
        }, EXTERNAL_AGENT_PROCESS_TREE_KILL_TIMEOUT_MS + 1_000);
        unrefTimer(abortSettlementHandle);
      }

      function handleStdinError(error: Error): void {
        if (settled || abortError) {
          return;
        }

        void terminateExternalAgentProcessTree(child).finally(() => {
          rejectOnce(error);
        });
      }

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        appendBoundedOutput(stdout, chunk, MAX_CAPTURED_STDOUT_CHARS);
        actionOutputBatcher.enqueue("stdout", chunk);
      });
      child.stderr?.on("data", (chunk: string) => {
        appendBoundedOutput(stderr, chunk, MAX_CAPTURED_STDERR_CHARS);
        actionOutputBatcher.enqueue("stderr", chunk);
      });
      child.on("error", (error) => {
        rejectOnce(abortError ?? error);
      });
      child.on("close", (exitCode, exitSignal) => {
        if (abortError) {
          rejectOnce(abortError);
          return;
        }

        resolveOnce(exitCode, exitSignal);
      });

      signal?.addEventListener("abort", handleAbort, { once: true });
      child.stdin?.once("error", handleStdinError);

      if (signal?.aborted) {
        handleAbort();
      }

      if (input !== undefined && !abortError) {
        const inputAccepted = child.stdin?.write(input) ?? true;

        if (!inputAccepted) {
          child.stdin?.once("drain", () => child.stdin?.end());
          return;
        }
      }

      child.stdin?.end();
    });
  } finally {
    await isolatedCodexHome?.dispose();
  }
};

interface ExternalAgentCommand {
  args: string[];
  input?: string;
  runDetail: string;
  startMessage: string;
  successDetail: string;
  commandLines: string[];
  metadata: Record<string, string | number | boolean>;
}

interface ExternalAgentCommandFactoryParams {
  config: RuntimeConfig;
  prompt: string;
  imageInputs: ModelDrivenExecutionParams["imageInputs"];
  delegationMode: ExternalAgentDelegationMode;
}

type ExternalAgentDelegationMode = "full-access" | "read-only-artifact";

const getExecutorTurnLimit = (config: RuntimeConfig): number | undefined => {
  const limit = config.agentLimits?.executorTurns;

  return typeof limit === "number" && Number.isFinite(limit) && limit > 0
    ? Math.trunc(limit)
    : undefined;
};

const normalizeCodexCliReasoningEffort = (
  effort: CodexCliReasoningEffort | undefined,
): CodexCliReasoningEffort | undefined => {
  return effort === "minimal" ? "low" : effort;
};

const createCodexArgs = (
  config: RuntimeConfig,
  imageInputs: ModelDrivenExecutionParams["imageInputs"],
  delegationMode: ExternalAgentDelegationMode,
): ExternalAgentCommand => {
  const reasoningEffort = normalizeCodexCliReasoningEffort(
    mapReasoningToCodexCliEffort(config.model, config.reasoning),
  );
  const args = [
    "exec",
  ];

  if (delegationMode === "read-only-artifact") {
    args.push("--sandbox", "read-only", "--ephemeral", "--ignore-user-config");
  } else {
    args.push(
      "--dangerously-bypass-approvals-and-sandbox",
      "--ephemeral",
      "--ignore-user-config",
    );
  }

  args.push(
    "--skip-git-repo-check",
    "--ignore-rules",
    "--cd",
    config.workspaceRoot,
    "--model",
    config.model,
  );
  args.push("--config", "skills.bundled.enabled=false");

  if (reasoningEffort) {
    args.push("--config", `model_reasoning_effort="${reasoningEffort}"`);
  }

  if (delegationMode === "read-only-artifact") {
    args.push("--config", 'model_verbosity="low"');
  }

  for (const imageInput of imageInputs ?? []) {
    args.push("--image", imageInput.path);
  }

  args.push("-");

  return {
    args,
    runDetail:
      delegationMode === "read-only-artifact"
        ? "Running ephemeral codex exec with an isolated Codex home in a read-only artifact-generation sandbox, plus user config, bundled skills, git-repo guard, and execpolicy rules ignored."
        : "Running ephemeral codex exec with an isolated Codex home, bundled skills and user config ignored, and approvals, sandbox, git-repo guard, and execpolicy rules bypassed.",
    startMessage:
      delegationMode === "read-only-artifact"
        ? "Starting Codex CLI in constrained read-only artifact mode."
        : "Starting Codex CLI with full local access.",
    successDetail: "codex exec exited successfully.",
    commandLines: [
      delegationMode === "read-only-artifact"
        ? "access: read-only artifact generation"
        : "access: full local access",
      "Codex home: isolated per run",
      "user config: ignored",
      "bundled skills: disabled",
      "git repo check: skipped",
      "execpolicy rules: ignored",
      ...(reasoningEffort ? [`reasoning effort: ${reasoningEffort}`] : []),
      ...(delegationMode === "read-only-artifact"
        ? ["model verbosity: low"]
        : []),
    ],
    metadata: {
      access:
        delegationMode === "read-only-artifact"
          ? "read-only-artifact"
          : "dangerously-bypass-approvals-and-sandbox",
      userConfig: "ignored",
      codexHome: "isolated",
      sessionPersistence: "ephemeral",
      bundledSkills: false,
      gitRepoCheck: "skipped",
      execpolicyRules: "ignored",
      hookTrust: "not-bypassed",
      requestedReasoning: config.reasoning,
      effectiveReasoning: reasoningEffort ?? "default",
      ...(delegationMode === "read-only-artifact"
        ? { modelVerbosity: "low" }
        : {}),
    },
  };
};

const createCodexCommand = ({
  config,
  prompt,
  imageInputs,
  delegationMode,
}: ExternalAgentCommandFactoryParams): ExternalAgentCommand => ({
  ...createCodexArgs(config, imageInputs, delegationMode),
  input: prompt,
});

const createClaudeCommand = ({
  config,
  prompt,
}: ExternalAgentCommandFactoryParams): ExternalAgentCommand => {
  const effort = mapReasoningToClaudeCliEffort(config.model, config.reasoning);
  const args = [
    "-p",
    "Follow the Machdoch delegated task prompt supplied on stdin.",
    "--output-format",
    "text",
    "--model",
    config.model,
    "--dangerously-skip-permissions",
    "--no-session-persistence",
  ];
  const maxTurns = getExecutorTurnLimit(config);

  if (effort) {
    args.push("--effort", effort);
  }

  if (maxTurns !== undefined) {
    args.push("--max-turns", String(maxTurns));
  }

  return {
    args,
    input: prompt,
    runDetail: "Running claude -p with permissions skipped.",
    startMessage: "Starting Claude CLI with full local access.",
    successDetail: "claude -p exited successfully.",
    commandLines: [
      "access: dangerously skip permissions",
      ...(effort ? [`effort: ${effort}`] : []),
      ...(maxTurns !== undefined ? [`max turns: ${maxTurns}`] : []),
    ],
    metadata: {
      access: "dangerously-skip-permissions",
      reasoning: config.reasoning,
      ...(effort ? { effort } : {}),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
    },
  };
};

const createCopilotCommand = ({
  config,
  prompt,
}: ExternalAgentCommandFactoryParams): ExternalAgentCommand => {
  const effort = mapReasoningToCopilotCliEffort(
    config.model,
    config.reasoning,
  );
  const maxTurns = getExecutorTurnLimit(config);
  const args = [
    "-s",
    "--autopilot",
    "--no-ask-user",
    "--secret-env-vars=GH_TOKEN",
  ];

  args.push(`--model=${config.model}`);

  if (effort) {
    args.push(`--effort=${effort}`);
  }

  if (maxTurns !== undefined) {
    args.push(`--max-autopilot-continues=${maxTurns}`);
  }

  args.push("--allow-all");

  return {
    args,
    input: prompt,
    runDetail:
      "Running copilot with a piped prompt in autopilot mode with all tools, paths, and URLs allowed.",
    startMessage: "Starting Copilot CLI with full non-interactive permissions.",
    successDetail: "copilot exited successfully.",
    commandLines: [
      "access: allow-all",
      "autopilot: enabled",
      "secret env redaction: GH_TOKEN",
      `model argument: ${config.model}`,
      ...(effort ? [`effort: ${effort}`] : []),
      ...(maxTurns !== undefined ? [`max autopilot continues: ${maxTurns}`] : []),
    ],
    metadata: {
      access: "allow-all",
      autopilot: true,
      secretEnvRedaction: "GH_TOKEN",
      reasoning: config.reasoning,
      modelArgument: config.model,
      ...(effort ? { effort } : {}),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
    },
  };
};

const createExternalAgentCommand = (
  provider: AgentCliProvider,
  params: ExternalAgentCommandFactoryParams,
): ExternalAgentCommand => {
  switch (provider) {
    case "codex-cli":
      return createCodexCommand(params);
    case "claude-cli":
      return createClaudeCommand(params);
    case "copilot-cli":
      return createCopilotCommand(params);
  }
};

const executeExternalAgentCliTask = async (
  params: ExternalAgentExecutionParams,
  provider: AgentCliProvider,
): Promise<TaskExecutionResult> => {
  const env = await loadWorkspaceEnv(params.config.workspaceRoot);
  const binary = resolveAgentCliProviderBinary(provider, env);
  const providerLabel = getAgentCliProviderLabel(provider);
  const loopState = createExternalAgentLoopState(params.contextSections);
  const executionConfig = {
    ...params.config,
    workspaceRoot: normalizeLocalCommandCwd(params.config.workspaceRoot),
  };

  if (!binary.available || !binary.executable) {
    return createExecutionResult(
      {
        task: params.task,
        mode: params.config.mode,
        status: "blocked",
        summary:
          `${providerLabel} execution could not start because the CLI binary was not found.`,
        executedTools: [],
        outputSections: [
          ...params.contextSections,
          {
            title: providerLabel,
            tone: "danger",
            lines: [
              binary.reason ??
                `${providerLabel} was not found on PATH and no configured binary path is available.`,
            ],
          },
        ],
      },
      binary.reason,
    );
  }

  const imagePaths = (params.imageInputs ?? []).map((imageInput) => imageInput.path);
  const delegationMode = getExternalAgentDelegationMode(params);
  const prompt = createExternalAgentPrompt(
    params.task,
    executionConfig,
    params.contextSections,
    params.preparedConversationContext,
    params.systemPromptSections ?? [],
    providerLabel,
    imagePaths,
    delegationMode,
  );
  const command = createExternalAgentCommand(
    provider,
    {
      config: executionConfig,
      prompt,
      imageInputs: params.imageInputs,
      delegationMode,
    },
  );

  await emitAgentProgress(
    params.task,
    params.config,
    "executing",
    command.startMessage,
    loopState,
    params.onStateChange,
    undefined,
    {
      timelineEvent: {
        kind: "model-call",
        phase: "started",
        label: providerLabel,
        detail: command.runDetail,
        tone: "info",
        provider,
        model: params.config.model,
        metadata: {
          binarySource: binary.source ?? "unknown",
          ...command.metadata,
        },
      },
    },
  );

  const startedAt = Date.now();
  const result = await runExternalAgentCommand(
    binary.executable,
    command.args,
    command.input,
    executionConfig,
    provider,
    params.signal,
    params.onActionOutput,
  );
  const stdout = cleanCliText(result.stdout);
  const stderr = cleanCliText(result.stderr);
  const durationMs = Date.now() - startedAt;
  const commandSection: TaskExecutionSection = {
    title: providerLabel,
    lines: [
      `binary: ${binary.executable}`,
      `binary source: ${binary.source ?? "unknown"}`,
      `model: ${params.config.model}`,
      `reasoning: ${params.config.reasoning}`,
      ...command.commandLines,
      `exit code: ${result.exitCode ?? "unknown"}`,
      ...(result.signal ? [`signal: ${result.signal}`] : []),
    ],
  };

  if (result.exitCode !== 0) {
    const reason = createExternalAgentFailureReason(
      providerLabel,
      stdout,
      stderr,
      result.exitCode,
    );

    await emitAgentProgress(
      params.task,
      params.config,
      "blocked",
      `${providerLabel} execution failed.`,
      loopState,
      params.onStateChange,
      undefined,
      {
        timelineEvent: {
          kind: "model-call",
          phase: "failed",
          label: providerLabel,
          detail: limitText(reason, 500),
          tone: "danger",
          provider,
          model: params.config.model,
          metadata: {
            durationMs,
          },
        },
      },
    );

    return createExecutionResult(
      {
        task: params.task,
        mode: params.config.mode,
        status: "blocked",
        summary: `${providerLabel} execution failed before completing the task.`,
        executedTools: ["shell"],
        outputSections: [
          ...params.contextSections,
          commandSection,
          createTextSection(`${providerLabel} diagnostics`, reason, 80),
        ],
      },
      reason,
    );
  }

  const answer =
    stdout ||
    `${providerLabel} completed successfully but did not print a final message.`;

  await emitAgentProgress(
    params.task,
    params.config,
    "verifying",
    `${providerLabel} completed.`,
    {
      ...loopState,
      executedTools: ["shell"],
      lastAssistantText: answer,
    },
    params.onStateChange,
    undefined,
    {
      assistantText: limitText(answer, 4_000),
      timelineEvent: {
        kind: "model-call",
        phase: "completed",
        label: providerLabel,
        detail: command.successDetail,
        tone: "success",
        provider,
        model: params.config.model,
        metadata: {
          durationMs,
        },
      },
    },
  );

  return createExecutionResult({
    task: params.task,
    mode: params.config.mode,
    status: "executed",
    summary: normalizeFinalSummary(answer),
    executedTools: ["shell"],
    outputSections: [
      ...params.contextSections,
      commandSection,
      createTextSection(`${providerLabel} answer`, answer, 120),
      ...(stderr
        ? [createTextSection(`${providerLabel} diagnostics`, limitText(stderr, MAX_DIAGNOSTIC_CHARS), 80)]
        : []),
    ],
    response: {
      markdown: answer,
      highlights: [],
      relatedFiles: [],
      verification: [],
      followUps: [],
    },
  });
};

export const maybeExecuteExternalAgentProviderTask = async (
  params: ExternalAgentExecutionParams,
): Promise<TaskExecutionResult | undefined> => {
  if (!isAgentCliProvider(params.config.provider)) {
    return undefined;
  }

  return await executeExternalAgentCliTask(params, params.config.provider);
};
