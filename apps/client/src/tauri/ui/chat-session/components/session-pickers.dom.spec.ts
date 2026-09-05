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
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "../../components/ui/dialog";
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
  it("portals out of clipped containers and preserves focus inside a parent dialog", async () => {
    const onSelect = vi.fn();
    render(
      createElement(
        Dialog,
        { defaultOpen: true },
        createElement(
          DialogContent,
          null,
          createElement(DialogTitle, null, "Parent settings"),
          createElement(DialogDescription, null, "Model settings"),
          createElement(
            "div",
            {
              "data-testid": "clipped",
              style: { overflow: "hidden", width: 100 },
            },
            createElement(ComposerModelPicker, {
              providers: [
                {
                  id: "test",
                  label: "Test",
                  available: true,
                  models: [{ id: "model", label: "Model" }],
                },
              ],
              activeProvider: "test",
              activeProviderLabel: "Test",
              activeModel: "model",
              activeModelLabel: "Model",
              loading: false,
              onSelect,
            }),
          ),
        ),
      ),
    );
    const trigger = screen.getByLabelText("Session model: Test Model");
    fireEvent.click(trigger);
    const search = await screen.findByLabelText("Search models");
    await waitFor(() => expect(document.activeElement).toBe(search));
    expect(screen.getByTestId("clipped").contains(search)).toBe(false);
    fireEvent.change(search, { target: { value: "Model" } });
    fireEvent.click(screen.getByLabelText("Choose Test Model"));
    expect(onSelect).toHaveBeenCalledWith("test", "model");
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Session model" }),
      ).toBeNull(),
    );
    expect(
      screen.getByRole("dialog", { name: "Parent settings" }),
    ).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

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

  it("does not expose stale models for an unavailable provider", () => {
    render(
      createElement(ComposerModelPicker, {
        providers: [
          {
            id: "openai",
            label: "OpenAI",
            available: false,
            error: "Not configured",
            models: [{ id: "gpt-5.6", label: "GPT-5.6" }],
          },
        ],
        activeProvider: "openai",
        activeProviderLabel: "OpenAI",
        activeModel: "gpt-5.6",
        activeModelLabel: "GPT-5.6",
        loading: false,
        onSelect: vi.fn(),
      }),
    );

    fireEvent.click(screen.getByLabelText("Session model: OpenAI GPT-5.6"));

    expect(screen.getByText("Not configured")).toBeTruthy();
    expect(screen.queryByLabelText("Choose OpenAI GPT-5.6")).toBeNull();
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
