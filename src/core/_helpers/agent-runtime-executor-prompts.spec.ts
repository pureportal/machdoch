/// <reference types="vitest/globals" />
import type {
  AgentModelToolSpec,
  ResolvedTaskContext,
  RuntimeConfig,
} from "../types.js";
import {
  createExecutorSystemPrompt,
  inferTaskStrategyProfile,
} from "./agent-runtime-executor-prompts.ts";
import type { PreparedConversationPromptContext } from "./conversation-prompt-context.js";

const createRuntimeConfig = (
  overrides: Partial<RuntimeConfig> = {},
): RuntimeConfig => {
  return {
    workspaceRoot: "c:/Development/machdoch",
    availableProfiles: [],
    mode: "ask",
    enabledTools: ["filesystem", "network"],
    provider: "openai",
    model: "gpt-5.5",
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
    expect(prompt).toContain(
      "Because `search_web` is configured for this run, strongly prefer using it before non-trivial implementation",
    );
    expect(prompt).toContain("official docs");
    expect(prompt).toContain(
      "use `fetch_url` to inspect the underlying documentation",
    );
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

  it("adds a high-effort strategy profile and execution playbook for broad research-heavy work", () => {
    const taskContext = createTaskContext({
      task: "Improve the whole AI agent smart thinking logic using online best practices and performance guidance.",
      effectiveTask:
        "Improve the whole AI agent smart thinking logic using online best practices and performance guidance.",
      workspacePaths: [
        "src/core/agent-runtime.ts",
        "src/core/_helpers/agent-runtime-executor-prompts.ts",
      ],
    });

    const profile = inferTaskStrategyProfile(taskContext.task, taskContext);

    expect(profile.reasoningEffort).toBe("high");
    expect(profile.requirePlanning).toBe(true);
    expect(profile.requireResearch).toBe(true);

    const prompt = createExecutorSystemPrompt(
      createRuntimeConfig({ mode: "auto" }),
      taskContext,
      [createTool("fetch_url"), createTool("search_web")],
      createConversationContext(),
    );

    expect(prompt).toContain("<strategy_profile>");
    expect(prompt).toContain("reasoning effort: high");
    expect(prompt).toContain("plan before acting: required");
    expect(prompt).toContain(
      "external research before conclusions: required when tools are available",
    );
    expect(prompt).toContain("<execution_playbook>");
    expect(prompt).toContain("discover -> plan -> execute -> verify");
    expect(prompt).toContain(
      "If the same tool call fails twice in a row, do not retry it unchanged",
    );
    expect(prompt).toContain(
      "web research is mandatory before you make specific claims",
    );
  });
});
