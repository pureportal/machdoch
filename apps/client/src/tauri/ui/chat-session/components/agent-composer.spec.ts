// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentComposer, type AgentComposerProps } from "./agent-composer";

const noop = (): void => {};
const noopAsync = async (): Promise<void> => {};

const createProps = (
  overrides: Partial<AgentComposerProps> = {},
): AgentComposerProps => ({
  variant: "session",
  draftIdentity: "session-1",
  draft: "",
  draftRevision: 100,
  textareaLabel: "Task composer",
  placeholder: "What should machdoch do next?",
  chooserProviders: ["openai"],
  activeProvider: "openai",
  activeModel: "gpt-5.4",
  contextAttachments: [],
  imageInputSupported: true,
  imageInputDisabledReason: null,
  canSend: true,
  sendDisabledReason: null,
  isExecuting: false,
  onModelSelection: noop,
  onSelectContextFiles: noopAsync,
  onSelectContextFolders: noopAsync,
  onSelectContextImages: noopAsync,
  onPasteContextImages: noopAsync,
  onRemoveContextAttachment: noop,
  onClearContextAttachments: noop,
  onDraftChange: noop,
  onSend: noop,
  onCancel: noop,
  ...overrides,
});

afterEach(() => {
  cleanup();
});

describe("AgentComposer draft reconciliation", () => {
  it("applies a revised empty draft after typing and clearing are batched", () => {
    const onDraftChange = vi.fn();
    const view = render(
      createElement(AgentComposer, createProps({ onDraftChange })),
    );
    const textarea = screen.getByRole("textbox", { name: "Task composer" });

    fireEvent.change(textarea, { target: { value: "Submitted request" } });

    expect((textarea as HTMLTextAreaElement).value).toBe("Submitted request");
    expect(onDraftChange).toHaveBeenCalledWith("Submitted request");

    view.rerender(
      createElement(
        AgentComposer,
        createProps({
          draft: "",
          draftRevision: 300,
          onDraftChange,
        }),
      ),
    );

    expect((textarea as HTMLTextAreaElement).value).toBe("");
  });

  it("keeps local input when an unchanged parent render is still pending", () => {
    const view = render(createElement(AgentComposer, createProps()));
    const textarea = screen.getByRole("textbox", { name: "Task composer" });

    fireEvent.change(textarea, { target: { value: "Pending request" } });
    view.rerender(createElement(AgentComposer, createProps()));

    expect((textarea as HTMLTextAreaElement).value).toBe("Pending request");
  });
});
