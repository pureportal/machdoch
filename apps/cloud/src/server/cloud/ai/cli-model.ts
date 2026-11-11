import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { CloudCliProvider } from "@machdoch/fleet-protocol/cloud-providers";
import type {
  AgentModelAdapter,
  AgentModelStartParams,
  AgentModelStreamUsage,
  AgentModelToolCall,
  AgentModelToolSpec,
  AgentModelTurn,
} from "@machdoch/model-runtime/types";

const maximumStreamBytes = 16 * 1024 * 1024;
const toolCallFence = "```tool_calls";

function toolInstructions(tools: AgentModelToolSpec[]): string {
  if (!tools.length) return "";
  const catalog = tools
    .map(
      (tool) =>
        `### ${tool.name}\n${tool.description}\nInput JSON schema: ${JSON.stringify(tool.inputSchema)}`,
    )
    .join("\n\n");
  return [
    "",
    "## Tools",
    `You can call the workspace tools below. To call tools, reply with nothing except one fenced block that starts with ${toolCallFence} and contains a JSON array of calls, for example:`,
    toolCallFence,
    '[{"name":"search_issues","arguments":{"query":"login"}}]',
    "```",
    "Use only this block format. Do not use XML tags, function-call syntax or any other tool format.",
    'Tool results arrive as entries with role "tool" in the next message. When you can answer, reply normally without a tool_calls block.',
    "",
    catalog,
  ].join("\n");
}

function cliToolCall(name: string, args: unknown): AgentModelToolCall {
  return { id: `cli_${randomUUID()}`, name, arguments: record(args) };
}

function jsonObjectEnd(text: string, start: number): number {
  let depth = 0;
  let quoted = false;
  for (let index = start; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === "\\") index++;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "{") depth++;
    else if (character === "}" && --depth === 0) return index + 1;
  }
  return -1;
}

function fencedToolCalls(text: string) {
  const start = text.indexOf(toolCallFence);
  if (start === -1) return null;
  const body = text.slice(start + toolCallFence.length);
  const end = body.indexOf("```");
  let parsed: unknown;
  try {
    parsed = JSON.parse((end === -1 ? body : body.slice(0, end)).trim());
  } catch {
    return null;
  }
  const toolCalls = (Array.isArray(parsed) ? parsed : [parsed]).flatMap(
    (entry) => {
      const call = record(entry);
      return typeof call.name === "string"
        ? [cliToolCall(call.name, call.arguments)]
        : [];
    },
  );
  return toolCalls.length
    ? { text: text.slice(0, start).trim(), toolCalls }
    : null;
}

function expressionToolCalls(text: string, toolNames: string[]) {
  const toolCalls: AgentModelToolCall[] = [];
  const spans: [number, number][] = [];
  const pattern = new RegExp(`\\b(${toolNames.join("|")})\\(\\s*\\{`, "g");
  for (const match of text.matchAll(pattern)) {
    const objectStart = match.index + match[0].length - 1;
    const objectEnd = jsonObjectEnd(text, objectStart);
    if (objectEnd === -1) continue;
    const close = /^\s*\)/.exec(text.slice(objectEnd));
    if (!close) continue;
    try {
      toolCalls.push(
        cliToolCall(match[1]!, JSON.parse(text.slice(objectStart, objectEnd))),
      );
      spans.push([match.index, objectEnd + close[0].length]);
    } catch {
      continue;
    }
  }
  if (!toolCalls.length) return null;
  let remaining = text;
  for (const [from, to] of spans.reverse())
    remaining = remaining.slice(0, from) + remaining.slice(to);
  return {
    text: remaining
      .split("\n")
      .filter((line) => !/^\s*<\/?[\w:-]+[^>]*>\s*$/.test(line))
      .join("\n")
      .trim(),
    toolCalls,
  };
}

export function parseCliToolCalls(
  text: string,
  toolNames: string[],
): { text: string; toolCalls: AgentModelToolCall[] } {
  return (
    fencedToolCalls(text) ??
    expressionToolCalls(text, toolNames) ?? { text, toolCalls: [] }
  );
}

function visibleLength(text: string): number {
  const fence = text.indexOf(toolCallFence);
  if (fence !== -1) return fence;
  for (
    let size = Math.min(toolCallFence.length - 1, text.length);
    size > 0;
    size--
  )
    if (toolCallFence.startsWith(text.slice(-size))) return text.length - size;
  return text.length;
}
const inheritedEnvironment = [
  "PATH",
  "Path",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "TEMP",
  "TMP",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
];

export interface CliModelConnection {
  provider: CloudCliProvider;
  model: string;
  apiKey: string;
}

export interface CliCommand {
  file: string;
  prefixArgs: string[];
}

export class CliModelFailure extends Error {
  constructor(
    readonly code: "cli_unavailable" | "cli_authentication" | "cli_failed",
    message: string,
  ) {
    super(message);
  }
}

export function defaultCliCommand(provider: CloudCliProvider): CliCommand {
  return {
    file:
      provider === "claude-code-cli"
        ? (process.env.MACHDOCH_CLOUD_CLAUDE_CLI ?? "claude")
        : (process.env.MACHDOCH_CLOUD_CODEX_CLI ?? "codex"),
    prefixArgs: [],
  };
}

function cliEnvironment(connection: CliModelConnection): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV };
  for (const name of inheritedEnvironment)
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  if (connection.apiKey) {
    if (connection.provider === "claude-code-cli")
      environment.ANTHROPIC_API_KEY = connection.apiKey;
    else environment.CODEX_API_KEY = connection.apiKey;
  }
  return environment;
}

function stopProcessTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === "win32")
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

function authenticationFailure(message: string): boolean {
  return /api key|authentication|unauthorized|not logged in|log ?in|invalid.*token|401/i.test(
    message,
  );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function tokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

interface StreamState {
  text: string;
  failure: string | null;
  usage: AgentModelStreamUsage | undefined;
  stopReason: string | undefined;
}

type LineHandler = (
  event: Record<string, unknown>,
  state: StreamState,
  emit: (delta: string) => void,
) => void;

const claudeLines: LineHandler = (event, state, emit) => {
  if (event.type === "stream_event") {
    const inner = record(event.event);
    const delta = record(inner.delta);
    if (inner.type === "content_block_delta" && delta.type === "text_delta")
      emit(String(delta.text ?? ""));
    return;
  }
  if (event.type !== "result") return;
  if (event.is_error) {
    state.failure = String(
      event.result ?? event.subtype ?? "Claude Code failed",
    );
    return;
  }
  state.text = String(event.result ?? state.text);
  state.stopReason = String(event.stop_reason ?? "end_turn");
  const usage = record(event.usage);
  const input = tokens(usage.input_tokens);
  const output = tokens(usage.output_tokens);
  const cacheRead = tokens(usage.cache_read_input_tokens);
  const cacheWrite = tokens(usage.cache_creation_input_tokens);
  state.usage = {
    inputTokens: input,
    outputTokens: output,
    cacheReadInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
  };
};

const codexLines: LineHandler = (event, state, emit) => {
  if (event.type === "item.completed") {
    const item = record(event.item);
    if (item.type === "agent_message") {
      const text = String(item.text ?? "");
      emit(state.text ? `\n\n${text}` : text);
    }
    return;
  }
  if (event.type === "turn.completed") {
    const usage = record(event.usage);
    const input = tokens(usage.input_tokens);
    const output = tokens(usage.output_tokens);
    state.stopReason = "end_turn";
    state.usage = {
      inputTokens: input,
      outputTokens: output,
      cachedInputTokens: tokens(usage.cached_input_tokens),
      totalTokens: input + output,
    };
    return;
  }
  if (event.type === "turn.failed")
    state.failure = String(record(event.error).message ?? "Codex failed");
  else if (event.type === "error")
    state.failure = String(event.message ?? "Codex failed");
};

async function cliInvocation(
  connection: CliModelConnection,
  parameters: AgentModelStartParams,
  directory: string,
): Promise<{ args: string[]; input: string }> {
  if (connection.provider === "claude-code-cli") {
    const systemPath = join(directory, "system-prompt.txt");
    await writeFile(
      systemPath,
      parameters.systemPrompt + toolInstructions(parameters.tools),
      { mode: 0o600 },
    );
    return {
      args: [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--no-session-persistence",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--tools",
        "",
        "--setting-sources",
        "",
        "--system-prompt-file",
        systemPath,
        "--model",
        connection.model,
      ],
      input: parameters.userPrompt,
    };
  }
  const instructionsPath = join(directory, "instructions.md");
  await writeFile(
    instructionsPath,
    parameters.systemPrompt + toolInstructions(parameters.tools),
    { mode: 0o600 },
  );
  return {
    args: [
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--cd",
      directory,
      "--model",
      connection.model,
      "--config",
      `model_instructions_file=${JSON.stringify(instructionsPath)}`,
      "--config",
      "mcp_servers={}",
      "--config",
      'web_search="disabled"',
      "--config",
      "features.shell_tool=false",
      "--config",
      "features.apply_patch_freeform=false",
      "-",
    ],
    input: parameters.userPrompt,
  };
}

export function createCliModelAdapter(
  connection: CliModelConnection,
  command: CliCommand = defaultCliCommand(connection.provider),
): AgentModelAdapter {
  return {
    async startTurn(parameters): Promise<AgentModelTurn> {
      parameters.signal?.throwIfAborted();
      const directory = await mkdtemp(join(tmpdir(), "machdoch-cloud-cli-"));
      try {
        const { args, input } = await cliInvocation(
          connection,
          parameters,
          directory,
        );
        return await runCli(
          connection,
          command,
          args,
          input,
          directory,
          parameters,
        );
      } finally {
        await rm(directory, { recursive: true, force: true, maxRetries: 3 });
      }
    },
    async continueTurn(): Promise<never> {
      throw new Error(
        "Each cloud inference call requires its complete request context.",
      );
    },
  };
}

function runCli(
  connection: CliModelConnection,
  command: CliCommand,
  args: string[],
  input: string,
  directory: string,
  parameters: AgentModelStartParams,
): Promise<AgentModelTurn> {
  const onLine =
    connection.provider === "claude-code-cli" ? claudeLines : codexLines;
  return new Promise<AgentModelTurn>((resolve, reject) => {
    const child = spawn(command.file, [...command.prefixArgs, ...args], {
      cwd: directory,
      env: cliEnvironment(connection),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const state: StreamState = {
      text: "",
      failure: null,
      usage: undefined,
      stopReason: undefined,
    };
    const decoder = new StringDecoder("utf8");
    let buffered = "";
    let streamed = 0;
    let emitted = 0;
    let stderr = "";
    let settled = false;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      parameters.signal?.removeEventListener("abort", abort);
      outcome();
    };
    const abort = () => {
      stopProcessTree(child.pid);
      finish(() =>
        reject(
          parameters.signal?.reason instanceof Error
            ? parameters.signal.reason
            : new Error("The CLI request was canceled."),
        ),
      );
    };
    parameters.signal?.addEventListener("abort", abort, { once: true });
    const consume = (line: string) => {
      if (!line.trim()) return;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      onLine(record(event), state, (delta) => {
        if (!delta) return;
        state.text += delta;
        const visible = visibleLength(state.text);
        if (visible <= emitted) return;
        parameters.onStreamEvent?.({
          type: "text-delta",
          delta: state.text.slice(emitted, visible),
        });
        emitted = visible;
      });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      streamed += chunk.length;
      if (streamed > maximumStreamBytes) {
        stopProcessTree(child.pid);
        finish(() =>
          reject(
            new CliModelFailure("cli_failed", "CLI output limit exceeded."),
          ),
        );
        return;
      }
      buffered += decoder.write(chunk);
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) consume(line);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4000);
    });
    child.stdin.on("error", () => undefined);
    child.once("error", (error: NodeJS.ErrnoException) =>
      finish(() =>
        reject(
          new CliModelFailure(
            ["ENOENT", "EINVAL", "EACCES"].includes(error.code ?? "")
              ? "cli_unavailable"
              : "cli_failed",
            error.message,
          ),
        ),
      ),
    );
    child.once("close", (exitCode) =>
      finish(() => {
        consume(buffered + decoder.end());
        const failure =
          state.failure ??
          (exitCode === 0
            ? null
            : stderr.trim() || `CLI exited with ${exitCode}`);
        if (failure) {
          reject(
            new CliModelFailure(
              authenticationFailure(failure)
                ? "cli_authentication"
                : "cli_failed",
              failure,
            ),
          );
          return;
        }
        resolve({
          ...(parameters.tools.length
            ? parseCliToolCalls(
                state.text,
                parameters.tools.map((tool) => tool.name),
              )
            : { text: state.text, toolCalls: [] }),
          stopReason: state.stopReason,
          usage: state.usage,
        });
      }),
    );
    child.stdin.end(input);
  });
}
