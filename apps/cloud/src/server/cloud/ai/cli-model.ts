import { spawn } from "node:child_process";
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
  AgentModelStructuredOutput,
  AgentModelToolCall,
  AgentModelToolSpec,
  AgentModelTurn,
} from "@machdoch/model-runtime/types";
import {
  cliEnvironment,
  codexFileCredentials,
  defaultCliCommand,
  prepareCliHome,
  stopProcessTree,
  type CliCommand,
} from "./cli-process";

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

function responseFormatInstructions(
  structuredOutput: AgentModelStructuredOutput | undefined,
): string {
  if (!structuredOutput) return "";
  return [
    "",
    "## Response format",
    "Your final answer must be only one JSON value that conforms to the JSON schema below, without Markdown fences or any other text.",
    JSON.stringify(structuredOutput.schema),
  ].join("\n");
}

function instructions(parameters: AgentModelStartParams): string {
  return (
    parameters.systemPrompt +
    toolInstructions(parameters.tools) +
    responseFormatInstructions(parameters.structuredOutput)
  );
}

function structuredAnswer(text: string): string {
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(text.trim());
  return (fenced?.[1] ?? text).trim();
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

function bareToolCalls(text: string, toolNames: string[]) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(structuredAnswer(text));
  } catch {
    return null;
  }
  const entries = (Array.isArray(parsed) ? parsed : [parsed]).map(record);
  const known = entries.every(
    (entry) => typeof entry.name === "string" && toolNames.includes(entry.name),
  );
  if (!entries.length || !known) return null;
  return {
    text: "",
    toolCalls: entries.map((entry) =>
      cliToolCall(String(entry.name), entry.arguments),
    ),
  };
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
    bareToolCalls(text, toolNames) ??
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
export interface CliModelConnection {
  provider: CloudCliProvider;
  model: string;
  apiKey: string;
  home: string;
}

export class CliModelFailure extends Error {
  constructor(
    readonly code: "cli_unavailable" | "cli_authentication" | "cli_failed",
    message: string,
  ) {
    super(message);
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
  chunks: Map<string, string[]>;
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

function copilotMessage(
  data: Record<string, unknown>,
  state: StreamState,
): string | null {
  if (typeof data.content !== "string") return null;
  const count = Number(data.chunkCount);
  const index = Number(data.chunkIndex);
  if (
    typeof data.messageId !== "string" ||
    !Number.isInteger(count) ||
    count < 2 ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= count
  )
    return data.content;
  const parts = state.chunks.get(data.messageId) ?? Array<string>(count);
  parts[index] = data.content;
  state.chunks.set(data.messageId, parts);
  if (parts.filter((part) => part !== undefined).length < count) return null;
  state.chunks.delete(data.messageId);
  return parts.join("");
}

const copilotLines: LineHandler = (event, state, emit) => {
  const data = record(event.data);
  if (event.type === "assistant.message" && event.agentId === undefined) {
    const content = copilotMessage(data, state);
    const toolRequests = Array.isArray(data.toolRequests)
      ? data.toolRequests.length
      : 0;
    if (content?.trim() && !toolRequests)
      emit(state.text ? `\n\n${content}` : content);
    return;
  }
  if (event.type === "session.usage_checkpoint") {
    const snapshot = record(data.accountingSnapshot);
    const input = tokens(snapshot.lastCallInputTokens);
    const output = tokens(snapshot.lastCallOutputTokens);
    if (input || output)
      state.usage = {
        inputTokens: input,
        outputTokens: output,
        totalTokens: input + output,
      };
    return;
  }
  if (event.type === "result") {
    if (event.exitCode === 0) state.stopReason = "end_turn";
    else state.failure ??= `Copilot exited with ${String(event.exitCode)}`;
    return;
  }
  if (event.type === "error" || String(event.type).endsWith(".error"))
    state.failure = String(
      typeof event.data === "string"
        ? event.data
        : (data.message ?? data.error ?? "Copilot failed"),
    );
};

const lineHandlers: Record<CloudCliProvider, LineHandler> = {
  "claude-code-cli": claudeLines,
  "codex-cli": codexLines,
  "copilot-cli": copilotLines,
};

async function cliInvocation(
  connection: CliModelConnection,
  parameters: AgentModelStartParams,
  directory: string,
): Promise<{ args: string[]; input: string }> {
  if (connection.provider === "claude-code-cli") {
    const systemPath = join(directory, "system-prompt.txt");
    await writeFile(systemPath, instructions(parameters), { mode: 0o600 });
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
  if (connection.provider === "copilot-cli")
    return {
      args: [
        "-s",
        "--stream=off",
        "--output-format=json",
        "--no-ask-user",
        "--no-auto-update",
        "--no-custom-instructions",
        "--disable-builtin-mcps",
        "--disable-client-telemetry",
        "--available-tools=",
        `--model=${connection.model}`,
      ],
      input: [
        "Follow these system instructions:",
        instructions(parameters),
        "User request:",
        parameters.userPrompt,
      ].join("\n\n"),
    };
  const instructionsPath = join(directory, "instructions.md");
  await writeFile(instructionsPath, instructions(parameters), { mode: 0o600 });
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
      ...codexFileCredentials,
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
      await prepareCliHome(connection.home);
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
  const onLine = lineHandlers[connection.provider];
  return new Promise<AgentModelTurn>((resolve, reject) => {
    const child = spawn(command.file, [...command.prefixArgs, ...args], {
      cwd: directory,
      env: cliEnvironment(
        connection.provider,
        connection.home,
        connection.apiKey,
      ),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const state: StreamState = {
      text: "",
      failure: null,
      usage: undefined,
      stopReason: undefined,
      chunks: new Map(),
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
        const turn = parameters.tools.length
          ? parseCliToolCalls(
              state.text,
              parameters.tools.map((tool) => tool.name),
            )
          : { text: state.text, toolCalls: [] };
        resolve({
          text:
            parameters.structuredOutput && !turn.toolCalls.length
              ? structuredAnswer(turn.text)
              : turn.text,
          toolCalls: turn.toolCalls,
          stopReason: state.stopReason,
          usage: state.usage,
        });
      }),
    );
    child.stdin.end(input);
  });
}
