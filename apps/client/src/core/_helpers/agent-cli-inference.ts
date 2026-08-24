import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuntimeEnvironment } from "../env.js";
import type {
  AgentCliProvider,
  RuntimeConfig,
} from "../runtime-contract.generated.js";
import type {
  AgentModelImageInput,
  AgentModelStructuredOutput,
  AgentModelTurn,
} from "../types.js";
import {
  getAgentCliProviderLabel,
  resolveAgentCliProviderBinary,
} from "./agent-cli-providers.js";
import { runExternalAgentCommand } from "./external-agent-provider.js";

export interface AgentCliInferenceParams {
  systemPrompt: string;
  userPrompt: string;
  imageInputs?: AgentModelImageInput[];
  structuredOutput?: AgentModelStructuredOutput;
  signal?: AbortSignal;
}

export interface AgentCliInferenceCommand {
  args: string[];
  input: string;
  env: NodeJS.ProcessEnv;
}

export interface MaterializedInferenceInput {
  rootPath: string;
  systemPromptPath: string;
  schemaPath?: string;
  imagePaths: string[];
  dispose: () => Promise<void>;
}

const IMAGE_EXTENSION_BY_MEDIA_TYPE = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/heic": ".heic",
  "image/heif": ".heif",
} as const satisfies Record<AgentModelImageInput["mediaType"], string>;

const materializeInferenceInput = async (
  params: AgentCliInferenceParams,
): Promise<MaterializedInferenceInput> => {
  const rootPath = await mkdtemp(join(tmpdir(), "machdoch-inference-"));
  try {
    const systemPromptPath = join(rootPath, "system-prompt.md");
    await writeFile(systemPromptPath, params.systemPrompt, {
      encoding: "utf8",
      mode: 0o600,
    });

    const schemaPath = params.structuredOutput
      ? join(rootPath, "output-schema.json")
      : undefined;
    if (schemaPath && params.structuredOutput) {
      await writeFile(
        schemaPath,
        JSON.stringify(params.structuredOutput.schema),
        {
          encoding: "utf8",
          mode: 0o600,
        },
      );
    }

    const imagePaths = await Promise.all(
      (params.imageInputs ?? []).map(async (image, index) => {
        const path = join(
          rootPath,
          `image-${index + 1}${IMAGE_EXTENSION_BY_MEDIA_TYPE[image.mediaType]}`,
        );
        await writeFile(path, Buffer.from(image.data, "base64"), {
          mode: 0o600,
        });
        return path;
      }),
    );

    return {
      rootPath,
      systemPromptPath,
      ...(schemaPath ? { schemaPath } : {}),
      imagePaths,
      dispose: async () => {
        await rm(rootPath, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(rootPath, { recursive: true, force: true });
    throw error;
  }
};

const createInferencePrompt = (
  params: AgentCliInferenceParams,
  imagePaths: readonly string[],
): string => {
  const structuredOutputInstruction = params.structuredOutput
    ? [
        "Return only one JSON value that conforms to this JSON Schema:",
        JSON.stringify(params.structuredOutput.schema),
      ].join("\n")
    : undefined;
  const attachments = imagePaths.length
    ? ["Image inputs:", ...imagePaths.map((path) => `- ${path}`)].join("\n")
    : undefined;

  return [
    "Complete this inference directly without tools, external data, or persistent memory.",
    "Follow these system instructions:",
    params.systemPrompt,
    "User request:",
    params.userPrompt,
    attachments,
    structuredOutputInstruction,
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
};

export const createAgentCliInferenceCommand = (
  provider: AgentCliProvider,
  config: RuntimeConfig,
  params: AgentCliInferenceParams,
  materialized: MaterializedInferenceInput,
): AgentCliInferenceCommand => {
  const input = createInferencePrompt(params, materialized.imagePaths);

  switch (provider) {
    case "codex-cli":
      return {
        args: [
          "exec",
          "--sandbox",
          "read-only",
          "--ephemeral",
          "--json",
          "--skip-git-repo-check",
          "--ignore-rules",
          "--ignore-user-config",
          "--cd",
          materialized.rootPath,
          "--model",
          config.model,
          "--config",
          "agents.enabled=false",
          "--config",
          "features.shell_tool=false",
          "--config",
          "features.skill_mcp_dependency_install=false",
          "--config",
          "tools.view_image=false",
          "--config",
          "tools.web_search=false",
          ...materialized.imagePaths.flatMap((path) => ["--image", path]),
          ...(materialized.schemaPath
            ? ["--output-schema", materialized.schemaPath]
            : []),
          "-",
        ],
        input,
        env: {},
      };

    case "claude-cli":
      return {
        args: [
          "-p",
          "--safe-mode",
          "--system-prompt-file",
          materialized.systemPromptPath,
          "--tools",
          materialized.imagePaths.length > 0 ? "Read" : "",
          "--disallowedTools",
          "mcp__*",
          "--output-format",
          "stream-json",
          "--verbose",
          "--model",
          config.model,
          "--no-session-persistence",
          ...(params.structuredOutput
            ? ["--json-schema", JSON.stringify(params.structuredOutput.schema)]
            : []),
        ],
        input: [
          params.userPrompt,
          materialized.imagePaths.length > 0
            ? [
                "Read and inspect these image files:",
                ...materialized.imagePaths.map((path) => `- ${path}`),
              ].join("\n")
            : undefined,
        ]
          .filter((part): part is string => Boolean(part))
          .join("\n\n"),
        env: {
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
          CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
          CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1",
        },
      };

    case "copilot-cli":
      return {
        args: [
          "-s",
          "--stream=off",
          "--output-format=json",
          "--no-ask-user",
          "--no-auto-update",
          "--no-custom-instructions",
          "--disable-builtin-mcps",
          "--available-tools=",
          `--model=${config.model}`,
          ...materialized.imagePaths.flatMap((path) => ["--attachment", path]),
        ],
        input,
        env: { COPILOT_PLUGIN_DIR_ONLY: "true" },
      };
  }
};

export const executeAgentCliInference = async (
  provider: AgentCliProvider,
  config: RuntimeConfig,
  params: AgentCliInferenceParams,
): Promise<AgentModelTurn> => {
  const env = await loadRuntimeEnvironment();
  const binary = resolveAgentCliProviderBinary(provider, env);
  const providerLabel = getAgentCliProviderLabel(provider);

  if (!binary.available || !binary.executable) {
    throw new Error(
      binary.reason ?? `${providerLabel} executable could not be resolved.`,
    );
  }

  const materialized = await materializeInferenceInput(params);
  try {
    const command = createAgentCliInferenceCommand(
      provider,
      config,
      params,
      materialized,
    );
    const result = await runExternalAgentCommand(
      binary.executable,
      command.args,
      command.input,
      { ...config, workspaceRoot: materialized.rootPath },
      provider,
      command.env,
      params.signal,
      undefined,
    );

    if (result.exitCode !== 0) {
      throw new Error(
        `${providerLabel} internal inference failed: ${result.stderr || result.stdout || `exit code ${result.exitCode ?? "unknown"}`}`,
      );
    }

    return {
      text: result.stdout,
      toolCalls: [],
      stopReason: "completed",
      ...(result.usage ? { usage: result.usage } : {}),
    };
  } finally {
    await materialized.dispose();
  }
};
