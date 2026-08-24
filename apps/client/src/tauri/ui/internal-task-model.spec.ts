import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderModelCatalogSnapshot } from "./model-catalog";
import {
  getInternalTaskProviderModels,
  loadInternalTaskModelSelection,
  resolveInternalTaskModelSelection,
  runInternalDesktopTask,
  runInternalRalphGenerationInterview,
  runInternalTaskInterview,
} from "./internal-task-model";

const runtime = vi.hoisted(() => ({
  loadGlobalProviderAvailability: vi.fn(),
  loadProviderModelCatalog: vi.fn(),
  loadUserInternalTaskModelSettings: vi.fn(),
  runDesktopTask: vi.fn(),
  runRalphGenerationInterview: vi.fn(),
  runTaskInterview: vi.fn(),
  saveUserInternalTaskModelSettings: vi.fn(),
}));

vi.mock("./runtime", () => runtime);

const catalog = {
  generatedAt: 1,
  providers: [
    {
      provider: "openai",
      available: true,
      models: [
        { id: "gpt-5.5", label: "GPT 5.5" },
        { id: "gpt-5.4-mini", label: "GPT 5.4 Mini" },
      ],
    },
    {
      provider: "anthropic",
      available: true,
      models: [{ id: "claude-sonnet-5", label: "Claude Sonnet 5" }],
    },
    {
      provider: "google",
      available: true,
      models: [{ id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" }],
    },
  ],
} satisfies ProviderModelCatalogSnapshot;

const availability = [
  { provider: "openai", configured: true },
  { provider: "anthropic", configured: true },
  { provider: "google", configured: false },
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  runtime.saveUserInternalTaskModelSettings.mockImplementation(
    async (settings) => settings,
  );
});

describe("internal task model selection", () => {
  it("lists models from every configured runtime provider", () => {
    expect(getInternalTaskProviderModels(availability, catalog)).toEqual([
      {
        provider: "openai",
        models: [
          { id: "gpt-5.5", label: "GPT 5.5" },
          { id: "gpt-5.4-mini", label: "GPT 5.4 Mini" },
        ],
      },
      {
        provider: "anthropic",
        models: [{ id: "claude-sonnet-5", label: "Claude Sonnet 5" }],
      },
    ]);
  });

  it("keeps a current saved selection", () => {
    expect(
      resolveInternalTaskModelSelection(
        {
          provider: "anthropic",
          model: "claude-sonnet-5",
          reasoning: "high",
        },
        availability,
        catalog,
      ),
    ).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5",
      reasoning: "high",
    });
  });

  it("replaces an unavailable model within the saved provider", () => {
    expect(
      resolveInternalTaskModelSelection(
        {
          provider: "anthropic",
          model: "removed-model",
          reasoning: "high",
        },
        availability,
        catalog,
      ),
    ).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5",
      reasoning: "high",
    });
  });

  it("replaces an unavailable provider with a configured selection", () => {
    expect(
      resolveInternalTaskModelSelection(
        {
          provider: "google",
          model: "gemini-3.5-flash",
          reasoning: "high",
        },
        availability,
        catalog,
      ),
    ).toEqual({
      provider: "openai",
      model: "gpt-5.5",
      reasoning: "high",
    });
  });

  it("preserves a saved selection when model discovery is unavailable", () => {
    expect(
      resolveInternalTaskModelSelection(
        {
          provider: "anthropic",
          model: "claude-saved-model",
          reasoning: "default",
        },
        availability,
        {
          ...catalog,
          providers: catalog.providers.map((entry) =>
            entry.provider === "anthropic"
              ? { ...entry, available: false, models: [] }
              : entry,
          ),
        },
      ),
    ).toEqual({
      provider: "anthropic",
      model: "claude-saved-model",
      reasoning: "default",
    });
  });

  it("returns no selection without a configured provider model", () => {
    expect(
      resolveInternalTaskModelSelection(
        { reasoning: "default" },
        availability.map((entry) => ({ ...entry, configured: false })),
        catalog,
      ),
    ).toBeNull();
  });

  it("preserves a configured CLI as the internal task provider", () => {
    const cliAvailability = [
      ...availability,
      { provider: "codex-cli" as const, configured: true },
    ];
    const cliCatalog = {
      ...catalog,
      providers: [
        ...catalog.providers,
        {
          provider: "codex-cli" as const,
          available: false,
          models: [],
        },
      ],
    };

    expect(
      resolveInternalTaskModelSelection(
        {
          provider: "codex-cli",
          model: "gpt-5.6-sol",
          reasoning: "xhigh",
        },
        cliAvailability,
        cliCatalog,
      ),
    ).toEqual({
      provider: "codex-cli",
      model: "gpt-5.6-sol",
      reasoning: "xhigh",
    });
  });

  it("runs internal tasks with the resolved provider and model", async () => {
    runtime.loadUserInternalTaskModelSettings.mockResolvedValue({
      provider: "anthropic",
      model: "claude-sonnet-5",
      reasoning: "high",
    });
    runtime.loadGlobalProviderAvailability.mockResolvedValue(availability);
    runtime.loadProviderModelCatalog.mockResolvedValue(catalog);
    runtime.runDesktopTask.mockResolvedValue({
      execution: { status: "executed" },
    });

    await runInternalDesktopTask("C:/workspace", "Inspect the workspace", {
      mode: "ask",
      taskId: "internal-task",
    });

    expect(runtime.runDesktopTask).toHaveBeenCalledWith(
      "C:/workspace",
      "Inspect the workspace",
      {
        mode: "ask",
        taskId: "internal-task",
        provider: "anthropic",
        model: "claude-sonnet-5",
        reasoning: "high",
      },
    );
  });

  it("normalizes unsupported saved reasoning before execution", async () => {
    runtime.loadUserInternalTaskModelSettings.mockResolvedValue({
      provider: "codex-cli",
      model: "gpt-5.6-terra",
      reasoning: "ultra",
    });
    runtime.loadGlobalProviderAvailability.mockResolvedValue([
      ...availability,
      { provider: "codex-cli", configured: true },
    ]);
    runtime.loadProviderModelCatalog.mockResolvedValue({
      ...catalog,
      providers: [
        ...catalog.providers,
        {
          provider: "codex-cli",
          available: false,
          models: [],
        },
      ],
    });
    runtime.runDesktopTask.mockResolvedValue({
      execution: { status: "executed" },
    });

    await runInternalDesktopTask("C:/workspace", "Enhance this prompt", {
      mode: "ask",
      taskId: "prompt-enhancement",
    });

    expect(runtime.runDesktopTask).toHaveBeenCalledWith(
      "C:/workspace",
      "Enhance this prompt",
      {
        mode: "ask",
        taskId: "prompt-enhancement",
        provider: "codex-cli",
        model: "gpt-5.6-terra",
        reasoning: "default",
      },
    );
    expect(runtime.saveUserInternalTaskModelSettings).toHaveBeenCalledWith({
      provider: "codex-cli",
      model: "gpt-5.6-terra",
      reasoning: "default",
    });
  });

  it("persists a corrected selection before executing through another wrapper", async () => {
    runtime.loadUserInternalTaskModelSettings.mockResolvedValue({
      provider: "anthropic",
      model: "removed-model",
      reasoning: "high",
    });
    runtime.loadGlobalProviderAvailability.mockResolvedValue(availability);
    runtime.loadProviderModelCatalog.mockResolvedValue(catalog);
    runtime.runTaskInterview.mockResolvedValue({ status: "questions" });

    await runInternalTaskInterview("C:/workspace", {
      prompt: "Clarify the task",
      mode: "ask",
      taskId: "interview-task",
      sessionId: "session-1",
    });

    expect(runtime.saveUserInternalTaskModelSettings).toHaveBeenCalledWith({
      provider: "anthropic",
      model: "claude-sonnet-5",
      reasoning: "high",
    });
    expect(runtime.runTaskInterview).toHaveBeenCalledWith("C:/workspace", {
      prompt: "Clarify the task",
      mode: "ask",
      taskId: "interview-task",
      sessionId: "session-1",
      provider: "anthropic",
      model: "claude-sonnet-5",
      reasoning: "high",
    });
  });

  it("routes Ralph clarification interviews through the internal selection", async () => {
    runtime.loadUserInternalTaskModelSettings.mockResolvedValue({
      provider: "anthropic",
      model: "claude-sonnet-5",
      reasoning: "low",
    });
    runtime.loadGlobalProviderAvailability.mockResolvedValue(availability);
    runtime.loadProviderModelCatalog.mockResolvedValue(catalog);
    runtime.runRalphGenerationInterview.mockResolvedValue({
      status: "questions",
    });

    await runInternalRalphGenerationInterview("C:/workspace", {
      prompt: "Create a release flow",
      scope: "workspace",
      taskId: "ralph-interview",
    });

    expect(runtime.runRalphGenerationInterview).toHaveBeenCalledWith(
      "C:/workspace",
      {
        prompt: "Create a release flow",
        scope: "workspace",
        taskId: "ralph-interview",
        provider: "anthropic",
        model: "claude-sonnet-5",
        reasoning: "low",
      },
    );
  });

  it("does not persist an unchanged saved selection", async () => {
    runtime.loadUserInternalTaskModelSettings.mockResolvedValue({
      provider: "anthropic",
      model: "claude-sonnet-5",
      reasoning: "high",
    });
    runtime.loadGlobalProviderAvailability.mockResolvedValue(availability);
    runtime.loadProviderModelCatalog.mockResolvedValue(catalog);

    await expect(loadInternalTaskModelSelection()).resolves.toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5",
      reasoning: "high",
    });
    expect(runtime.saveUserInternalTaskModelSettings).not.toHaveBeenCalled();
  });
});
