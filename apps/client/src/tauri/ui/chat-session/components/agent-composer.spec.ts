// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentComposer,
  type AgentComposerProps,
} from "@machdoch/client-ui/composer/agent-composer";

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
  modelPicker: null,
  contextAttachments: [],
  imageInputSupported: true,
  imageInputDisabledReason: null,
  canSend: true,
  sendDisabledReason: null,
  isExecuting: false,
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

describe("AgentComposer queue", () => {
  const queuedMessage = (
    id: string,
    content: string,
    status: "queued" | "failed" = "queued",
  ) => ({ id, content, attachments: [], status, createdAt: 1 });

  it("summarises the queue and edits it in a dialog", () => {
    const onQueuedMessageChange = vi.fn();
    const view = render(
      createElement(
        AgentComposer,
        createProps({
          isExecuting: true,
          onQueuedMessageChange,
          queuedMessages: [
            queuedMessage("first", "## Commit & Push\n\nDetails"),
            queuedMessage("second", "Open a pull request"),
          ],
        }),
      ),
    );

    expect(screen.getByText("Commit & Push")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Queued message 1" })).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Open queue: 2 queued messages" }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Queued message 2" }), {
      target: { value: "Ship it" },
    });
    expect(onQueuedMessageChange).toHaveBeenCalledWith("second", "Ship it");

    view.rerender(
      createElement(AgentComposer, createProps({ isExecuting: true })),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: /Open queue/u })).toBeNull();
  });

  it("shows failed queued messages without opening the queue", () => {
    render(
      createElement(
        AgentComposer,
        createProps({
          queuedMessages: [queuedMessage("failed", "Retry me", "failed")],
        }),
      ),
    );

    expect(screen.getByText("1 failed")).toBeTruthy();
    expect(screen.queryByText("Running")).toBeNull();
  });
});
