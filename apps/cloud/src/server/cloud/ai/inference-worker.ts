import type { createModelAdapter } from "@machdoch/model-runtime/connections";
import type {
  AgentModelAdapter,
  AgentModelStartParams,
  AgentModelStreamEvent,
  AgentModelToolCall,
  AgentModelToolSpec,
} from "@machdoch/model-runtime/types";
import {
  createIsolatedModelAdapter,
  validateInferenceTools,
  ModelWorkerFailure,
} from "./isolated-model";
import { CliModelFailure, createCliModelAdapter } from "./cli-model";
import { isCloudError } from "../access";
import { maximumInferenceAnswerBytes } from "./inference-records";
import { CloudInferenceStore, type ClaimedInference } from "./inference-store";
import type { CloudAiProviders } from "./providers";
import type { CloudAgentTools } from "./agent-tools";
import { runAgent, usageTokens, type AgentProgress } from "./agent-loop";

export type CloudModelAdapterFactory = typeof createModelAdapter;
class InferenceStopped extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const maximumLocalRequests = 16;

interface ModelResponse {
  text: string;
  toolCalls: AgentModelToolCall[];
  stopReason: string | undefined;
  tokens: number | null;
  progress?: AgentProgress;
}

class InferenceOutput {
  text = "";
  private finalAnswer = false;
  constructor(private readonly controller: AbortController) {}
  reset(): void {
    this.text = "";
    this.finalAnswer = false;
  }
  consume(event: AgentModelStreamEvent): void {
    if (this.controller.signal.aborted) return;
    if (event.type === "usage") return;
    if (event.type === "final-answer") {
      this.finalAnswer = true;
      this.setText(
        event.snapshot.status === "retracted" ? "" : event.snapshot.text,
      );
    } else if (event.type === "text-delta" && !this.finalAnswer)
      this.setText(this.text + event.delta);
  }
  setText(text: string): void {
    if (
      text.length > maximumInferenceAnswerBytes ||
      Buffer.byteLength(text, "utf8") > maximumInferenceAnswerBytes
    ) {
      this.controller.abort(new InferenceStopped("output_limit"));
      return;
    }
    this.text = text;
  }
}

export class CloudInferenceWorker {
  private readonly active = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pumping = false;
  private started = false;
  private closed = false;
  private pollDelay = 1000;

  constructor(
    private readonly store: CloudInferenceStore,
    private readonly providers: CloudAiProviders,
    private readonly agentTools: CloudAgentTools,
    private readonly factory: CloudModelAdapterFactory = createIsolatedModelAdapter,
  ) {}

  start(): void {
    if (this.closed) throw new Error("Inference worker is closed.");
    if (this.started) return;
    this.started = true;
    this.wake();
  }
  wake(): void {
    if (!this.started || this.closed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.pump(), 0);
    this.timer.unref();
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    try {
      await this.store.recover();
      const pending = await this.store.pending(
        Math.max(0, maximumLocalRequests - this.active.size),
      );
      for (const item of pending)
        void this.runOne(item.organizationId, item.id);
      this.pollDelay = 1000;
    } catch (error) {
      this.pollDelay = Math.min(30000, this.pollDelay * 2);
      console.error(
        "Cloud inference dispatch failed",
        error instanceof Error ? error.name : "Unknown error",
      );
    } finally {
      this.pumping = false;
      if (!this.closed && this.started) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.pump(), this.pollDelay);
        this.timer.unref();
      }
    }
  }

  runOne(organizationId: string, id: string): Promise<void> {
    const key = `${organizationId}/${id}`;
    const existing = this.active.get(key);
    if (existing) return existing.done;
    if (this.closed) return Promise.resolve();
    const controller = new AbortController();
    const done = Promise.resolve()
      .then(() => this.execute(organizationId, id, controller))
      .catch((error: unknown) => {
        console.error(
          "Cloud inference processing failed",
          error instanceof Error ? error.name : "Unknown error",
        );
      })
      .finally(() => {
        this.active.delete(key);
        this.wake();
      });
    this.active.set(key, { controller, done });
    return done;
  }

  private async execute(
    organizationId: string,
    id: string,
    controller: AbortController,
  ): Promise<void> {
    const claimedAt = performance.now();
    const call = await this.store.claim(organizationId, id);
    if (!call) return;
    const output = new InferenceOutput(controller);
    let progress: AgentProgress | undefined;
    let finished = false;
    let leaseTimer: ReturnType<typeof setTimeout>;
    let watcher: ReturnType<typeof setTimeout> | undefined;
    const stop = (code = "interrupted") =>
      controller.abort(new InferenceStopped(code));
    const renew = (startedAt: number, remainingMs: number) => {
      clearTimeout(leaseTimer);
      const remaining = remainingMs - (performance.now() - startedAt);
      if (remaining <= 0) stop();
      else {
        leaseTimer = setTimeout(stop, remaining);
        leaseTimer.unref();
      }
    };
    renew(claimedAt, call.leaseRemainingMs);
    const deadline = setTimeout(
      stop,
      Math.max(0, call.deadlineRemainingMs - (performance.now() - claimedAt)),
    );
    deadline.unref();
    const persist = async () => {
      const startedAt = performance.now();
      const renewal = await this.store.guard(
        organizationId,
        id,
        call.executionId,
        { answer: output.text, progress },
      );
      if (finished) return;
      if (!renewal.allowed) stop();
      else renew(startedAt, renewal.leaseRemainingMs);
    };
    const watch = async () => {
      if (finished || controller.signal.aborted) return;
      try {
        await persist();
      } catch (error) {
        stop();
        console.error(
          "Cloud inference lease renewal failed",
          error instanceof Error ? error.name : "Unknown error",
        );
      }
      if (!finished && !controller.signal.aborted) {
        watcher = setTimeout(() => void watch(), 1000);
        watcher.unref();
      }
    };
    watcher = setTimeout(() => void watch(), 1000);
    watcher.unref();
    let onAbort: (() => void) | undefined;
    let finalTokens: number | null = null;
    let result: Parameters<CloudInferenceStore["finish"]>[3];
    try {
      const actor = { organizationId, userId: call.actorId };
      const resolved = await this.providers.resolve(
        actor,
        call.providerId,
        call.model,
      );
      if (resolved.configuration.inferenceRevision !== call.providerRevision)
        throw new InferenceStopped("permission_changed");
      if (resolved.cli && call.runId)
        throw new InferenceStopped("cli_provider_requires_client");
      const createAdapter = async (
        tools: AgentModelToolSpec[],
      ): Promise<AgentModelAdapter> =>
        resolved.cli
          ? createCliModelAdapter(resolved.cli)
          : this.factory(resolved.connection, tools);
      const session = call.runId
        ? undefined
        : await this.agentTools.open(actor);
      controller.signal.throwIfAborted();
      const startedAt = performance.now();
      const grant = await this.store.guard(
        organizationId,
        id,
        call.executionId,
        { begin: true },
      );
      if (!grant.allowed) return;
      renew(startedAt, grant.leaseRemainingMs);
      controller.signal.throwIfAborted();
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      const request = {
        toolChoice: "auto" as const,
        ...call.modelOptions,
        model: call.model,
        systemPrompt: call.systemPrompt,
        parallelAgentMode: "disabled" as const,
        maxOutputTokens: call.maxOutputTokens,
        maxRequestAttempts: 1,
        storeResponses: false,
      };
      const response = await Promise.race([
        session
          ? runAgent({
              createAdapter,
              request,
              conversation: call.userPrompt,
              session,
              signal: controller.signal,
              onStreamEvent: (event) => output.consume(event),
              onRoundStart: () => output.reset(),
              onProgress: async (current) => {
                progress = current;
                await persist();
              },
            }).then((agent): ModelResponse => {
              progress = agent.progress;
              return { ...agent, toolCalls: [] };
            })
          : this.runTask(
              call,
              request,
              createAdapter,
              output,
              controller,
              (tokens) => {
                finalTokens = tokens;
              },
            ),
        aborted,
      ]);
      finalTokens = response.tokens;
      if (
        Buffer.byteLength(
          JSON.stringify({
            text: response.text,
            toolCalls: response.toolCalls,
          }),
          "utf8",
        ) > maximumInferenceAnswerBytes
      )
        throw new InferenceStopped("output_limit");
      output.setText(response.text);
      controller.signal.throwIfAborted();
      if (
        !output.text.trim() &&
        !response.toolCalls.length &&
        !progress?.question &&
        !progress?.actions.length
      )
        throw new InferenceStopped(
          response.stopReason === "incomplete"
            ? "response_incomplete"
            : "provider_unavailable",
        );
      finished = true;
      const limited = ["max_tokens", "length", "MAX_TOKENS"].includes(
        response.stopReason ?? "",
      );
      if (call.runId && (limited || response.stopReason === "incomplete"))
        throw new InferenceStopped(
          limited ? "output_limit" : "response_incomplete",
        );
      result = {
        state: "complete",
        answer: output.text,
        progress,
        response: call.runId
          ? {
              text: output.text,
              toolCalls: response.toolCalls.map(
                ({ id, name, arguments: args }) => ({
                  id,
                  name,
                  arguments: args,
                }),
              ),
            }
          : undefined,
        tokens: finalTokens,
        errorCode: limited
          ? "output_limit"
          : response.stopReason === "incomplete"
            ? "response_incomplete"
            : null,
      };
    } catch (error) {
      finished = true;
      const code = this.errorCode(error);
      result = {
        state: code === "interrupted" ? "unknown" : "failed",
        answer: output.text,
        progress,
        tokens: finalTokens,
        errorCode: code,
      };
    } finally {
      finished = true;
      clearTimeout(leaseTimer!);
      clearTimeout(deadline);
      clearTimeout(watcher);
      if (onAbort) controller.signal.removeEventListener("abort", onAbort);
    }
    await this.store.finish(organizationId, id, call.executionId, result);
  }

  private async runTask(
    call: ClaimedInference,
    request: Omit<AgentModelStartParams, "userPrompt" | "tools">,
    createAdapter: (tools: AgentModelToolSpec[]) => Promise<AgentModelAdapter>,
    output: InferenceOutput,
    controller: AbortController,
    reportTokens: (tokens: number | null) => void,
  ): Promise<ModelResponse> {
    const adapter = await createAdapter(call.tools);
    const response = await adapter.startTurn({
      ...request,
      userPrompt: call.userPrompt,
      tools: call.tools,
      signal: controller.signal,
      onStreamEvent: (event) => output.consume(event),
    });
    const tokens = usageTokens(response.usage);
    reportTokens(tokens);
    if (
      response.toolCalls.length > 16 ||
      new Set(response.toolCalls.map((tool) => tool.id)).size !==
        response.toolCalls.length
    )
      throw new InferenceStopped("invalid_tools");
    for (const tool of response.toolCalls) {
      const definition = call.tools.find((entry) => entry.name === tool.name);
      if (!definition) throw new InferenceStopped("unexpected_tools");
      if (!tool.id || tool.argumentError)
        throw new InferenceStopped("invalid_tools");
    }
    try {
      if (
        !(await validateInferenceTools(
          call.tools,
          response.toolCalls,
          controller.signal,
        ))
      )
        throw new InferenceStopped("invalid_tools");
    } catch (error) {
      if (error instanceof ModelWorkerFailure)
        throw new InferenceStopped(`tool_${error.code}`);
      throw error;
    }
    return {
      text: response.text,
      toolCalls: response.toolCalls,
      stopReason: response.stopReason,
      tokens,
    };
  }

  private errorCode(error: unknown): string {
    if (error instanceof InferenceStopped) return error.code;
    if (error instanceof CliModelFailure) return error.code;
    if (error instanceof ModelWorkerFailure && error.code === "output_limit")
      return "output_limit";
    if (error instanceof ModelWorkerFailure && error.code === "worker_timeout")
      return "model_processing_timeout";
    if (isCloudError(error))
      return error.code === "credential_storage"
        ? error.code
        : "permission_changed";
    if (error && typeof error === "object" && "status" in error) {
      const status = Number(error.status);
      if (status === 401) return "provider_authentication";
      if (status === 402) return "provider_billing";
      if (status === 403) return "provider_access";
      if (status === 404) return "provider_model_unavailable";
      if (status === 429) return "provider_rate_limited";
    }
    return "provider_unavailable";
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    const pending = [...this.active.values()];
    for (const item of pending)
      item.controller.abort(new InferenceStopped("interrupted"));
    let deadline: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([
        Promise.all(pending.map((item) => item.done)),
        new Promise<void>((resolve) => {
          deadline = setTimeout(resolve, 5000);
        }),
      ]);
    } finally {
      clearTimeout(deadline!);
    }
  }
}
