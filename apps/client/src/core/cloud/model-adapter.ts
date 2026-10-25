import { createHash, randomUUID } from "node:crypto";
import type {
  AgentModelAdapter,
  AgentModelStartParams,
  AgentModelContinueParams,
  AgentModelToolResult,
  AgentModelTurn,
} from "@machdoch/model-runtime/types";
import type { InferenceResponse } from "@machdoch/fleet-protocol/cloud-inference";
import {
  cloudAgentInferenceSchema,
  CloudAgentContextLimit,
  type CloudAgentInference,
} from "@machdoch/fleet-protocol/cloud-agent";

interface Exchange {
  turn: AgentModelTurn;
  results: AgentModelToolResult[];
}

function excerpt(value: string, limit: number | undefined): string {
  if (limit === undefined || value.length <= limit) return value;
  const half = Math.floor(limit / 2);
  return value.slice(0, half) + "\n[truncated]\n" + value.slice(-half);
}

function historyMessages(
  exchange: Exchange,
  limit: number | undefined,
): unknown[] {
  const content = excerpt(exchange.turn.text, limit);
  return [
    {
      role: "assistant",
      content,
      ...(content !== exchange.turn.text ? { truncatedContent: true } : {}),
      toolCalls: exchange.turn.toolCalls.map((call) => {
        const argumentsText = JSON.stringify(call.arguments);
        if (limit === undefined || argumentsText.length <= limit) return call;
        return {
          id: call.id,
          name: call.name,
          argumentsPreview: excerpt(argumentsText, limit),
          argumentsBytes: Buffer.byteLength(argumentsText),
          argumentsSha256: createHash("sha256")
            .update(argumentsText)
            .digest("hex"),
          truncatedArguments: true,
        };
      }),
    },
    ...exchange.results.map((result) => {
      const output = excerpt(result.output, limit);
      const content = result.content?.map((part) =>
        part.type === "text"
          ? { ...part, text: excerpt(part.text, limit) }
          : part,
      );
      const truncated =
        output !== result.output ||
        content?.some((part, index) => {
          const original = result.content?.[index];
          return (
            part.type === "text" &&
            original?.type === "text" &&
            part.text !== original.text
          );
        });
      return {
        role: "tool",
        ...result,
        output,
        ...(content ? { content } : {}),
        ...(truncated ? { truncated: true } : {}),
      };
    }),
  ];
}
export type CloudModelTransport = (
  request: CloudAgentInference,
  signal?: AbortSignal,
) => Promise<InferenceResponse>;

export class CloudAgentModelAdapter implements AgentModelAdapter {
  private start: AgentModelStartParams | undefined;
  private pending: AgentModelTurn | undefined;
  private exchanges: Exchange[] = [];
  private requesting = false;

  constructor(
    private readonly model: string,
    private readonly contextLimitBytes: number,
    private readonly transport: CloudModelTransport,
  ) {}

  async startTurn(parameters: AgentModelStartParams): Promise<AgentModelTurn> {
    if (this.requesting)
      throw new Error("A model request is already in progress.");
    if (parameters.model !== this.model)
      throw new Error("The requested model differs from the cloud task grant.");
    if (parameters.imageInputs?.length)
      throw new Error(
        "Image input is not available through the cloud task broker.",
      );
    if (
      parameters.parallelAgentMode &&
      parameters.parallelAgentMode !== "disabled"
    )
      throw new Error(
        "Provider-managed agents are not granted to this cloud task.",
      );
    this.start = parameters;
    this.exchanges = [];
    this.pending = undefined;
    return this.request(parameters);
  }

  async continueTurn(
    parameters: AgentModelContinueParams,
  ): Promise<AgentModelTurn> {
    if (this.requesting)
      throw new Error("A model request is already in progress.");
    if (!this.start || !this.pending)
      throw new Error("The model conversation has not started.");
    const expected = new Map(
      this.pending.toolCalls.map((call) => [call.id, call.name]),
    );
    if (
      expected.size !== this.pending.toolCalls.length ||
      parameters.toolResults.length !== expected.size
    )
      throw new Error("Tool results do not match the pending model turn.");
    for (const result of parameters.toolResults) {
      if (expected.get(result.callId) !== result.name)
        throw new Error("Tool results do not match the pending model turn.");
      expected.delete(result.callId);
      if (result.content?.some((content) => content.type === "image"))
        throw new Error(
          "Image results are not available through the cloud task broker.",
        );
    }
    this.exchanges.push({
      turn: this.pending,
      results: parameters.toolResults,
    });
    this.pending = undefined;
    return this.request(parameters);
  }

  private async request(
    parameters: AgentModelContinueParams | AgentModelStartParams,
  ): Promise<AgentModelTurn> {
    const start = this.start!;
    parameters.signal?.throwIfAborted();
    this.requesting = true;
    let limit = this.contextLimitBytes;
    try {
      parameters.onStreamEvent?.({ type: "status", status: "in-progress" });
      while (true) {
        let exchanges = this.exchanges.slice();
        let previewLimit: number | undefined;
        let context: string;
        while (true) {
          context = JSON.stringify({
            omittedExchanges: this.exchanges.length - exchanges.length,
            messages: [
              { role: "user", content: start.userPrompt },
              ...exchanges.flatMap((exchange) =>
                historyMessages(exchange, previewLimit),
              ),
            ],
          });
          if (Buffer.byteLength(context, "utf8") <= limit) break;
          if (exchanges.length > 1) exchanges.shift();
          else if (exchanges.length && previewLimit === undefined)
            previewLimit = 4096;
          else if (previewLimit !== undefined && previewLimit > 128)
            previewLimit = Math.floor(previewLimit / 2);
          else
            throw new Error(
              "The task prompt exceeds the remaining cloud context allowance.",
            );
        }
        const request = cloudAgentInferenceSchema.parse({
          requestId: randomUUID(),
          runtimePrompt: start.systemPrompt,
          tools: start.tools,
          context,
          modelOptions: {
            ...(start.reasoning ? { reasoning: start.reasoning } : {}),
            ...(start.toolChoice ? { toolChoice: start.toolChoice } : {}),
            ...(start.structuredOutput
              ? { structuredOutput: start.structuredOutput }
              : {}),
          },
        });
        let response: InferenceResponse;
        try {
          response = await this.transport(request, parameters.signal);
        } catch (error) {
          if (
            !(error instanceof CloudAgentContextLimit) ||
            error.bytes >= limit
          )
            throw error;
          limit = error.bytes;
          continue;
        }
        parameters.signal?.throwIfAborted();
        this.pending = response;
        if (response.text)
          parameters.onStreamEvent?.({
            type: "text-delta",
            delta: response.text,
          });
        parameters.onStreamEvent?.({ type: "status", status: "completed" });
        return response;
      }
    } finally {
      this.requesting = false;
    }
  }
}
