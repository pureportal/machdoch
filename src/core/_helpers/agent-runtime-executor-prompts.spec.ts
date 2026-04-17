/// <reference types="vitest/globals" />
import type {
  AgentModelToolSpec,
  ResolvedTaskContext,
  RuntimeConfig,
} from "../types.js";
import type { PreparedConversationPromptContext } from "./conversation-prompt-context.js";
import { createExecutorSystemPrompt } from "./agent-runtime-executor-prompts.ts";

const createRuntimeConfig = (
  overrides: Partial<RuntimeConfig> = {},
): RuntimeConfig => {
  return {
    workspaceRoot: "c:/Development/machdoch",
    availableProfiles: [],
    mode: "ask",
    enabledTools: ["filesystem", "network"],
    provider: "openai",
    model: "gpt-5.4-mini",
    offline: false,
    compatibility: {
      discoverGithubCustomizations: false,
    },
    providerAvailability: [{ provider: "openai", configured: true }],
    webSearch: {
      activeProvider: "perplexity",
      providerAvailability: [{ provider: "perplexity", configured: true }],
    },
    ...overrides,
  };
};

const createTaskContext = (
  overrides: Partial<ResolvedTaskContext> = {},
): ResolvedTaskContext => {
  return {
    task: "Improve the Tauri updater flow.",
    effectiveTask: "Improve the Tauri updater flow.",
    taskContextText: "",
    instructionContextText: "",
    workspacePaths: [],
    suggestedTools: ["filesystem", "network"],
    blockedTools: [],
    approvalRequiredTools: [],
    toolPolicies: [],
    applicableInstructions: [],
    ...overrides,
  };
};

const createConversationContext = (): PreparedConversationPromptContext => {
  return {
    sections: [],
    memory: {
      sessionEnabled: false,
      sessionEntries: [],
      globalEnabled: false,
      globalEntries: [],
    },
    uiControlEnabled: false,
  };
};

const createTool = (name: string): AgentModelToolSpec => {
  return {
    name,
    description: `${name} description`,
    inputSchema: {
      type: "object",
    },
  };
};

describe("createExecutorSystemPrompt", () => {
  it("encourages proactive web research when search tools are available", () => {
    const prompt = createExecutorSystemPrompt(
      createRuntimeConfig(),
      createTaskContext(),
      [createTool("fetch_url"), createTool("search_web")],
      createConversationContext(),
    );

    expect(prompt).toContain("<research_contract>");
    expect(prompt).toContain(
      "When the task would benefit from current external knowledge, do not be shy about researching first.",
    );
    expect(prompt).toContain("Use `search_web` proactively");
    expect(prompt).toContain("official docs");
    expect(prompt).toContain("use `fetch_url` to inspect the underlying documentation");
    expect(prompt).toContain(
      "Skip web research when the workspace itself already provides the answer",
    );
  });

  it("avoids implying broad research when search_web is unavailable", () => {
    const prompt = createExecutorSystemPrompt(
      createRuntimeConfig({
        webSearch: {
          activeProvider: "none",
          providerAvailability: [],
        },
      }),
      createTaskContext(),
      [createTool("fetch_url")],
      createConversationContext(),
    );

    expect(prompt).toContain("<research_contract>");
    expect(prompt).toContain("Broader web search is not currently available.");
    expect(prompt).toContain("use `fetch_url` directly");
    expect(prompt).toContain(
      "Do not pretend you verified online guidance when you could not actually fetch or search for it.",
    );
    expect(prompt).not.toContain("Use `search_web` proactively");
  });
});