import { Ajv2020 } from "ajv/dist/2020.js";
import { executeAgentCliInference } from "./_helpers/agent-cli-inference.js";
import { isAgentCliProvider } from "./_helpers/agent-cli-providers.js";
import { createProviderAdapter } from "./_helpers/provider-adapters.js";
import { normalizeReasoningModeForProviderModel } from "./reasoning-modes.js";
import type { RuntimeConfig } from "./runtime-contract.generated.js";
import type {
  AgentModelAdapter,
  AgentModelImageInput,
  AgentModelRequestAttemptHandler,
  AgentModelStructuredOutput,
  AgentModelTurn,
} from "./types.js";

export interface InternalTaskModelInferenceParams {
  systemPrompt: string;
  userPrompt: string;
  imageInputs?: AgentModelImageInput[];
  structuredOutput?: AgentModelStructuredOutput;
  signal?: AbortSignal;
  onRequestAttempt?: AgentModelRequestAttemptHandler;
}

const structuredOutputValidator = new Ajv2020({
  allErrors: true,
  strict: true,
});

export const resolveInternalTaskRuntimeConfig = (
  config: RuntimeConfig,
): RuntimeConfig | null => {
  const provider = config.internalTaskModel.provider;
  const model = config.internalTaskModel.model.trim();

  if (provider === "unconfigured" || !model) {
    return null;
  }

  return {
    ...config,
    provider,
    model,
    reasoning: normalizeReasoningModeForProviderModel(
      config.internalTaskModel.reasoning,
      provider,
      model,
    ),
  };
};

export const requireInternalTaskRuntimeConfig = (
  config: RuntimeConfig,
): RuntimeConfig => {
  const internalConfig = resolveInternalTaskRuntimeConfig(config);

  if (!internalConfig) {
    throw new Error(
      "Choose an internal task model in Settings > Providers before running this AI task.",
    );
  }

  return internalConfig;
};

export const parseInternalTaskStructuredOutput = <T>(
  text: string,
  structuredOutput: AgentModelStructuredOutput,
): T => {
  let output: unknown;

  try {
    output = JSON.parse(text.trim()) as unknown;
  } catch (error) {
    throw new Error(
      `The internal task model returned invalid JSON for ${structuredOutput.name}.`,
      { cause: error },
    );
  }

  const validate = structuredOutputValidator.compile(
    structuredOutput.schema as object,
  );
  if (!validate(output)) {
    throw new Error(
      `The internal task model returned data that does not match ${structuredOutput.name}: ${structuredOutputValidator.errorsText(validate.errors)}.`,
    );
  }

  return output as T;
};

export const executeInternalTaskModelInference = async (
  config: RuntimeConfig,
  params: InternalTaskModelInferenceParams,
  overrideAdapter?: AgentModelAdapter,
): Promise<AgentModelTurn> => {
  const internalConfig = requireInternalTaskRuntimeConfig(config);

  let turn: AgentModelTurn;
  if (isAgentCliProvider(internalConfig.provider) && !overrideAdapter) {
    turn = await executeAgentCliInference(
      internalConfig.provider,
      internalConfig,
      params,
    );
  } else {
    const adapter = await createProviderAdapter(
      internalConfig,
      [],
      overrideAdapter,
    );
    if (!adapter) {
      throw new Error(
        `The configured internal task model ${internalConfig.provider}/${internalConfig.model} is unavailable.`,
      );
    }

    turn = await adapter.startTurn({
      model: internalConfig.model,
      systemPrompt: params.systemPrompt,
      userPrompt: params.userPrompt,
      ...(params.imageInputs ? { imageInputs: params.imageInputs } : {}),
      tools: [],
      ...(params.structuredOutput
        ? { structuredOutput: params.structuredOutput }
        : {}),
      ...(params.signal ? { signal: params.signal } : {}),
      ...(params.onRequestAttempt
        ? { onRequestAttempt: params.onRequestAttempt }
        : {}),
    });
  }

  return turn;
};
