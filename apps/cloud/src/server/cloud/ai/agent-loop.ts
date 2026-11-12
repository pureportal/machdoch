import type {
  AgentModelAdapter,
  AgentModelImageInput,
  AgentModelStartParams,
  AgentModelStreamUsage,
  AgentModelToolSpec,
} from "@machdoch/model-runtime/types";
import type {
  AgentAction,
  AgentQuestion,
  AgentStep,
} from "../../../lib/cloud-chat-contract";
import { agentToolSpecs, type CloudAgentSession } from "./agent-tools";

export const maximumAgentRounds = 8;
const maximumToolCallsPerRound = 8;
const maximumExchangeCharacters = 64_000;

export interface AgentProgress {
  steps: AgentStep[];
  actions: AgentAction[];
  question: AgentQuestion | null;
}

export interface AgentRunResult {
  text: string;
  stopReason: string | undefined;
  tokens: number | null;
  progress: AgentProgress;
}

export function usageTokens(
  usage: AgentModelStreamUsage | undefined,
): number | null {
  if (!usage) return null;
  const total = usage.totalTokens ?? null;
  return total !== null &&
    Number.isSafeInteger(total) &&
    total >= 0 &&
    total <= 1_000_000_000
    ? total
    : null;
}

type Exchange =
  | {
      role: "assistant";
      content?: string;
      toolCalls: { id: string; name: string; arguments: unknown }[];
    }
  | {
      role: "tool";
      toolCallId: string;
      name: string;
      content: string;
      isError?: true;
    }
  | { role: "note"; content: string };

export async function runAgent(options: {
  createAdapter: (tools: AgentModelToolSpec[]) => Promise<AgentModelAdapter>;
  request: Omit<
    AgentModelStartParams,
    "userPrompt" | "tools" | "signal" | "onStreamEvent"
  >;
  conversation: string;
  images: AgentModelImageInput[];
  session: CloudAgentSession;
  signal: AbortSignal;
  onStreamEvent: NonNullable<AgentModelStartParams["onStreamEvent"]>;
  onRoundStart: () => void;
  onProgress: (progress: AgentProgress) => Promise<void>;
}): Promise<AgentRunResult> {
  const conversation = [
    ...(JSON.parse(options.conversation) as unknown[]),
    ...(options.images.length
      ? [
          {
            role: "note",
            content: `Images included with this request, in order: ${options.images.map((image, index) => `${index + 1}. ${image.path}`).join("; ")}`,
          },
        ]
      : []),
  ];
  const exchanges: Exchange[] = [];
  const progress: AgentProgress = { steps: [], actions: [], question: null };
  let tokens: number | null = 0;
  let exchangeCharacters = 0;
  for (let round = 1; ; round++) {
    const finalRound =
      round === maximumAgentRounds ||
      exchangeCharacters > maximumExchangeCharacters;
    const tools = finalRound ? [] : agentToolSpecs;
    options.signal.throwIfAborted();
    options.onRoundStart();
    const adapter = await options.createAdapter(tools);
    const turn = await adapter.startTurn({
      ...options.request,
      userPrompt: JSON.stringify([
        ...conversation,
        ...exchanges,
        ...(finalRound && exchanges.length
          ? [
              {
                role: "note",
                content:
                  "The tool limit for this answer is reached. Answer now with the information gathered.",
              },
            ]
          : []),
      ]),
      tools,
      imageInputs: [...options.images, ...options.session.viewedImages],
      signal: options.signal,
      onStreamEvent: options.onStreamEvent,
    });
    const roundTokens = usageTokens(turn.usage);
    tokens =
      tokens === null || roundTokens === null ? null : tokens + roundTokens;
    if (finalRound || !turn.toolCalls.length)
      return { text: turn.text, stopReason: turn.stopReason, tokens, progress };
    const calls = turn.toolCalls.slice(0, maximumToolCallsPerRound);
    exchanges.push({
      role: "assistant",
      ...(turn.text.trim() ? { content: turn.text } : {}),
      toolCalls: calls.map((call) => ({
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      })),
    });
    let terminal = false;
    for (const call of calls) {
      options.signal.throwIfAborted();
      const result = await options.session.execute(call);
      progress.steps.push(result.step);
      if (result.action) progress.actions.push(result.action);
      if (result.question) progress.question = result.question;
      terminal ||= result.terminal;
      exchangeCharacters += result.output.length;
      exchanges.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: result.output,
        ...(result.isError ? { isError: true as const } : {}),
      });
    }
    await options.onProgress(progress);
    if (terminal)
      return { text: turn.text, stopReason: turn.stopReason, tokens, progress };
  }
}
