import { describe, expect, it } from "vitest";
import type { RuntimeConfig } from "../runtime-contract.generated.js";
import {
  createAgentCliInferenceCommand,
  type AgentCliInferenceParams,
  type MaterializedInferenceInput,
} from "./agent-cli-inference.js";

const config: RuntimeConfig = {
  workspaceRoot: "C:/workspace",
  mode: "machdoch",
  provider: "codex-cli",
  model: "gpt-5.6-sol",
  reasoning: "default",
  contextWindow: "default",
  offline: false,
  compatibility: { discoverGithubCustomizations: false },
  providerAvailability: [],
  webSearch: { activeProvider: "none", providerAvailability: [] },
  reviewModel: { mode: "base" },
  internalTaskModel: {
    provider: "codex-cli",
    model: "gpt-5.6-sol",
    reasoning: "default",
  },
};

const params: AgentCliInferenceParams = {
  systemPrompt: "Extract durable facts.",
  userPrompt: "Review this completed task.",
  structuredOutput: {
    name: "memory_decisions",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { memories: { type: "array", items: { type: "string" } } },
      required: ["memories"],
    },
    strict: true,
  },
};

const materialized: MaterializedInferenceInput = {
  rootPath: "C:/temp/inference",
  systemPromptPath: "C:/temp/inference/system-prompt.md",
  schemaPath: "C:/temp/inference/output-schema.json",
  imagePaths: [],
  dispose: async () => undefined,
};

describe("agent CLI internal inference commands", () => {
  it("uses Codex schema output in an ephemeral read-only invocation", () => {
    const command = createAgentCliInferenceCommand(
      "codex-cli",
      config,
      params,
      materialized,
    );

    expect(command.args).toContain("--output-schema");
    expect(command.args).toContain("--ignore-user-config");
    expect(command.args).toContain("read-only");
    expect(command.args).toContain("agents.enabled=false");
    expect(command.args).toContain("features.shell_tool=false");
    expect(command.args).toContain("tools.web_search=false");
    expect(command.args).not.toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
    expect(command.input).toContain("Extract durable facts.");
    expect(command.input).toContain("without tools");
  });

  it("uses Claude's native system prompt and JSON schema with no tools", () => {
    const command = createAgentCliInferenceCommand(
      "claude-cli",
      { ...config, provider: "claude-cli", model: "sonnet" },
      params,
      materialized,
    );

    expect(command.args).toContain("--safe-mode");
    expect(command.args).toContain("--system-prompt-file");
    expect(command.args).toContain("--json-schema");
    expect(command.args[command.args.indexOf("--tools") + 1]).toBe("");
    expect(command.input).toBe("Review this completed task.");
  });

  it("constrains Copilot tools and requests JSON through the prompt", () => {
    const command = createAgentCliInferenceCommand(
      "copilot-cli",
      { ...config, provider: "copilot-cli", model: "auto" },
      params,
      materialized,
    );

    expect(command.args).toContain("--available-tools=");
    expect(command.args).toContain("--disable-builtin-mcps");
    expect(command.args).not.toContain("--allow-all");
    expect(command.args).not.toContain("--autopilot");
    expect(command.input).toContain("Return only one JSON value");
    expect(command.input).toContain('"memories"');
  });
});
