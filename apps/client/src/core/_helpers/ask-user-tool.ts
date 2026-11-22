import type {
  AgentControlEndpoint,
  AgentLiveQuestion,
  AgentLiveState,
} from "@machdoch/fleet-protocol/task-thinking";
import type { RuntimeProvider } from "@machdoch/fleet-protocol/runtime-options";
import { AgentLiveTracker } from "./agent-live-tracker.js";
import {
  QuestionTimeout,
  settleLiveQuestion,
  staleQuestionError,
} from "./agent-interactive-session.js";
import {
  AgentControlRequestError,
  startAgentTaskControlServer,
  type AgentTaskControlServer,
} from "./agent-task-control-server.js";
import {
  createToolErrorResult,
  type AgentToolDefinition,
  type AgentToolExecutionResult,
} from "./agent-tools-shared.js";

export const ASK_USER_TOOL_NAME = "ask_user";

type QuestionOutcome =
  | { kind: "answered"; answers: Record<string, string> }
  | { kind: "expired"; note: string }
  | { kind: "cancelled" };

interface PendingQuestion {
  id: string;
  items: AgentLiveQuestion["items"];
  settle(outcome: QuestionOutcome): void;
}

export interface AskUserToolSession {
  readonly definition: AgentToolDefinition;
  close(): Promise<void>;
}

const readQuestionItems = (
  args: Record<string, unknown>,
): AgentLiveQuestion["items"] => {
  const questions = Array.isArray(args.questions) ? args.questions : [];
  return questions.flatMap((raw, index) => {
    if (typeof raw !== "object" || raw === null) return [];
    const entry = raw as Record<string, unknown>;
    const question =
      typeof entry.question === "string" ? entry.question.trim() : "";
    if (!question) return [];
    const header = typeof entry.header === "string" ? entry.header.trim() : "";
    const options = (Array.isArray(entry.options) ? entry.options : [])
      .filter(
        (option): option is string =>
          typeof option === "string" && option.trim().length > 0,
      )
      .map((label) => ({ label: label.trim() }));
    return [
      {
        id: `q${index + 1}`,
        question,
        ...(header ? { header } : {}),
        options,
        ...(entry.multiSelect === true ? { multiSelect: true } : {}),
        allowOther: true,
      },
    ];
  });
};

const createDescription = (timeoutMs: number | undefined): string => {
  const minutes =
    timeoutMs === undefined ? undefined : Math.round(timeoutMs / 60_000);
  return [
    "Ask the user one or more questions and wait for the answers. Use it only for a decision that is genuinely the user's and that the task, the workspace, and sensible defaults cannot settle. Keep questions short and offer options when there are clear choices; the user can always type their own answer.",
    minutes === undefined
      ? "The run waits until the user answers."
      : `If the user does not answer within ${minutes} minute${minutes === 1 ? "" : "s"}, the result says so; then choose the most reasonable option, note the assumption, and continue.`,
  ].join(" ");
};

const createOutcomeResult = (
  items: AgentLiveQuestion["items"],
  outcome: QuestionOutcome,
): AgentToolExecutionResult => {
  if (outcome.kind === "cancelled") {
    return createToolErrorResult(
      "",
      ASK_USER_TOOL_NAME,
      "The run stopped before the user answered.",
    );
  }
  const output =
    outcome.kind === "answered"
      ? {
          status: "answered",
          answers: items.map((item) => ({
            question: item.question,
            answer: outcome.answers[item.id] ?? "",
          })),
        }
      : { status: "unanswered", note: outcome.note };
  return {
    toolResult: {
      callId: "",
      name: ASK_USER_TOOL_NAME,
      output: JSON.stringify(output),
    },
    sections: [],
    traceLines: [`${ASK_USER_TOOL_NAME} -> ${output.status}`],
  };
};

interface AskUserChannel {
  live: AgentLiveTracker;
  server: AgentTaskControlServer;
}

/**
 * Lets Machdoch's own agent ask the user during a run. The question appears as
 * the live question card the CLI agents use and is answered through a local
 * control endpoint, or expires after the question timeout.
 */
export const createAskUserToolSession = (options: {
  provider: RuntimeProvider;
  model: string;
  questionTimeoutMs: number | undefined;
  publish(extras: {
    agentLive?: AgentLiveState;
    agentControl?: AgentControlEndpoint | null;
  }): void;
}): AskUserToolSession => {
  const questionTimeout = new QuestionTimeout(options.questionTimeoutMs);
  let channel: Promise<AskUserChannel> | undefined;
  let live: AgentLiveTracker | undefined;
  let pending: PendingQuestion | undefined;
  let asking = false;
  let nextQuestion = 1;
  let closed = false;

  const settlePending = (outcome: QuestionOutcome): void => {
    const question = pending;
    if (!question) return;
    pending = undefined;
    questionTimeout.clear();
    if (live) {
      settleLiveQuestion(
        live,
        outcome.kind,
        outcome.kind === "answered" ? outcome.answers : undefined,
      );
    }
    question.settle(outcome);
  };

  const openChannel = async (): Promise<AskUserChannel> => {
    const server = await startAgentTaskControlServer({
      answer: (questionId, answers) => {
        if (!pending || pending.id !== questionId) throw staleQuestionError();
        if (pending.items.some((item) => !answers[item.id]?.trim())) {
          throw new AgentControlRequestError("Answer every question first.", 400);
        }
        settlePending({ kind: "answered", answers });
      },
    });
    live = new AgentLiveTracker(
      {
        provider: options.provider,
        transport: "api",
        capabilities: server.endpoint.capabilities,
        model: options.model,
      },
      (agentLive) => options.publish({ agentLive }),
    );
    options.publish({ agentControl: server.endpoint });
    return { live, server };
  };

  const ask = async (
    items: AgentLiveQuestion["items"],
    signal: AbortSignal | undefined,
  ): Promise<QuestionOutcome> => {
    channel ??= openChannel();
    const { live: tracker } = await channel;
    if (closed || signal?.aborted) return { kind: "cancelled" };
    const questionId = `native-${nextQuestion++}`;
    return new Promise<QuestionOutcome>((resolve) => {
      const onAbort = (): void => settlePending({ kind: "cancelled" });
      pending = {
        id: questionId,
        items,
        settle: (outcome) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(outcome);
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const expiresAt = questionTimeout.start((note) =>
        settlePending({ kind: "expired", note }),
      );
      tracker.setQuestion({
        id: questionId,
        items,
        status: "pending",
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      });
    });
  };

  const definition: AgentToolDefinition = {
    spec: {
      name: ASK_USER_TOOL_NAME,
      strict: false,
      description: createDescription(options.questionTimeoutMs),
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          questions: {
            type: "array",
            minItems: 1,
            maxItems: 4,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                question: { type: "string", minLength: 1, maxLength: 2_000 },
                header: {
                  type: "string",
                  maxLength: 60,
                  description: "A short label for the question.",
                },
                options: {
                  type: "array",
                  maxItems: 8,
                  items: { type: "string", minLength: 1, maxLength: 200 },
                },
                multiSelect: { type: "boolean" },
              },
              required: ["question"],
            },
          },
        },
        required: ["questions"],
      },
    },
    backingTool: "utilities",
    riskLevel: "low",
    effect: "read",
    execute: async (args, context) => {
      if (asking) {
        return createToolErrorResult(
          "",
          ASK_USER_TOOL_NAME,
          "Another question is still waiting for an answer. Ask one question at a time.",
        );
      }
      const items = readQuestionItems(args);
      if (items.length === 0) {
        return createToolErrorResult(
          "",
          ASK_USER_TOOL_NAME,
          "Provide at least one question.",
        );
      }
      asking = true;
      try {
        return createOutcomeResult(items, await ask(items, context.signal));
      } finally {
        asking = false;
      }
    },
  };

  return {
    definition,
    close: async () => {
      closed = true;
      settlePending({ kind: "cancelled" });
      const opened = await channel?.catch(() => undefined);
      if (!opened) return;
      const { live: tracker, server } = opened;
      tracker.close();
      options.publish({ agentControl: null });
      await server.close();
    },
  };
};
