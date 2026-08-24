// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InternalTaskModelSettingsPanel } from "./internal-task-model-settings-panel";

const runtime = vi.hoisted(() => ({
  loadGlobalProviderAvailability: vi.fn(),
  loadProviderModelCatalog: vi.fn(),
  loadUserInternalTaskModelSettings: vi.fn(),
  runDesktopTask: vi.fn(),
  saveUserInternalTaskModelSettings: vi.fn(),
}));

vi.mock("../../../runtime", () => runtime);

beforeEach(() => {
  vi.clearAllMocks();
  runtime.loadUserInternalTaskModelSettings.mockResolvedValue({
    provider: "openai",
    model: "gpt-5.5",
    reasoning: "high",
  });
  runtime.loadProviderModelCatalog.mockResolvedValue({
    generatedAt: 1,
    providers: [
      {
        provider: "openai",
        available: true,
        models: [{ id: "gpt-5.5", label: "GPT 5.5" }],
      },
      {
        provider: "codex-cli",
        available: true,
        models: [{ id: "gpt-5.5", label: "GPT 5.5" }],
      },
      {
        provider: "anthropic",
        available: true,
        models: [{ id: "claude-sonnet-5", label: "Claude Sonnet 5" }],
      },
    ],
  });
  runtime.saveUserInternalTaskModelSettings.mockImplementation(
    async (settings) => settings,
  );
});

afterEach(() => cleanup());

describe("InternalTaskModelSettingsPanel", () => {
  it("selects models from configured API and CLI providers", async () => {
    render(
      createElement(InternalTaskModelSettingsPanel, {
        providerAvailability: [
          { provider: "openai", configured: true },
          { provider: "codex-cli", configured: true },
          { provider: "anthropic", configured: true },
        ],
      }),
    );

    const provider = await screen.findByLabelText("Internal task provider");
    expect(
      within(provider).getByRole("option", { name: "OpenAI" }),
    ).toBeTruthy();
    expect(
      within(provider).getByRole("option", { name: "Anthropic" }),
    ).toBeTruthy();
    expect(
      within(provider).getByRole("option", { name: "Codex CLI" }),
    ).toBeTruthy();

    fireEvent.change(provider, { target: { value: "anthropic" } });

    await waitFor(() =>
      expect(runtime.saveUserInternalTaskModelSettings).toHaveBeenCalledWith({
        provider: "anthropic",
        model: "claude-sonnet-5",
        reasoning: "high",
      }),
    );
    expect(
      (screen.getByLabelText("Internal task model") as HTMLSelectElement).value,
    ).toBe("claude-sonnet-5");
  });

  it("persists the selected internal-task reasoning", async () => {
    render(
      createElement(InternalTaskModelSettingsPanel, {
        providerAvailability: [
          { provider: "openai", configured: true },
          { provider: "codex-cli", configured: true },
          { provider: "anthropic", configured: true },
        ],
      }),
    );

    const reasoning = await screen.findByLabelText("Internal task reasoning");
    expect((reasoning as HTMLSelectElement).value).toBe("high");

    fireEvent.change(reasoning, { target: { value: "low" } });

    await waitFor(() =>
      expect(runtime.saveUserInternalTaskModelSettings).toHaveBeenCalledWith({
        provider: "openai",
        model: "gpt-5.5",
        reasoning: "low",
      }),
    );
  });
});
