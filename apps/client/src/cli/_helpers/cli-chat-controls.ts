import { loadRuntimeConfig } from "../../core/config.js";
import {
  getProviderModelMetadata,
  type ConfiguredModelProvider,
} from "../../core/provider-model-registry.js";
import {
  getReasoningModesForProviderModel,
  normalizeReasoningModeForProviderModel,
} from "../../core/reasoning-modes.js";
import {
  VALID_MODEL_PROVIDERS,
  type RuntimeConfig,
  type ReasoningMode,
  type RunMode,
} from "../../core/runtime-contract.generated.js";
import type { ParsedCliArgs } from "./cli-args.js";
import type { ChatInput } from "./cli-chat-input.js";
import type { CliChatSession } from "./cli-chat-sessions.js";
import {
  createTerminalPrompter,
  type InteractivePrompter,
} from "./cli-prompter.js";
import { CliUsageError } from "./cli-error.js";

export interface ChatState {
  args: ParsedCliArgs;
  config: RuntimeConfig;
  session: CliChatSession;
  lastTask?: { text: string; args: ParsedCliArgs };
}

export const loadChatConfig = async (
  args: ParsedCliArgs,
): Promise<RuntimeConfig> =>
  await loadRuntimeConfig(
    args.workspaceRoot,
    args.mode,
    args.model,
    args.runtimeProvider,
    args.agentLimits,
    args.reasoning,
  );

export const showChatStatus = (
  state: ChatState,
  write: (line: string) => void,
): void => {
  write(
    `${state.args.workspaceRoot}\n${state.config.mode} · ${state.config.provider} / ${state.config.model} · reasoning ${state.config.reasoning}`,
  );
};

export const withChatMenu = async <T>(
  input: ChatInput,
  action: (prompter: InteractivePrompter) => Promise<T>,
): Promise<T> =>
  await input.suspend(async () => {
    const prompter = createTerminalPrompter();
    try {
      return await action(prompter);
    } finally {
      prompter.close();
    }
  });

export const handleChatRuntimeControl = async (
  command: string,
  values: string[],
  state: ChatState,
  input: ChatInput,
  write: (line: string) => void,
): Promise<boolean> => {
  const usage = (message: string): never => {
    throw new CliUsageError(`Usage: /${command} ${message}`.trim());
  };
  if (command === "status") {
    if (values.length) usage("");
    showChatStatus(state, write);
    return true;
  }
  if (command === "mode" || command === "reasoning" || command === "model") {
    let nextArgs = { ...state.args };
    if (command === "model") {
      if (values.length > 2) usage("[provider model]");
      let provider = values.length === 2 ? values[0] : state.config.provider;
      let model = values.at(-1);
      if (!values.length) {
        const selection = await withChatMenu(input, async (prompter) => {
          const selectedProvider = await prompter.select(
            "Provider",
            state.config.providerAvailability.map((entry) => ({
              value: entry.provider,
              label: `${entry.provider}${entry.configured ? "" : " (not configured)"}`,
            })),
            { currentValue: state.config.provider },
          );
          if (!selectedProvider) return undefined;
          const models = getProviderModelMetadata(
            selectedProvider as ConfiguredModelProvider,
          ).filter(
            (entry) =>
              entry.lifecycle !== "deprecated" && entry.capabilities.toolUse,
          );
          const choices = models.map((entry) => ({
            value: entry.id,
            label: entry.label,
          }));
          if (
            selectedProvider === state.config.provider &&
            !choices.some((entry) => entry.value === state.config.model)
          )
            choices.unshift({
              value: state.config.model,
              label: state.config.model,
            });
          choices.push({ value: "__custom", label: "Enter model id" });
          let selectedModel = await prompter.select(
            "Model",
            choices,
            selectedProvider === state.config.provider
              ? { currentValue: state.config.model }
              : undefined,
          );
          if (selectedModel === "__custom")
            selectedModel = await prompter.input("Model id");
          return selectedModel
            ? { provider: selectedProvider, model: selectedModel }
            : undefined;
        });
        if (!selection) return true;
        ({ provider, model } = selection);
      }
      if (
        !provider ||
        !VALID_MODEL_PROVIDERS.includes(provider as ConfiguredModelProvider) ||
        !model
      )
        usage("<provider> <model>");
      nextArgs = {
        ...nextArgs,
        runtimeProvider: provider as ConfiguredModelProvider,
        model: model!,
        reasoning: normalizeReasoningModeForProviderModel(
          state.config.reasoning,
          provider as ConfiguredModelProvider,
          model,
        ),
      };
    } else {
      if (values.length > 1)
        usage(command === "mode" ? "[ask|machdoch]" : "[level]");
      const choices: readonly string[] =
        command === "mode"
          ? ["ask", "machdoch"]
          : getReasoningModesForProviderModel(
              state.config.provider === "unconfigured"
                ? undefined
                : state.config.provider,
              state.config.model,
            );
      const value =
        values[0] ??
        (await withChatMenu(input, (prompter) =>
          prompter.select(
            command === "mode" ? "Mode" : "Reasoning",
            choices.map((value) => ({ value, label: value })),
            { currentValue: state.config[command] },
          ),
        ));
      if (value === undefined) return true;
      if (!choices.includes(value))
        throw new CliUsageError(`Choose ${choices.join(", ")}.`);
      nextArgs =
        command === "mode"
          ? { ...nextArgs, mode: value as RunMode }
          : { ...nextArgs, reasoning: value as ReasoningMode };
    }
    const config = await loadChatConfig(nextArgs);
    state.args = nextArgs;
    state.config = config;
    showChatStatus(state, write);
    return true;
  }
  return false;
};
