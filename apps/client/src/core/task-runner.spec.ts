import { previewTaskRun } from "./task-runner.ts";
import type { CustomizationDiscoveryResult } from "./types.ts";
import type {
  ProviderAvailability,
  RuntimeConfig,
} from "./runtime-contract.generated.ts";

const providerAvailability: ProviderAvailability[] = [
  { provider: "openai", configured: false },
  { provider: "anthropic", configured: false },
  { provider: "google", configured: false },
];

const createConfig = (
  mode: RuntimeConfig["mode"] = "machdoch",
): RuntimeConfig => {
  return {
    workspaceRoot: "C:/workspace",
    mode,
    provider: "unconfigured",
    model: "gpt-5.5",
    reasoning: "default",
    contextWindow: "default",
    offline: false,
    compatibility: {
      discoverGithubCustomizations: false,
    },
    providerAvailability,
    webSearch: {
      activeProvider: "none",
      providerAvailability: [
        { provider: "perplexity", configured: false },
        { provider: "tavily", configured: false },
      ],
    },
    reviewModel: {
      mode: "base",
    },
    internalTaskModel: {
      provider: "unconfigured",
      model: "gpt-5.5",
      reasoning: "default",
    },
  };
};

const createCustomizations = (): CustomizationDiscoveryResult => {
  return {
    workspaceRoot: "C:/workspace",
    prompts: [
      {
        path: ".machdoch/prompts/debug-build.prompt.md",
        name: "debug-build",
        description: "Diagnose build failures",
        argumentHint: "Build error",
        inputs: ["error", "logs"],
        tools: ["filesystem", "shell"],
        body: "Investigate the failing build and explain the fix.",
      },
      {
        path: ".machdoch/prompts/and-the.prompt.md",
        name: "and-the",
        description: "the and this then",
        inputs: [],
        tools: [],
        body: "the and this then",
      },
    ],
    skills: [
      {
        path: ".machdoch/skills/release-automation/SKILL.md",
        name: "release-automation",
        description: "Automates release tasks",
        userInvocable: true,
        disableModelInvocation: false,
      },
      {
        path: ".machdoch/skills/stop-words/SKILL.md",
        name: "the-and-this",
        description: "and the this then",
        userInvocable: true,
        disableModelInvocation: false,
      },
    ],
  };
};

const createEmptyCustomizations = (): CustomizationDiscoveryResult => {
  return {
    workspaceRoot: "C:/workspace",
    prompts: [],
    skills: [],
  };
};

describe("previewTaskRun", () => {
  it("filters stop words out of prompt and skill suggestions", () => {
    const preview = previewTaskRun(
      "the and this then them with your",
      createConfig(),
      createCustomizations(),
    );

    expect(preview.suggestedPrompts).toHaveLength(0);
    expect(preview.suggestedSkills).toHaveLength(0);
  });

  it("resolves direct prompt invocations and merges prompt tools into the preview", () => {
    const preview = previewTaskRun(
      "/debug-build TypeScript compile fails after install",
      createConfig(),
      createCustomizations(),
    );

    expect(preview.invokedPrompt?.name).toBe("debug-build");
    expect(preview.invokedPrompt?.arguments).toBe(
      "TypeScript compile fails after install",
    );
    expect(preview.invokedPrompt?.tools).toEqual(["filesystem", "shell"]);
    expect(preview.suggestedPrompts).toEqual([]);
    expect(
      preview.notes.some((note) =>
        note.includes("Resolved the `/debug-build` prompt"),
      ),
    ).toBe(true);
  });

  it("warns when a slash command looks like a prompt but no prompt was discovered", () => {
    const preview = previewTaskRun(
      "/missing-prompt explain the error",
      createConfig(),
      createCustomizations(),
    );

    expect(
      preview.warnings.some((warning) =>
        warning.includes("no prompt named `missing-prompt`"),
      ),
    ).toBe(true);
  });

  it("warns when an invoked prompt declares inputs but no arguments were supplied", () => {
    const preview = previewTaskRun(
      "/debug-build",
      createConfig(),
      createCustomizations(),
    );

    expect(
      preview.warnings.some((warning) =>
        warning.includes("still expects input(s) error, logs"),
      ),
    ).toBe(true);
  });

  it("warns for an unavailable selected provider and records mode notes", () => {
    const preview = previewTaskRun(
      "run a command",
      {
        ...createConfig("ask"),
        provider: "openai",
      },
      createEmptyCustomizations(),
    );

    expect(
      preview.warnings.some((warning) =>
        warning.includes("selected provider `openai` does not look configured"),
      ),
    ).toBe(true);
    expect(
      preview.notes.some((note) =>
        note.includes("Ask mode exposes only read-only function calls."),
      ),
    ).toBe(true);
  });

  it("warns when a task needs web search but the active provider keeps it hidden", () => {
    const preview = previewTaskRun(
      "search the web for recent Tauri updater guidance",
      {
        ...createConfig(),
        webSearch: {
          activeProvider: "none",
          providerAvailability: [
            { provider: "perplexity", configured: false },
            { provider: "tavily", configured: false },
          ],
        },
      },
      createEmptyCustomizations(),
    );

    expect(
      preview.warnings.some((warning) =>
        warning.includes(
          "Web search is currently hidden from the executor because the active web-search provider is set to `none`.",
        ),
      ),
    ).toBe(true);
  });

  it("supports prompt: invocations, deduplicates suggested tools, and notes the prompt model", () => {
    const customizations = createCustomizations();
    const debugBuildPrompt = customizations.prompts[0];

    if (!debugBuildPrompt) {
      throw new Error("Expected the debug-build prompt fixture to exist.");
    }

    customizations.prompts[0] = {
      ...debugBuildPrompt,
      model: "gpt-5.5",
    };

    const preview = previewTaskRun(
      "prompt:debug-build run the failing build",
      createConfig(),
      customizations,
    );

    expect(preview.invokedPrompt?.name).toBe("debug-build");
    expect(preview.suggestedTools).toEqual(["filesystem", "shell"]);
    expect(
      preview.notes.some((note) => note.includes("prefers model `gpt-5.5`")),
    ).toBe(true);
  });

  it("does not infer tool authority from resolved prompt prose", () => {
    const customizations = createCustomizations();

    customizations.prompts.push({
      path: ".machdoch/prompts/review-build.prompt.md",
      name: "review-build",
      description: "Inspect a build failure.",
      inputs: [],
      tools: [],
      body: "Use the shell to inspect the build logs and identify the failing command.",
    });

    const preview = previewTaskRun(
      "/review-build",
      createConfig(),
      customizations,
    );

    expect(preview.invokedPrompt?.resolvedBody).toContain("shell");
    expect(preview.suggestedTools).toEqual([]);
  });

  it("warns when an invoked prompt still has unresolved input placeholders", () => {
    const customizations = createCustomizations();

    customizations.prompts.push({
      path: ".machdoch/prompts/release-review.prompt.md",
      name: "release-review",
      description: "Prepare a release review from specific inputs.",
      inputs: ["feature"],
      tools: ["filesystem"],
      body: "Review ${input:feature} using ${input:checklist:release checklist}.",
    });

    const preview = previewTaskRun(
      "/release-review feature=permissions",
      createConfig(),
      customizations,
    );

    expect(preview.invokedPrompt?.inputValues).toEqual({
      feature: "permissions",
    });
    expect(preview.invokedPrompt?.missingInputs).toEqual(["checklist"]);
    expect(
      preview.warnings.some((warning) =>
        warning.includes("still expects input(s) checklist"),
      ),
    ).toBe(true);
  });
});
