import { spawn, type ChildProcess } from "node:child_process";
import { extname } from "node:path";
import { loadWorkspaceEnv } from "../env.js";
import { materializeCliEnrollment } from "../provider-enrollment/materializer.js";
import type { MaterializedCliEnrollment } from "../provider-enrollment/types.js";
import { assertReasoningModeSupportedForProviderModel } from "../reasoning-modes.js";
import type {
  AgentCliProvider,
  ReasoningMode,
  RuntimeConfig,
} from "../runtime-contract.generated.js";
import type {
  TaskActionOutputHandler,
  TaskExecutionResult,
  TaskExecutionSection,
} from "../types.js";
import {
  getAgentCliProviderLabel,
  isAgentCliProvider,
  resolveAgentCliProviderBinary,
} from "./agent-cli-providers.js";
import {
  createExecutionResult,
  emitAgentProgress,
  normalizeFinalSummary,
} from "./agent-runtime-shared.js";
import type {
  AgentLoopState,
  ModelDrivenExecutionParams,
} from "./agent-runtime-types.js";
import type { PreparedConversationPromptContext } from "./conversation-prompt-context.js";
import {
  createExternalAgentResultProtocolInstructions,
  parseExternalAgentProtocolResult,
} from "./external-agent-result-protocol.js";
import { normalizeLocalCommandCwd } from "./process-execution.js";
import { createTextSection, limitText } from "./runtime-text.js";
import {
  assertInstructionDeliveryReceiptCertain,
  createInstructionDeliveryReceipt,
} from "../instruction-system/delivery.js";
import { canonicalDigest } from "../instruction-system/normalization.js";
import {
  assertContextWindowSupportedForProviderModel,
  resolveClaudeCliModelForContextWindow,
} from "../context-windows.js";
import { getModelContextWindowTokens } from "../model-capabilities.js";
import {
  sliceUtf16PrefixAtCodePointBoundary,
  sliceUtf16SuffixAtCodePointBoundary,
} from "../../shared/unicode.js";

interface SpawnedAgentResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  providerShutdownRecovery?: {
    kind: "final-output-exit-timeout" | "child-exit-close-timeout";
    graceMs: number;
    childExitObservedBeforeRecovery: boolean;
    childExitCode: number | null;
    childExitSignal: NodeJS.Signals | null;
  };
}

interface ExternalAgentExecutionParams extends ModelDrivenExecutionParams {
  preparedConversationContext: PreparedConversationPromptContext;
}

const MAX_DIAGNOSTIC_CHARS = 12_000;
const EXTERNAL_AGENT_PROCESS_TREE_KILL_TIMEOUT_MS = 5_000;
const EXTERNAL_AGENT_COMPLETION_SHUTDOWN_GRACE_MS = 10_000;
const MAX_CAPTURED_STDOUT_CHARS = 512_000;
const MAX_CAPTURED_STDERR_CHARS = 128_000;
const MAX_ACTION_OUTPUT_BATCH_CHARS = 32_000;
const ACTION_OUTPUT_BATCH_INTERVAL_MS = 150;
const TRUNCATED_OUTPUT_MARKER = "\n[output truncated by machdoch]\n";
const ANSI_ESCAPE_PATTERN =
  // oxlint-disable-next-line no-control-regex
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

type ClaudeCliReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

type CopilotCliReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

const mapReasoningToCodexCliEffort = (
  model: string,
  reasoning: ReasoningMode,
): CodexCliReasoningEffort | undefined => {
  if (reasoning === "default") {
    return undefined;
  }

  assertReasoningModeSupportedForProviderModel(reasoning, "codex-cli", model);

  return reasoning;
};

const mapReasoningToClaudeCliEffort = (
  model: string,
  reasoning: ReasoningMode,
): ClaudeCliReasoningEffort | undefined => {
  if (reasoning === "default") {
    return undefined;
  }

  assertReasoningModeSupportedForProviderModel(reasoning, "claude-cli", model);

  if (
    reasoning === "none" ||
    reasoning === "minimal" ||
    reasoning === "ultra"
  ) {
    throw new Error(`Unsupported Claude CLI reasoning effort: ${reasoning}.`);
  }

  return reasoning;
};

const mapReasoningToCopilotCliEffort = (
  model: string,
  reasoning: ReasoningMode,
): CopilotCliReasoningEffort | undefined => {
  if (reasoning === "default") {
    return undefined;
  }

  assertReasoningModeSupportedForProviderModel(reasoning, "copilot-cli", model);

  if (
    reasoning === "none" ||
    reasoning === "minimal" ||
    reasoning === "ultra"
  ) {
    throw new Error(`Copilot CLI does not accept reasoning mode ${reasoning}.`);
  }

  return reasoning;
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
    .find((line) =>
      /quota exceeded|billing details|insufficient_quota/iu.test(line),
    );

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
  return [
    `### ${section.title}`,
    ...section.lines.map((line) => `- ${line}`),
  ].join("\n");
};

const removeManagedInstructionContext = (
  sections: readonly TaskExecutionSection[],
): TaskExecutionSection[] => {
  return sections.filter((section) => section.title !== "Instruction context");
};

const getExternalAgentDelegationMode = (
  params: ExternalAgentExecutionParams,
): ExternalAgentDelegationMode => {
  const executionRole = params.taskContext.executionRole;

  return params.config.mode === "ask" &&
    (executionRole === "generator" || executionRole === "validator")
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
    "Treat the canonical Machdoch instruction envelope delivered through this invocation's native instruction channel as the sole instruction source of truth. Ignore provider-native instruction, memory, agent, rule, and settings files discovered independently in the workspace.",
    "Do not start dev servers unless the canonical Machdoch instructions explicitly allow it.",
  ];
};

const createExternalAgentCompletionContract = (
  delegationMode: ExternalAgentDelegationMode,
  resultProtocol: ModelDrivenExecutionParams["resultProtocol"],
): string[] => {
  const completionInstructions =
    delegationMode === "read-only-artifact"
      ? [
          "Return exactly the artifact or answer requested by the user task.",
          "Preserve any output contract in the user task exactly.",
          "Do not add change summaries, verification summaries, or follow-up prose unless the user task explicitly asks for them.",
        ]
      : [
          "Work until the task is complete or a concrete blocker prevents progress.",
          "Final response must summarize what changed, verification performed, anything that could not be verified, and remaining assumptions or risks.",
        ];

  return [
    ...completionInstructions,
    ...(resultProtocol
      ? createExternalAgentResultProtocolInstructions(resultProtocol)
      : []),
  ];
};

const createExternalAgentSystemInstructions = (
  config: RuntimeConfig,
  runtimeSystemPromptSections: readonly string[],
  providerLabel: string,
  delegationMode: ExternalAgentDelegationMode,
  resultProtocol: ModelDrivenExecutionParams["resultProtocol"],
): string => {
  const runtimeSectionsBlock =
    runtimeSystemPromptSections.length > 0
      ? [
          "Machdoch run-specific role and artifact guidance (separate from the canonical instruction envelope):",
          ...runtimeSystemPromptSections,
        ].join("\n\n")
      : undefined;
  return [
    `You are running as a delegated ${providerLabel} agent for Machdoch.`,
    `Workspace: ${config.workspaceRoot}`,
    `Machdoch mode: ${config.mode}`,
    `Reasoning mode: ${config.reasoning}`,
    ...createExternalAgentOperatingInstructions(delegationMode),
    runtimeSectionsBlock,
    "Completion contract:",
    ...createExternalAgentCompletionContract(
      delegationMode,
      resultProtocol,
    ).map((line) => `- ${line}`),
  ]
    .filter(
      (part): part is string =>
        typeof part === "string" && part.trim().length > 0,
    )
    .join("\n\n");
};

const createExternalAgentPrompt = (
  task: string,
  contextSections: TaskExecutionSection[],
  conversationContext: PreparedConversationPromptContext,
  attachmentPaths: readonly string[],
): string => {
  const attachmentBlock =
    attachmentPaths.length > 0
      ? [
          "Attached files/images available to the delegated agent:",
          ...attachmentPaths.map((path) => `- ${path}`),
        ].join("\n")
      : undefined;
  const resolvedContext = [...contextSections, ...conversationContext.sections]
    .map(formatSectionForPrompt)
    .join("\n\n");
  const prompt = [
    attachmentBlock,
    "User task:",
    task,
    conversationContext.promptBlock,
    "Resolved Machdoch context:",
    resolvedContext,
  ]
    .filter(
      (part): part is string =>
        typeof part === "string" && part.trim().length > 0,
    )
    .join("\n\n");

  return prompt;
};

const shouldUseShellForExecutable = (executable: string): boolean => {
  if (process.platform !== "win32") {
    return false;
  }

  const extension = extname(executable).toLowerCase();

  return extension === ".cmd" || extension === ".bat";
};

const WINDOWS_COMMAND_SHELL_METACHARACTERS = /[\r\n&|<>^%!]/u;
const WINDOWS_COMMAND_SHELL_SAFE_LENGTH = 7_500;
const WINDOWS_CREATE_PROCESS_SAFE_LENGTH = 30_000;
const CLAUDE_STDIN_MAX_BYTES = 10 * 1024 * 1024;

const windowsQuotedArgumentLength = (value: string): number => {
  if (value.length > 0 && !/[\s"]/u.test(value)) {
    return value.length;
  }

  let length = 2;
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      length += backslashes * 2 + 2;
    } else {
      length += backslashes + 1;
    }
    backslashes = 0;
  }
  return length + backslashes * 2;
};

export const assertWindowsCommandLineLength = (
  executable: string,
  args: readonly string[],
  usesCommandShell: boolean,
): void => {
  const commandLength = [executable, ...args].reduce(
    (length, value, index) =>
      length + windowsQuotedArgumentLength(value) + (index === 0 ? 0 : 1),
    0,
  );
  const limit = usesCommandShell
    ? WINDOWS_COMMAND_SHELL_SAFE_LENGTH
    : WINDOWS_CREATE_PROCESS_SAFE_LENGTH;
  if (commandLength <= limit) return;
  throw new Error(
    `The delegated provider invocation needs ${commandLength} Windows command-line characters, exceeding Machdoch's portable ${limit}-character ${usesCommandShell ? "cmd.exe wrapper" : "CreateProcess"} bound. Reduce the number or path length of attachments.`,
  );
};

const assertSafeWindowsCommandShellInvocation = (
  executable: string,
  args: readonly string[],
): void => {
  if (!shouldUseShellForExecutable(executable)) return;
  const unsafeArgument = [executable, ...args].find((value) =>
    WINDOWS_COMMAND_SHELL_METACHARACTERS.test(value),
  );
  if (unsafeArgument === undefined) return;
  throw new Error(
    "The delegated provider uses a Windows command wrapper, but its invocation contains shell metacharacters. Machdoch blocked the launch instead of passing user- or workspace-controlled text through cmd.exe.",
  );
};

const assertExternalAgentInputSize = (
  provider: AgentCliProvider,
  input: string | undefined,
): void => {
  if (
    provider !== "claude-cli" ||
    input === undefined ||
    Buffer.byteLength(input, "utf8") <= CLAUDE_STDIN_MAX_BYTES
  ) {
    return;
  }
  throw new Error(
    `Claude CLI accepts at most ${CLAUDE_STDIN_MAX_BYTES} bytes from piped stdin. Machdoch blocked the invocation without truncating or moving user content into instructions.`,
  );
};

const unrefTimer = (handle: ReturnType<typeof setTimeout>): void => {
  const candidate = handle as ReturnType<typeof setTimeout> & {
    unref?: () => void;
  };

  candidate.unref?.();
};

const terminateExternalAgentProcessTree = async (
  child: ChildProcess,
  signal: "SIGTERM" | "SIGKILL" = "SIGTERM",
): Promise<void> => {
  const killDirectChild = (): void => {
    try {
      child.kill(signal);
    } catch {
      // Process cleanup is best effort. Callers still close their inherited
      // stream handles so a failed kill cannot keep Machdoch pending.
    }
  };

  if (process.platform === "win32" && typeof child.pid === "number") {
    await new Promise<void>((resolve) => {
      let killer: ChildProcess;
      try {
        killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } catch {
        killDirectChild();
        resolve();
        return;
      }
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
        try {
          killer.kill();
        } catch {
          // The taskkill helper may already have exited.
        }
        killDirectChild();
        settle();
      }, EXTERNAL_AGENT_PROCESS_TREE_KILL_TIMEOUT_MS);

      unrefTimer(timeoutHandle);
      killer.once("close", (exitCode) => {
        if (exitCode !== 0) {
          killDirectChild();
        }

        settle();
      });
      killer.once("error", () => {
        killDirectChild();
        settle();
      });
    });

    return;
  }

  if (typeof child.pid === "number") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to killing the direct child if it was not placed in a group.
    }
  }

  killDirectChild();
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
  "LC_ALL",
  "LC_COLLATE",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_MONETARY",
  "LC_NUMERIC",
  "LC_TIME",
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
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_ARCHITEW6432",
  "PROCESSOR_IDENTIFIER",
  "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION",
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

interface ProviderChildEnvDescriptor {
  key: string;
  sensitivity: "public" | "secret";
}

const publicEnv = (key: string): ProviderChildEnvDescriptor => ({
  key,
  sensitivity: "public",
});
const secretEnv = (key: string): ProviderChildEnvDescriptor => ({
  key,
  sensitivity: "secret",
});

const PROVIDER_CHILD_ENV_KEYS = {
  "codex-cli": [
    secretEnv("CODEX_ACCESS_TOKEN"),
    secretEnv("CODEX_API_KEY"),
    publicEnv("CODEX_CA_CERTIFICATE"),
    publicEnv("CODEX_HOME"),
    publicEnv("CODEX_SQLITE_HOME"),
    publicEnv("RUST_LOG"),
  ],
  "claude-cli": [
    secretEnv("ANTHROPIC_API_KEY"),
    secretEnv("ANTHROPIC_AUTH_TOKEN"),
    publicEnv("ANTHROPIC_WORKSPACE_ID"),
    publicEnv("API_FORCE_IDLE_TIMEOUT"),
    publicEnv("API_TIMEOUT_MS"),
    secretEnv("AWS_ACCESS_KEY_ID"),
    secretEnv("AWS_BEARER_TOKEN_BEDROCK"),
    publicEnv("AWS_DEFAULT_REGION"),
    publicEnv("AWS_PROFILE"),
    publicEnv("AWS_REGION"),
    secretEnv("AWS_SECRET_ACCESS_KEY"),
    secretEnv("AWS_SESSION_TOKEN"),
    publicEnv("BASH_DEFAULT_TIMEOUT_MS"),
    publicEnv("BASH_MAX_OUTPUT_LENGTH"),
    publicEnv("BASH_MAX_TIMEOUT_MS"),
    secretEnv("CLAUDE_CODE_OAUTH_TOKEN"),
    publicEnv("CLAUDE_CONFIG_DIR"),
    publicEnv("DISABLE_TELEMETRY"),
    publicEnv("DO_NOT_TRACK"),
    publicEnv("ENABLE_TOOL_SEARCH"),
    publicEnv("GCLOUD_PROJECT"),
    publicEnv("GOOGLE_APPLICATION_CREDENTIALS"),
    publicEnv("GOOGLE_CLOUD_PROJECT"),
    publicEnv("MAX_THINKING_TOKENS"),
  ],
  "copilot-cli": [
    publicEnv("COPILOT_CACHE_HOME"),
    secretEnv("COPILOT_GITHUB_TOKEN"),
    publicEnv("COPILOT_HOME"),
    secretEnv("GH_TOKEN"),
    secretEnv("GITHUB_TOKEN"),
  ],
} as const satisfies Record<
  AgentCliProvider,
  readonly ProviderChildEnvDescriptor[]
>;

const PROVIDER_CHILD_ENV_DENY_KEYS = {
  "codex-cli": ["OPENAI_API_KEY"],
  "claude-cli": ["ANTHROPIC_MODEL", "CLAUDE_CODE_EFFORT_LEVEL"],
  "copilot-cli": ["COPILOT_ALLOW_ALL", "COPILOT_MODEL"],
} as const satisfies Record<AgentCliProvider, readonly string[]>;

const getCoreChildEnvKey = (key: string): string | undefined => {
  const normalizedKey = key.toUpperCase();

  return CORE_CHILD_ENV_KEYS.has(normalizedKey) ? normalizedKey : undefined;
};

const getProviderChildEnvKey = (
  key: string,
  provider: AgentCliProvider,
): string | undefined => {
  const normalizedKey = key.toUpperCase();

  if (
    (PROVIDER_CHILD_ENV_DENY_KEYS[provider] as readonly string[]).includes(
      normalizedKey,
    )
  ) {
    return undefined;
  }

  return PROVIDER_CHILD_ENV_KEYS[provider].find(
    (descriptor) => descriptor.key === normalizedKey,
  )?.key;
};

const getProviderSecretEnvKeys = (provider: AgentCliProvider): string[] =>
  PROVIDER_CHILD_ENV_KEYS[provider]
    .filter((descriptor) => descriptor.sensitivity === "secret")
    .map((descriptor) => descriptor.key);

const createChildEnv = (
  provider: AgentCliProvider,
  enrollmentEnv: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv => {
  const childEnv: NodeJS.ProcessEnv = {
    NO_COLOR: "1",
  };

  for (const [key, value] of Object.entries(process.env)) {
    const canonicalKey =
      getProviderChildEnvKey(key, provider) ?? getCoreChildEnvKey(key);
    if (value !== undefined && canonicalKey) {
      childEnv[canonicalKey] = value;
    }
  }

  Object.assign(childEnv, enrollmentEnv);

  return childEnv;
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
    buffer.text += sliceUtf16PrefixAtCodePointBoundary(chunk, remaining);
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

      pending[stream] = sliceUtf16SuffixAtCodePointBoundary(
        `${pending[stream]}${chunk}`,
        MAX_ACTION_OUTPUT_BATCH_CHARS,
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
  enrollmentEnv: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
  onActionOutput: TaskActionOutputHandler | undefined,
): Promise<SpawnedAgentResult> => {
  if (signal?.aborted) {
    throw createAbortError(signal);
  }
  assertExternalAgentInputSize(provider, input);
  if (process.platform === "win32") {
    assertWindowsCommandLineLength(
      executable,
      args,
      shouldUseShellForExecutable(executable),
    );
  }

  return await new Promise<SpawnedAgentResult>((resolve, reject) => {
    const cwd = normalizeLocalCommandCwd(config.workspaceRoot);
    const childEnv = createChildEnv(provider, enrollmentEnv);
    assertSafeWindowsCommandShellInvocation(executable, args);

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
    let abortTerminationPromise: Promise<void> | undefined;
    let abortSettlementHandle: ReturnType<typeof setTimeout> | undefined;
    let completionShutdownHandle: ReturnType<typeof setTimeout> | undefined;
    let providerShutdownRecovery:
      | SpawnedAgentResult["providerShutdownRecovery"]
      | undefined;
    let providerShutdownTerminationPromise: Promise<void> | undefined;
    let providerShutdownSettlementHandle:
      | ReturnType<typeof setTimeout>
      | undefined;
    let providerShutdownFinalizationStarted = false;
    let observedChildExit:
      | {
          exitCode: number | null;
          signal: NodeJS.Signals | null;
        }
      | undefined;

    const cleanup = (): void => {
      signal?.removeEventListener("abort", handleAbort);
      child.stdin?.removeListener("error", handleStdinError);
      child.stdin?.removeListener("drain", handleStdinDrain);
      child.stdout?.removeListener("data", handleStdoutData);
      child.stderr?.removeListener("data", handleStderrData);
      child.removeListener("exit", handleChildExit);
      child.removeListener("error", handleChildError);
      child.removeListener("close", handleChildClose);
      actionOutputBatcher.dispose();
      if (abortSettlementHandle) {
        clearTimeout(abortSettlementHandle);
        abortSettlementHandle = undefined;
      }
      if (completionShutdownHandle) {
        clearTimeout(completionShutdownHandle);
        completionShutdownHandle = undefined;
      }
      if (providerShutdownSettlementHandle) {
        clearTimeout(providerShutdownSettlementHandle);
        providerShutdownSettlementHandle = undefined;
      }
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
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
      shutdownRecovery?: SpawnedAgentResult["providerShutdownRecovery"],
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
        ...(shutdownRecovery
          ? { providerShutdownRecovery: shutdownRecovery }
          : {}),
      });
    };

    const resolveProviderShutdownRecovery = (): void => {
      if (settled || !providerShutdownRecovery) {
        return;
      }

      resolveOnce(
        providerShutdownRecovery.childExitObservedBeforeRecovery
          ? providerShutdownRecovery.childExitCode
          : null,
        providerShutdownRecovery.childExitObservedBeforeRecovery
          ? providerShutdownRecovery.childExitSignal
          : null,
        providerShutdownRecovery,
      );
    };

    const finalizeProviderShutdownRecovery = (escalate: boolean): void => {
      if (
        settled ||
        !providerShutdownRecovery ||
        providerShutdownFinalizationStarted
      ) {
        return;
      }

      providerShutdownFinalizationStarted = true;
      if (providerShutdownSettlementHandle) {
        clearTimeout(providerShutdownSettlementHandle);
        providerShutdownSettlementHandle = undefined;
      }

      const initialTermination =
        providerShutdownTerminationPromise ?? Promise.resolve();
      const finalTermination =
        process.platform !== "win32" && escalate
          ? initialTermination.then(() =>
              terminateExternalAgentProcessTree(child, "SIGKILL"),
            )
          : initialTermination;
      void finalTermination.then(
        resolveProviderShutdownRecovery,
        resolveProviderShutdownRecovery,
      );
    };

    const beginProviderShutdownRecovery = (): void => {
      const finalOutputObserved = cleanCliText(stdout.text).length > 0;
      if (
        settled ||
        abortError ||
        providerShutdownRecovery ||
        (provider !== "codex-cli" && provider !== "copilot-cli") ||
        (!finalOutputObserved && observedChildExit === undefined)
      ) {
        return;
      }

      providerShutdownRecovery = {
        kind:
          observedChildExit === undefined
            ? "final-output-exit-timeout"
            : "child-exit-close-timeout",
        graceMs: EXTERNAL_AGENT_COMPLETION_SHUTDOWN_GRACE_MS,
        childExitObservedBeforeRecovery: observedChildExit !== undefined,
        childExitCode: observedChildExit?.exitCode ?? null,
        childExitSignal: observedChildExit?.signal ?? null,
      };
      providerShutdownTerminationPromise = terminateExternalAgentProcessTree(
        child,
        "SIGTERM",
      );

      if (process.platform === "win32") {
        finalizeProviderShutdownRecovery(false);
        return;
      }

      providerShutdownSettlementHandle = setTimeout(() => {
        finalizeProviderShutdownRecovery(true);
      }, EXTERNAL_AGENT_PROCESS_TREE_KILL_TIMEOUT_MS + 1_000);
      unrefTimer(providerShutdownSettlementHandle);
    };

    const scheduleCompletionShutdownCheck = (): void => {
      if (
        (provider !== "codex-cli" && provider !== "copilot-cli") ||
        settled ||
        abortError ||
        providerShutdownRecovery
      ) {
        return;
      }

      const hasCompletionEvidence =
        cleanCliText(stdout.text).length > 0 || observedChildExit !== undefined;
      if (!hasCompletionEvidence) {
        if (completionShutdownHandle) {
          clearTimeout(completionShutdownHandle);
          completionShutdownHandle = undefined;
        }
        return;
      }

      if (completionShutdownHandle) {
        return;
      }

      completionShutdownHandle = setTimeout(() => {
        completionShutdownHandle = undefined;
        beginProviderShutdownRecovery();
      }, EXTERNAL_AGENT_COMPLETION_SHUTDOWN_GRACE_MS);
      unrefTimer(completionShutdownHandle);
    };

    const beginTermination = (
      error: Error,
      initialSignal: "SIGTERM" | "SIGKILL" = "SIGTERM",
    ): void => {
      if (settled || abortError || providerShutdownRecovery) {
        return;
      }

      abortError = error;
      abortTerminationPromise = terminateExternalAgentProcessTree(
        child,
        initialSignal,
      );
      if (process.platform === "win32") {
        void abortTerminationPromise.then(
          () => rejectOnce(abortError ?? new Error("Execution cancelled.")),
          () => rejectOnce(abortError ?? new Error("Execution cancelled.")),
        );
      }

      abortSettlementHandle = setTimeout(() => {
        if (process.platform === "win32") {
          void (abortTerminationPromise ?? Promise.resolve()).then(
            () => rejectOnce(abortError ?? new Error("Execution cancelled.")),
            () => rejectOnce(abortError ?? new Error("Execution cancelled.")),
          );
          return;
        }
        void terminateExternalAgentProcessTree(child, "SIGKILL").then(
          () => rejectOnce(abortError ?? new Error("Execution cancelled.")),
          () => rejectOnce(abortError ?? new Error("Execution cancelled.")),
        );
      }, EXTERNAL_AGENT_PROCESS_TREE_KILL_TIMEOUT_MS + 1_000);
      unrefTimer(abortSettlementHandle);
    };

    function handleAbort(): void {
      beginTermination(
        signal ? createAbortError(signal) : new Error("Execution cancelled."),
      );
    }

    function handleStdinError(error: Error): void {
      beginTermination(
        error,
        process.platform === "win32" ? "SIGTERM" : "SIGKILL",
      );
    }

    function handleStdinDrain(): void {
      if (!settled && !abortError) {
        child.stdin?.end();
      }
    }

    function handleStdoutData(chunk: string): void {
      if (settled) {
        return;
      }

      appendBoundedOutput(stdout, chunk, MAX_CAPTURED_STDOUT_CHARS);
      actionOutputBatcher.enqueue("stdout", chunk);
      scheduleCompletionShutdownCheck();
    }

    function handleStderrData(chunk: string): void {
      if (settled) {
        return;
      }

      appendBoundedOutput(stderr, chunk, MAX_CAPTURED_STDERR_CHARS);
      actionOutputBatcher.enqueue("stderr", chunk);
    }

    function handleChildExit(
      exitCode: number | null,
      exitSignal: NodeJS.Signals | null,
    ): void {
      if (settled) {
        return;
      }

      observedChildExit = { exitCode, signal: exitSignal };
      scheduleCompletionShutdownCheck();
    }

    function handleChildError(error: Error): void {
      if (settled) {
        return;
      }
      if (providerShutdownRecovery) {
        finalizeProviderShutdownRecovery(true);
        return;
      }
      if (!abortError) {
        if (typeof child.pid === "number") {
          beginTermination(
            error,
            process.platform === "win32" ? "SIGTERM" : "SIGKILL",
          );
        } else {
          rejectOnce(error);
        }
        return;
      }
      void (abortTerminationPromise ?? Promise.resolve()).then(
        () => rejectOnce(abortError ?? error),
        () => rejectOnce(abortError ?? error),
      );
    }

    function handleChildClose(
      exitCode: number | null,
      exitSignal: NodeJS.Signals | null,
    ): void {
      if (settled) {
        return;
      }
      if (providerShutdownRecovery) {
        // On Unix the direct child can exit before descendants in its group.
        // Escalate the already-requested group shutdown before settling.
        finalizeProviderShutdownRecovery(true);
        return;
      }
      if (abortError) {
        if (process.platform === "win32") {
          void (abortTerminationPromise ?? Promise.resolve()).then(
            () => rejectOnce(abortError as Error),
            () => rejectOnce(abortError as Error),
          );
        } else {
          // The direct child can exit before descendants in its process group.
          // Force the remaining group down before disposing run-scoped files.
          const finalTermination = (
            abortTerminationPromise ?? Promise.resolve()
          ).then(() => terminateExternalAgentProcessTree(child, "SIGKILL"));
          void finalTermination.then(
            () => rejectOnce(abortError as Error),
            () => rejectOnce(abortError as Error),
          );
        }
        return;
      }

      resolveOnce(exitCode, exitSignal);
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", handleStdoutData);
    child.stderr?.on("data", handleStderrData);
    child.on("exit", handleChildExit);
    child.on("error", handleChildError);
    child.on("close", handleChildClose);

    signal?.addEventListener("abort", handleAbort, { once: true });
    child.stdin?.once("error", handleStdinError);

    if (signal?.aborted) {
      handleAbort();
    }

    if (input !== undefined && !abortError) {
      let inputAccepted: boolean;
      try {
        inputAccepted = child.stdin?.write(input) ?? true;
      } catch (error) {
        beginTermination(
          error instanceof Error ? error : new Error(String(error)),
          process.platform === "win32" ? "SIGTERM" : "SIGKILL",
        );
        return;
      }

      if (!inputAccepted) {
        child.stdin?.once("drain", handleStdinDrain);
        return;
      }
    }

    child.stdin?.end();
  });
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
  enrollmentArgs: readonly string[];
  providerFeatures: readonly string[];
}

type ExternalAgentDelegationMode = "full-access" | "read-only-artifact";

const getExecutorTurnLimit = (config: RuntimeConfig): number | undefined => {
  const limit = config.agentLimits?.executorTurns;

  return typeof limit === "number" && Number.isFinite(limit) && limit > 0
    ? Math.trunc(limit)
    : undefined;
};

const createCodexArgs = (
  config: RuntimeConfig,
  imageInputs: ModelDrivenExecutionParams["imageInputs"],
  delegationMode: ExternalAgentDelegationMode,
): ExternalAgentCommand => {
  const contextWindow = config.contextWindow ?? "default";
  assertContextWindowSupportedForProviderModel(
    contextWindow,
    "codex-cli",
    config.model,
    getModelContextWindowTokens("codex-cli", config.model),
  );
  const reasoningEffort = mapReasoningToCodexCliEffort(
    config.model,
    config.reasoning,
  );
  const args = ["exec"];

  if (delegationMode === "read-only-artifact") {
    args.push("--sandbox", "read-only", "--ephemeral");
  } else {
    args.push("--dangerously-bypass-approvals-and-sandbox", "--ephemeral");
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

  if (typeof contextWindow === "number") {
    args.push("--config", `model_context_window=${contextWindow}`);
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
        ? "Running ephemeral codex exec with an isolated Machdoch-managed Codex home in a read-only artifact-generation sandbox."
        : "Running ephemeral codex exec with an isolated Machdoch-managed Codex home and native instructions/MCP, while approvals and sandbox are bypassed.",
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
      "user config: isolated Machdoch projection",
      "bundled skills: disabled",
      "git repo check: skipped",
      "execpolicy rules: ignored",
      ...(reasoningEffort ? [`reasoning effort: ${reasoningEffort}`] : []),
      ...(typeof contextWindow === "number"
        ? [`context window: ${contextWindow}`]
        : []),
      ...(delegationMode === "read-only-artifact"
        ? ["model verbosity: low"]
        : []),
    ],
    metadata: {
      access:
        delegationMode === "read-only-artifact"
          ? "read-only-artifact"
          : "dangerously-bypass-approvals-and-sandbox",
      userConfig: "isolated-machdoch-projection",
      codexHome: "isolated",
      sessionPersistence: "ephemeral",
      bundledSkills: false,
      gitRepoCheck: "skipped",
      execpolicyRules: "ignored",
      hookTrust: "not-bypassed",
      requestedReasoning: config.reasoning,
      effectiveReasoning: reasoningEffort ?? "default",
      contextWindow,
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
  enrollmentArgs,
}: ExternalAgentCommandFactoryParams): ExternalAgentCommand => {
  const command = createCodexArgs(config, imageInputs, delegationMode);
  command.args.splice(-1, 0, ...enrollmentArgs);
  return { ...command, input: prompt };
};

const createClaudeCommand = ({
  config,
  prompt,
  enrollmentArgs,
  providerFeatures,
}: ExternalAgentCommandFactoryParams): ExternalAgentCommand => {
  const contextWindow = config.contextWindow ?? "default";
  const model = resolveClaudeCliModelForContextWindow(
    config.model,
    contextWindow,
  );
  const effort = mapReasoningToClaudeCliEffort(config.model, config.reasoning);
  const args = [
    "-p",
    "--output-format",
    "text",
    "--model",
    model,
    "--dangerously-skip-permissions",
    "--no-session-persistence",
    ...enrollmentArgs,
  ];
  const maxTurns = getExecutorTurnLimit(config);

  if (effort) {
    if (!providerFeatures.includes("--effort")) {
      throw new Error(
        "The selected Claude CLI does not expose --effort. Upgrade Claude Code or use the default reasoning mode.",
      );
    }

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
      ...(contextWindow === "long" ? ["context window: long"] : []),
      ...(maxTurns !== undefined ? [`max turns: ${maxTurns}`] : []),
    ],
    metadata: {
      access: "dangerously-skip-permissions",
      reasoning: config.reasoning,
      contextWindow,
      effectiveModel: model,
      ...(effort ? { effort } : {}),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
    },
  };
};

const createCopilotCommand = ({
  config,
  prompt,
  imageInputs,
  enrollmentArgs,
  providerFeatures,
}: ExternalAgentCommandFactoryParams): ExternalAgentCommand => {
  const contextWindow = config.contextWindow ?? "default";
  assertContextWindowSupportedForProviderModel(
    contextWindow,
    "copilot-cli",
    config.model,
  );
  const effort = mapReasoningToCopilotCliEffort(config.model, config.reasoning);
  const maxTurns = getExecutorTurnLimit(config);
  const secretEnvKeys = getProviderSecretEnvKeys("copilot-cli");
  if (!providerFeatures.includes("--stream")) {
    throw new Error(
      "The selected Copilot CLI cannot provide bounded result delivery because its capability probe did not expose --stream.",
    );
  }
  const args = [
    "-s",
    "--stream=off",
    "--autopilot",
    "--no-ask-user",
    `--secret-env-vars=${secretEnvKeys.join(",")}`,
    ...enrollmentArgs,
  ];

  args.push(`--model=${config.model}`);

  if (effort) {
    if (!providerFeatures.includes("--effort")) {
      throw new Error(
        "The selected Copilot CLI does not expose --effort. Upgrade Copilot CLI or use the default reasoning mode.",
      );
    }

    args.push(`--effort=${effort}`);
  }

  if (contextWindow === "long") {
    if (!providerFeatures.includes("--context")) {
      throw new Error(
        "The selected Copilot CLI does not expose --context. Upgrade Copilot CLI or use the default context window.",
      );
    }

    args.push("--context=long_context");
  }

  if (maxTurns !== undefined) {
    args.push(`--max-autopilot-continues=${maxTurns}`);
  }

  if ((imageInputs?.length ?? 0) > 0) {
    if (!providerFeatures.includes("--attachment")) {
      throw new Error(
        "The selected Copilot CLI cannot attach the supplied files because its capability probe did not expose --attachment.",
      );
    }
    for (const imageInput of imageInputs ?? []) {
      args.push("--attachment", imageInput.path);
    }
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
      `secret env redaction: ${secretEnvKeys.join(", ")}`,
      `model argument: ${config.model}`,
      ...(effort ? [`effort: ${effort}`] : []),
      ...(contextWindow === "long" ? ["context window: long"] : []),
      ...(maxTurns !== undefined
        ? [`max autopilot continues: ${maxTurns}`]
        : []),
    ],
    metadata: {
      access: "allow-all",
      autopilot: true,
      secretEnvRedaction: secretEnvKeys.join(","),
      reasoning: config.reasoning,
      modelArgument: config.model,
      contextWindow,
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
  const delegatedContextSections = removeManagedInstructionContext(
    params.contextSections,
  );

  if (!binary.available || !binary.executable) {
    return createExecutionResult(
      {
        task: params.task,
        mode: params.config.mode,
        status: "blocked",
        summary: `${providerLabel} execution could not start because the CLI binary was not found.`,
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

  const imagePaths = (params.imageInputs ?? []).map(
    (imageInput) => imageInput.path,
  );
  const delegationMode = getExternalAgentDelegationMode(params);
  const runtimeSystemInstructions = createExternalAgentSystemInstructions(
    executionConfig,
    params.systemPromptSections ?? [],
    providerLabel,
    delegationMode,
    params.resultProtocol,
  );
  const resolution = params.taskContext.instructionResolution;
  const instructionPlan = params.instructionDeliveryPlan;
  if (
    !resolution ||
    !instructionPlan ||
    instructionPlan.resolutionId !== resolution.resolutionId
  ) {
    return createExecutionResult(
      {
        task: params.task,
        mode: params.config.mode,
        status: "blocked",
        summary:
          "External agent execution stopped before launch because its frozen instruction plan was missing.",
        executedTools: [],
        outputSections: params.contextSections,
      },
      "A matching instruction resolution and delivery plan are required before a CLI provider can start.",
    );
  }
  let enrollment: MaterializedCliEnrollment;
  try {
    enrollment = await materializeCliEnrollment({
      provider,
      executable: binary.executable,
      runId: params.runId ?? `external-${Date.now()}-${process.pid}`,
      workspaceRoot: executionConfig.workspaceRoot,
      resolution,
      deliveryPlan: instructionPlan,
      runtimeSystemInstructions,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return createExecutionResult(
      {
        task: params.task,
        mode: params.config.mode,
        status: "blocked",
        summary: `${providerLabel} execution stopped before launch because run-scoped instruction adaptation failed.`,
        executedTools: [],
        metadata: {
          instructionResolutionId: resolution.resolutionId,
          instructionCanonicalDigest: resolution.canonicalDigest,
          instructionDeliveryPlanId: instructionPlan.planId,
          instructionDeliveryGrade: instructionPlan.grade,
        },
        outputSections: [
          ...params.contextSections,
          createTextSection(
            `${providerLabel} instruction adaptation`,
            reason,
            80,
          ),
        ],
      },
      reason,
    );
  }

  let command: ReturnType<typeof createExternalAgentCommand>;
  let externalAssembledRequestDigest: string;
  try {
    const prompt = createExternalAgentPrompt(
      params.task,
      delegatedContextSections,
      params.preparedConversationContext,
      imagePaths,
    );
    assertExternalAgentInputSize(provider, prompt);
    command = createExternalAgentCommand(provider, {
      config: executionConfig,
      prompt,
      imageInputs: params.imageInputs,
      delegationMode,
      enrollmentArgs: enrollment.args,
      providerFeatures: enrollment.manifest.providerFeatures,
    });
    if (process.platform === "win32") {
      assertWindowsCommandLineLength(
        binary.executable,
        command.args,
        shouldUseShellForExecutable(binary.executable),
      );
    }
    externalAssembledRequestDigest = canonicalDigest({
      provider,
      executable: binary.executable,
      args: command.args,
      input: command.input,
      environmentKeys: Object.keys(enrollment.env).sort(),
      canonicalDigest: resolution.canonicalDigest,
    });
  } catch (error) {
    await enrollment.dispose();
    const reason = error instanceof Error ? error.message : String(error);
    return createExecutionResult(
      {
        task: params.task,
        mode: params.config.mode,
        status: "blocked",
        summary: `${providerLabel} execution stopped before launch because the complete request could not be prepared safely.`,
        executedTools: [],
        metadata: {
          instructionResolutionId: resolution.resolutionId,
          instructionCanonicalDigest: resolution.canonicalDigest,
          instructionDeliveryPlanId: instructionPlan.planId,
          instructionDeliveryGrade: "unsupported",
        },
        outputSections: [
          ...params.contextSections,
          createTextSection(`${providerLabel} request preflight`, reason, 80),
        ],
      },
      reason,
    );
  }

  try {
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
            instructionCanonicalDigest: resolution.canonicalDigest,
            instructionCount: resolution.selectedSources.length,
            instructionDeliveryPlanId: instructionPlan.planId,
            instructionDeliveryGrade: instructionPlan.grade,
            instructionDeliveryRoute: enrollment.instructionRoute,
            ...command.metadata,
          },
        },
      },
    );
  } catch (error) {
    await enrollment.dispose();
    throw error;
  }

  const startedAt = Date.now();
  const instructionReceipts = params.instructionDeliveryReceipts ?? [];
  const receiptEvidence = [
    ...enrollment.manifest.renderedFiles
      .filter(
        (file) =>
          file.role === "instruction-transport" ||
          file.role === "instruction-and-mcp-configuration",
      )
      .map((file) => ({
        kind: "temporary-file" as const,
        detail: file.purpose,
        digest: file.digest,
      })),
    {
      kind: "request-field" as const,
      detail:
        "The run-scoped enrollment manifest binds the complete rendered envelope to the canonical digest.",
      digest: resolution.canonicalDigest,
    },
    {
      kind: "environment" as const,
      detail: `Provider probe: ${
        enrollment.manifest.providerVersion ?? "version unavailable"
      }; features=${enrollment.manifest.providerFeatures.join(",") || "none"}.`,
      digest: enrollment.manifest.providerProbeDigest,
    },
  ];
  let result: SpawnedAgentResult;
  try {
    result = await runExternalAgentCommand(
      binary.executable,
      command.args,
      command.input,
      executionConfig,
      provider,
      enrollment.env,
      params.signal,
      params.onActionOutput,
    );
  } catch (error) {
    const failureReceipt = createInstructionDeliveryReceipt({
      plan: instructionPlan,
      phase: "initial",
      observedCanonicalDigest:
        enrollment.manifest.instructionDelivery.canonicalDigest,
      assembledRequestDigest: externalAssembledRequestDigest,
      deliveredBytes: enrollment.instructionDelivery.instructionPayloadBytes,
      indeterminateReason:
        "The delegated CLI process failed after launch, so Machdoch cannot prove whether it accepted or acted on the request. Automatic replay is prohibited.",
      evidence: receiptEvidence,
    });
    instructionReceipts.push(failureReceipt);
    assertInstructionDeliveryReceiptCertain(failureReceipt, error);
    throw error;
  } finally {
    await enrollment.dispose();
  }
  const deliveryReceipt = createInstructionDeliveryReceipt({
    plan: instructionPlan,
    phase: "initial",
    observedCanonicalDigest:
      enrollment.manifest.instructionDelivery.canonicalDigest,
    assembledRequestDigest: externalAssembledRequestDigest,
    deliveredBytes: enrollment.instructionDelivery.instructionPayloadBytes,
    ...((resolution.budget.estimatedTotalInstructionTokens ??
      resolution.budget.estimatedTokens) === undefined
      ? {}
      : {
          estimatedTokens:
            resolution.budget.estimatedTotalInstructionTokens ??
            resolution.budget.estimatedTokens,
        }),
    evidence: receiptEvidence,
  });
  instructionReceipts.push(deliveryReceipt);
  assertInstructionDeliveryReceiptCertain(deliveryReceipt);
  const providerShutdownMetadata: Record<string, string | number | boolean> =
    result.providerShutdownRecovery
      ? {
          providerShutdownRecovered: true,
          providerShutdownRecoveryKind: result.providerShutdownRecovery.kind,
          providerShutdownRecoveryGraceMs:
            result.providerShutdownRecovery.graceMs,
          providerChildExitObservedBeforeRecovery:
            result.providerShutdownRecovery.childExitObservedBeforeRecovery,
          providerChildExitCode:
            result.providerShutdownRecovery.childExitCode ?? "unknown",
          providerChildExitSignal:
            result.providerShutdownRecovery.childExitSignal ?? "none",
        }
      : {};
  const instructionMetadata = {
    instructionResolutionId: resolution.resolutionId,
    instructionCanonicalDigest: resolution.canonicalDigest,
    instructionEnvironmentDigest: resolution.environmentDigest,
    instructionDeliveryPlanId: instructionPlan.planId,
    instructionDeliveryGrade: instructionPlan.grade,
    instructionAdapterEvidence: {
      providerVersion: enrollment.manifest.providerVersion ?? null,
      providerFeatures: [...enrollment.manifest.providerFeatures],
      providerProbeDigest: enrollment.manifest.providerProbeDigest,
    },
    instructionSources: resolution.selectedSources.map((source) => ({
      id: source.id,
      name: source.name,
      kind: source.kind,
      scopePath: source.scopePath,
      precedence: source.precedence,
      digest: source.digest,
      byteLength: source.byteLength,
      lineCount: source.lineCount,
      trusted: source.trusted,
      ...(source.profileId === undefined
        ? {}
        : { profileId: source.profileId }),
      ...(source.workspaceId === undefined
        ? {}
        : { workspaceId: source.workspaceId }),
      ...(source.assignmentPath === undefined
        ? {}
        : { assignmentPath: source.assignmentPath }),
      ...(source.reason === undefined ? {} : { reason: source.reason }),
      ...(source.otherAssignments === undefined
        ? {}
        : {
            otherAssignments: source.otherAssignments.map((assignment) => ({
              ...assignment,
            })),
          }),
    })),
    instructionNativeInventory: resolution.nativeInventory.map((record) => ({
      ...record,
      ...(record.recognizingConventions === undefined
        ? {}
        : {
            recognizingConventions: [...record.recognizingConventions],
          }),
    })),
    instructionMcpInitializationInstructions:
      resolution.mcpInitializationInstructions.map(
        ({ serverIds, digest, byteLength }) => ({
          serverIds: [...serverIds],
          digest,
          byteLength,
        }),
      ),
    instructionDiagnostics: resolution.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      ...(diagnostic.details === undefined
        ? {}
        : { details: structuredClone(diagnostic.details) }),
    })),
    instructionDeliveryPlans: [
      {
        planId: instructionPlan.planId,
        resolutionId: instructionPlan.resolutionId,
        canonicalDigest: instructionPlan.canonicalDigest,
        environmentDigest: instructionPlan.environmentDigest,
        providerId: instructionPlan.providerId,
        surface: instructionPlan.surface,
        grade: instructionPlan.grade,
        route: instructionPlan.route,
        blockingReasons: [...instructionPlan.blockingReasons],
        dimensions: instructionPlan.dimensions.map((dimension) => ({
          ...dimension,
        })),
        capability: {
          ...instructionPlan.capability,
          lifecycle: { ...instructionPlan.capability.lifecycle },
          evidence: [...instructionPlan.capability.evidence],
        },
        createdAt: instructionPlan.createdAt,
      },
    ],
    instructionDeliveryReceipts: instructionReceipts.map((receipt) => ({
      receiptId: receipt.receiptId,
      planId: receipt.planId,
      resolutionId: receipt.resolutionId,
      canonicalDigest: receipt.canonicalDigest,
      providerId: receipt.providerId,
      surface: receipt.surface,
      phase: receipt.phase,
      route: receipt.route,
      deliveredAt: receipt.deliveredAt,
      status: receipt.status,
      observedCanonicalDigest: receipt.observedCanonicalDigest,
      assembledRequestDigest: receipt.assembledRequestDigest,
      deliveredBytes: receipt.deliveredBytes,
      ...(receipt.estimatedTokens === undefined
        ? {}
        : { estimatedTokens: receipt.estimatedTokens }),
      ...(receipt.requestId === undefined
        ? {}
        : { requestId: receipt.requestId }),
      ...(receipt.error === undefined ? {} : { error: receipt.error }),
      truncation: receipt.truncation,
      evidence: receipt.evidence.map((entry) => ({ ...entry })),
      bodyStored: false,
    })),
    ...providerShutdownMetadata,
  };
  const stdout = cleanCliText(result.stdout);
  const stderr = cleanCliText(result.stderr);
  const durationMs = Date.now() - startedAt;
  const providerShutdownDetail = result.providerShutdownRecovery
    ? result.providerShutdownRecovery.kind === "child-exit-close-timeout"
      ? `provider shutdown: child exited but inherited stdio did not close within ${result.providerShutdownRecovery.graceMs / 1_000} seconds; descendant-tree termination requested and inherited streams closed`
      : `provider shutdown: final answer received; process-tree termination requested after the child did not exit within ${result.providerShutdownRecovery.graceMs / 1_000} seconds`
    : undefined;
  const commandSection: TaskExecutionSection = {
    title: providerLabel,
    lines: [
      `binary: ${binary.executable}`,
      `binary source: ${binary.source ?? "unknown"}`,
      `model: ${params.config.model}`,
      `reasoning: ${params.config.reasoning}`,
      `instruction digest: ${resolution.canonicalDigest}`,
      `instruction delivery: ${instructionPlan.grade} via ${enrollment.instructionRoute}`,
      `provider probe: ${enrollment.manifest.providerVersion ?? "version unavailable"} (${enrollment.manifest.providerProbeDigest})`,
      `provider instruction features: ${enrollment.manifest.providerFeatures.join(", ") || "none"}`,
      `MCP servers enrolled: ${enrollment.mcpProjection.servers.length}`,
      ...enrollment.manifest.warnings.map(
        (warning) => `enrollment warning: ${limitText(warning, 500)}`,
      ),
      ...command.commandLines,
      `exit code: ${result.exitCode ?? "unknown"}`,
      ...(result.signal ? [`signal: ${result.signal}`] : []),
      ...(result.providerShutdownRecovery && providerShutdownDetail
        ? [
            providerShutdownDetail,
            `provider child exit before recovery: ${result.providerShutdownRecovery.childExitObservedBeforeRecovery ? `yes (code ${result.providerShutdownRecovery.childExitCode ?? "unknown"}, signal ${result.providerShutdownRecovery.childExitSignal ?? "none"})` : "no"}`,
          ]
        : []),
    ],
  };

  const finalAnswerRecoveredWithoutChildExit =
    result.providerShutdownRecovery !== undefined &&
    !result.providerShutdownRecovery.childExitObservedBeforeRecovery;
  if (result.exitCode !== 0 && !finalAnswerRecoveredWithoutChildExit) {
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
            ...providerShutdownMetadata,
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
        metadata: instructionMetadata,
        outputSections: [
          ...params.contextSections,
          commandSection,
          createTextSection(`${providerLabel} diagnostics`, reason, 80),
        ],
      },
      reason,
    );
  }

  const protocolResult = params.resultProtocol
    ? parseExternalAgentProtocolResult(stdout, params.resultProtocol)
    : undefined;
  if (params.resultProtocol && !protocolResult) {
    const reason = `${providerLabel} completed without a valid Machdoch control record.`;

    await emitAgentProgress(
      params.task,
      params.config,
      "blocked",
      reason,
      loopState,
      params.onStateChange,
      undefined,
      {
        timelineEvent: {
          kind: "model-call",
          phase: "failed",
          label: providerLabel,
          detail: reason,
          tone: "danger",
          provider,
          model: params.config.model,
          metadata: {
            durationMs,
            resultProtocol: params.resultProtocol.kind,
            ...providerShutdownMetadata,
          },
        },
      },
    );

    return createExecutionResult(
      {
        task: params.task,
        mode: params.config.mode,
        status: "blocked",
        summary: reason,
        executedTools: ["shell"],
        metadata: instructionMetadata,
        outputSections: [
          ...params.contextSections,
          commandSection,
          createTextSection(`${providerLabel} diagnostics`, reason, 80),
        ],
      },
      reason,
    );
  }

  const answer = params.resultProtocol
    ? protocolResult?.answer || `${providerLabel} completed.`
    : stdout ||
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
        detail: result.providerShutdownRecovery
          ? result.providerShutdownRecovery.kind === "child-exit-close-timeout"
            ? `${providerLabel} exited, but inherited stdio stayed open. Machdoch requested descendant-tree termination, closed the inherited streams, and preserved the result.`
            : `${providerLabel} produced its final answer but did not exit within ${result.providerShutdownRecovery.graceMs / 1_000} seconds. Machdoch requested process-tree termination, closed the inherited streams, and preserved the answer.`
          : command.successDetail,
        tone: result.providerShutdownRecovery ? "warning" : "success",
        provider,
        model: params.config.model,
        metadata: {
          durationMs,
          ...providerShutdownMetadata,
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
    metadata: instructionMetadata,
    outputSections: [
      ...params.contextSections,
      commandSection,
      createTextSection(`${providerLabel} answer`, answer, 120),
      ...(stderr
        ? [
            createTextSection(
              `${providerLabel} diagnostics`,
              limitText(stderr, MAX_DIAGNOSTIC_CHARS),
              80,
            ),
          ]
        : []),
    ],
    response: {
      markdown: answer,
      highlights: [],
      relatedFiles: [],
      verification: [],
      followUps: [],
    },
    ...(protocolResult ? { control: protocolResult.control } : {}),
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
