// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { ComposerModelPicker } from "@machdoch/product-ui";
import { createElement } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RUN_MODE_META } from "../_helpers/session-shell";
import { TooltipProvider } from "../../components/ui/tooltip";
import { SessionModePicker } from "./session-mode-picker";
import { SessionReasoningPicker } from "./session-reasoning-picker";

beforeAll(() => {
  class ResizeObserverMock {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
});

afterEach(() => cleanup());

describe("session picker popovers", () => {
  it("filters and selects a model from the shared picker", async () => {
    const onSelect = vi.fn();
    render(
      createElement(ComposerModelPicker, {
        providers: [
          {
            id: "openai",
            label: "OpenAI",
            available: true,
            models: [
              { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
              { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
            ],
          },
        ],
        activeProvider: "openai",
        activeProviderLabel: "OpenAI",
        activeModel: "gpt-5.6-sol",
        activeModelLabel: "GPT-5.6 Sol",
        loading: false,
        onSelect,
      }),
    );

    fireEvent.click(screen.getByLabelText("Session model: OpenAI GPT-5.6 Sol"));
    fireEvent.change(screen.getByLabelText("Search models"), {
      target: { value: "terra" },
    });
    fireEvent.click(screen.getByLabelText("Choose OpenAI GPT-5.6 Terra"));

    expect(onSelect).toHaveBeenCalledWith("openai", "gpt-5.6-terra");
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Session model" }),
      ).toBeNull(),
    );
  });

  it("closes after choosing a session mode", async () => {
    const onSelection = vi.fn();
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(SessionModePicker, {
          activeRunMode: "machdoch",
          activeRunModeMeta: RUN_MODE_META.machdoch,
          defaultRunMode: "machdoch",
          isUsingWorkspaceDefaultMode: true,
          onSessionModeSelection: onSelection,
        }),
      ),
    );

    fireEvent.click(screen.getByLabelText("Execution mode: Machdoch"));
    const askMode = await screen.findByLabelText("Choose Ask mode");
    fireEvent.click(askMode);

    expect(onSelection).toHaveBeenCalledWith("ask");
    await waitFor(() =>
      expect(screen.queryByLabelText("Choose Ask mode")).toBeNull(),
    );
  });

  it("closes after choosing a reasoning level", async () => {
    const onSelection = vi.fn();
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(SessionReasoningPicker, {
          provider: "codex-cli",
          model: "gpt-5.6-terra",
          activeReasoning: "max",
          defaultReasoning: "high",
          isUsingWorkspaceDefaultReasoning: false,
          onSessionReasoningSelection: onSelection,
        }),
      ),
    );

    fireEvent.click(screen.getByLabelText("Reasoning mode: Max"));
    const lowReasoning = await screen.findByLabelText("Choose Low reasoning");
    fireEvent.click(lowReasoning);

    expect(onSelection).toHaveBeenCalledWith("low");
    await waitFor(() =>
      expect(screen.queryByLabelText("Choose Low reasoning")).toBeNull(),
    );
  });
});
