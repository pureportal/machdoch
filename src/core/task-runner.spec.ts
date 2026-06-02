import { previewTaskRun } from "./task-runner.ts";
import type {
  CustomizationDiscoveryResult,
  ProviderAvailability,
  RuntimeConfig,
} from "./types.ts";

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
    availableProfiles: [],
  };
};

const createCustomizations = (): CustomizationDiscoveryResult => {
  return {
    workspaceRoot: "C:/workspace",
    instructions: [
      {
        kind: "always-on",
        path: ".machdoch/instructions.md",
        name: "Workspace defaults",
        body: "Follow the shared workspace defaults.",
        keywords: [],
      },
      {
        kind: "conditional",
        path: ".machdoch/instructions/security.instructions.md",
        name: "Security defaults",
        body: "Protect secrets before running risky actions.",
        keywords: ["install", "auth"],
      },
    ],
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
        path: ".machdoch/skills/browser-automation/SKILL.md",
        name: "browser-automation",
        description: "Automates browser tasks",
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
    instructions: [],
    prompts: [],
    skills: [],
  };
};

describe("previewTaskRun", () => {
  it("surfaces relevant instructions and provider warnings", () => {
    const preview = previewTaskRun(
      "install a package and update the repo",
      createConfig(),
      createCustomizations(),
    );

    expect(preview.blockedTools).toEqual([]);
    expect(preview.applicableInstructions.map((entry) => entry.name)).toEqual([
      "Workspace defaults",
      "Security defaults",
    ]);
    expect(
      preview.warnings.some((warning) => warning.includes("No model provider")),
    ).toBe(true);
    expect(
      preview.notes.some((note) =>
        note.includes("instruction(s) appear relevant"),
      ),
    ).toBe(true);
  });

  it("filters stop words out of prompt and skill suggestions", () => {
    const preview = previewTaskRun(
      "the and this then them with your",
      createConfig(),
      createCustomizations(),
    );

    expect(preview.suggestedPrompts).toHaveLength(0);
    expect(preview.suggestedSkills).toHaveLength(0);
  });

  it("avoids substring keyword matches for conditional instructions", () => {
    const preview = previewTaskRun(
      "authority review for the website",
      createConfig(),
      createCustomizations(),
    );

    expect(preview.applicableInstructions.map((entry) => entry.name)).toEqual([
      "Workspace defaults",
    ]);
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
    expect(preview.notes).toContain("No instruction files were discovered.");
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
      preview.notes.some((note) =>
        note.includes("prefers model `gpt-5.5`"),
      ),
    ).toBe(true);
  });

  it("uses resolved prompt body content to infer additional tools", () => {
    const customizations = createCustomizations();

    customizations.prompts.push({
      path: ".machdoch/prompts/review-ui.prompt.md",
      name: "review-ui",
      description: "Inspect a website UI flow.",
      inputs: [],
      tools: [],
      body: "Use the browser to inspect the website form and click through the login flow.",
    });

    const preview = previewTaskRun(
      "/review-ui",
      createConfig(),
      customizations,
    );

    expect(preview.invokedPrompt?.resolvedBody).toContain("browser");
    expect(preview.suggestedTools).toContain("browser");
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
      "/release-review feature=profiles",
      createConfig(),
      customizations,
    );

    expect(preview.invokedPrompt?.inputValues).toEqual({ feature: "profiles" });
    expect(preview.invokedPrompt?.missingInputs).toEqual(["checklist"]);
    expect(
      preview.warnings.some((warning) =>
        warning.includes("still expects input(s) checklist"),
      ),
    ).toBe(true);
  });

  it("applies conditional instructions when an explicit workspace path matches applyTo", () => {
    const customizations = createCustomizations();

    customizations.instructions.push({
      kind: "conditional",
      path: ".machdoch/instructions/typescript.instructions.md",
      name: "TypeScript rules",
      body: "Prefer strict TypeScript conventions in source files.",
      description: "Use TypeScript conventions for source files.",
      applyTo: "src/**/*.ts",
      keywords: [],
    });

    const preview = previewTaskRun(
      "review src\\core\\config.ts for cleanup",
      createConfig(),
      customizations,
    );

    expect(preview.applicableInstructions.map((entry) => entry.name)).toEqual([
      "Workspace defaults",
      "TypeScript rules",
    ]);
    expect(preview.applicableInstructions[1]?.reason).toContain(
      "src/core/config.ts",
    );
    expect(preview.applicableInstructions[1]?.reason).toContain("src/**/*.ts");
  });

  it("falls back to instruction name and description matching when no keywords are declared", () => {
    const customizations = createCustomizations();

    customizations.instructions.push({
      kind: "conditional",
      path: ".machdoch/instructions/testing.instructions.md",
      name: "Testing conventions",
      body: "Prefer behavior-focused tests with clear assertions.",
      description: "Prefer behavior-focused unit tests and clear assertions.",
      keywords: [],
    });

    const preview = previewTaskRun(
      "improve unit test assertions for the task runner",
      createConfig(),
      customizations,
    );

    expect(preview.applicableInstructions.map((entry) => entry.name)).toEqual([
      "Workspace defaults",
      "Testing conventions",
    ]);
    expect(preview.applicableInstructions[1]?.reason).toContain(
      "unit, assertions",
    );
  });

  it("does not apply a file-pattern instruction when the referenced path does not match the glob", () => {
    const customizations = createCustomizations();

    customizations.instructions.push({
      kind: "conditional",
      path: ".machdoch/instructions/typescript.instructions.md",
      name: "TypeScript rules",
      body: "Prefer strict TypeScript conventions in source files.",
      description: "Use TypeScript conventions for source files.",
      applyTo: "src/**/*.ts",
      keywords: [],
    });

    const preview = previewTaskRun(
      "review README.md for wording",
      createConfig(),
      customizations,
    );

    expect(preview.applicableInstructions.map((entry) => entry.name)).toEqual([
      "Workspace defaults",
    ]);
  });

  it("orders applicable instructions by descending priority and preserves their bodies", () => {
    const customizations = createCustomizations();
    const workspaceDefaultsInstruction = customizations.instructions[0];
    const securityDefaultsInstruction = customizations.instructions[1];

    if (!workspaceDefaultsInstruction || !securityDefaultsInstruction) {
      throw new Error("Expected the instruction fixtures to exist.");
    }

    customizations.instructions[0] = {
      ...workspaceDefaultsInstruction,
      priority: 10,
      body: "Always follow the shared workspace defaults.",
    };
    customizations.instructions[1] = {
      ...securityDefaultsInstruction,
      priority: 90,
      body: "Protect secrets before installs or auth changes.",
    };
    customizations.instructions.push({
      kind: "conditional",
      path: ".machdoch/instructions/testing.instructions.md",
      name: "Testing conventions",
      body: "Keep tests behavior-focused and easy to read.",
      description: "Prefer clear tests for project workflows.",
      keywords: ["test"],
      priority: 60,
    });

    const preview = previewTaskRun(
      "install auth test coverage",
      createConfig(),
      customizations,
    );

    expect(
      preview.applicableInstructions.map((entry) => [
        entry.name,
        entry.priority,
      ]),
    ).toEqual([
      ["Security defaults", 90],
      ["Testing conventions", 60],
      ["Workspace defaults", 10],
    ]);
    expect(preview.applicableInstructions[0]?.body).toContain(
      "Protect secrets",
    );
  });

  it("matches applyTo instructions against prompt-expanded workspace paths", () => {
    const customizations = createCustomizations();

    customizations.instructions.push({
      kind: "conditional",
      path: ".machdoch/instructions/typescript.instructions.md",
      name: "TypeScript rules",
      body: "Prefer strict TypeScript conventions in source files.",
      applyTo: "src/**/*.ts",
      keywords: [],
    });
    customizations.prompts.push({
      path: ".machdoch/prompts/show-file.prompt.md",
      name: "show-file",
      description: "Preview a workspace file.",
      inputs: ["file"],
      tools: ["filesystem"],
      body: "show ${input:file}",
    });

    const preview = previewTaskRun(
      "/show-file file=src/core/config.ts",
      createConfig(),
      customizations,
    );

    expect(preview.invokedPrompt?.resolvedBody).toBe("show src/core/config.ts");
    expect(preview.applicableInstructions.map((entry) => entry.name)).toEqual([
      "Workspace defaults",
      "TypeScript rules",
    ]);
    expect(preview.applicableInstructions[1]?.reason).toContain(
      "src/core/config.ts",
    );
  });
});
