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
        { provider: "anthropic", model: "claude-sonnet-5" },
        availability,
        catalog,
      ),
    ).toEqual({ provider: "anthropic", model: "claude-sonnet-5" });
  });

  it("replaces an unavailable model within the saved provider", () => {
    expect(
      resolveInternalTaskModelSelection(
        { provider: "anthropic", model: "removed-model" },
        availability,
        catalog,
      ),
    ).toEqual({ provider: "anthropic", model: "claude-sonnet-5" });
  });

  it("replaces an unavailable provider with a configured selection", () => {
    expect(
      resolveInternalTaskModelSelection(
        { provider: "google", model: "gemini-3.5-flash" },
        availability,
        catalog,
      ),
    ).toEqual({ provider: "openai", model: "gpt-5.5" });
  });

  it("preserves a saved selection when model discovery is unavailable", () => {
    expect(
      resolveInternalTaskModelSelection(
        { provider: "anthropic", model: "claude-saved-model" },
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
    ).toEqual({ provider: "anthropic", model: "claude-saved-model" });
  });

  it("returns no selection without a configured provider model", () => {
    expect(
      resolveInternalTaskModelSelection(
        {},
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
        { provider: "codex-cli", model: "gpt-5.6-sol" },
        cliAvailability,
        cliCatalog,
      ),
    ).toEqual({ provider: "codex-cli", model: "gpt-5.6-sol" });
  });

  it("runs internal tasks with the resolved provider and model", async () => {
    runtime.loadUserInternalTaskModelSettings.mockResolvedValue({
      provider: "anthropic",
      model: "claude-sonnet-5",
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
      },
    );
  });

  it("persists a corrected selection before executing through another wrapper", async () => {
    runtime.loadUserInternalTaskModelSettings.mockResolvedValue({
      provider: "anthropic",
      model: "removed-model",
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
    });
    expect(runtime.runTaskInterview).toHaveBeenCalledWith("C:/workspace", {
      prompt: "Clarify the task",
      mode: "ask",
      taskId: "interview-task",
      sessionId: "session-1",
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
  });

  it("routes Ralph clarification interviews through the internal selection", async () => {
    runtime.loadUserInternalTaskModelSettings.mockResolvedValue({
      provider: "anthropic",
      model: "claude-sonnet-5",
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
      },
    );
  });

  it("does not persist an unchanged saved selection", async () => {
    runtime.loadUserInternalTaskModelSettings.mockResolvedValue({
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    runtime.loadGlobalProviderAvailability.mockResolvedValue(availability);
    runtime.loadProviderModelCatalog.mockResolvedValue(catalog);

    await expect(loadInternalTaskModelSelection()).resolves.toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    expect(runtime.saveUserInternalTaskModelSettings).not.toHaveBeenCalled();
  });
});
