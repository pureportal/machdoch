// @vitest-environment jsdom

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { QueuedMessagesPanel } from "@machdoch/client-ui/composer/queued-messages-panel";

afterEach(() => {
  cleanup();
});

describe("QueuedMessagesPanel", () => {
  it("shows execution order and actionable queue states", () => {
    const markup = renderToStaticMarkup(
      createElement(QueuedMessagesPanel, {
        messages: [
          {
            id: "next",
            content: "Run the next task.",
            attachments: [],
            status: "queued",
            createdAt: 1,
          },
          {
            id: "enhancing",
            content: "Improve this request.",
            attachments: [],
            status: "enhancing",
            promptEnhancementMode: "simple",
            createdAt: 2,
          },
          {
            id: "dispatching",
            content: "Dispatch this request.",
            attachments: [],
            status: "dispatching",
            createdAt: 3,
          },
          {
            id: "failed",
            content: "Retry this request.",
            attachments: [],
            status: "failed",
            failureMessage: "Enhancement failed.",
            createdAt: 4,
          },
        ],
        imageInputDisabled: false,
        imageInputDisabledReason: null,
        onMessageRetry: () => {},
      }),
    );

    expect(markup).toContain("Queue");
    expect(markup).toContain("Next");
    expect(markup).toContain("Enhancing");
    expect(markup).toContain("Dispatching");
    expect(markup).toContain("Failed");
    expect(markup).toContain("Enhancement failed.");
    expect(markup).toContain('aria-label="Retry queued message 4"');
  });

  it("locks queue mutations while an item is being dispatched", () => {
    render(
      createElement(QueuedMessagesPanel, {
        messages: [
          {
            id: "dispatching",
            content: "Send this request.",
            attachments: [
              {
                id: "attachment-1",
                source: "path",
                kind: "file",
                name: "notes.md",
                path: "C:\\workspace\\notes.md",
              },
            ],
            status: "dispatching",
            createdAt: 1,
          },
          {
            id: "queued",
            content: "Keep this order stable.",
            attachments: [],
            status: "queued",
            createdAt: 2,
          },
        ],
        imageInputDisabled: false,
        imageInputDisabledReason: null,
        onMessageChange: () => {},
        onMessageMove: () => {},
        onMessageReorder: () => {},
        onMessageRemove: () => {},
        onMessageSelectAttachments: async () => {},
        onMessageRemoveAttachment: () => {},
        onMessageClearAttachments: () => {},
      }),
    );

    expect(
      screen
        .getByRole("textbox", { name: "Queued message 1" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", {
          name: "Add attachments to queued message 1",
        })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Remove notes.md" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", {
          name: "Remove all attachments from queued message 1",
        })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Move queued message 2 up" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("offers reordering only when there is more than one message", () => {
    const message = {
      id: "only",
      content: "Send this request.",
      attachments: [],
      status: "queued" as const,
      createdAt: 1,
    };
    const singleMarkup = renderToStaticMarkup(
      createElement(QueuedMessagesPanel, {
        messages: [message],
        imageInputDisabled: false,
        imageInputDisabledReason: null,
      }),
    );
    const pairMarkup = renderToStaticMarkup(
      createElement(QueuedMessagesPanel, {
        messages: [message, { ...message, id: "second" }],
        imageInputDisabled: false,
        imageInputDisabledReason: null,
      }),
    );

    expect(singleMarkup).not.toContain("to reorder");
    expect(singleMarkup).not.toContain("Move queued message");
    expect(singleMarkup).toContain('aria-label="Remove queued message 1"');
    expect(pairMarkup).toContain('aria-label="Drag queued message 2 to reorder"');
    expect(pairMarkup).toContain('aria-label="Move queued message 2 up"');
  });

  it("keeps the next marker on an in-progress queue head", () => {
    const markup = renderToStaticMarkup(
      createElement(QueuedMessagesPanel, {
        messages: [
          {
            id: "enhancing",
            content: "Improve this request.",
            attachments: [],
            status: "enhancing",
            createdAt: 1,
          },
        ],
        imageInputDisabled: false,
        imageInputDisabledReason: null,
      }),
    );

    expect(markup).toContain("Next · Enhancing");
  });

  it("shows iteration order and a failed predecessor", () => {
    const markup = renderToStaticMarkup(
      createElement(QueuedMessagesPanel, {
        messages: [
          {
            id: "first",
            content: "Improve the UI",
            iteration: { groupId: "group", index: 1, total: 3 },
            attachments: [],
            status: "failed",
            createdAt: 1,
          },
          {
            id: "second",
            content: "Continue",
            iteration: { groupId: "group", index: 2, total: 3 },
            waitingForIteration: 1,
            attachments: [],
            status: "queued",
            createdAt: 2,
          },
        ],
        imageInputDisabled: false,
        imageInputDisabledReason: null,
      }),
    );
    expect(markup).toContain("Iteration 1 of 3");
    expect(markup).toContain("Iteration 2 of 3");
    expect(markup).toContain("Waiting for iteration 1");
    expect(markup).not.toContain("Next · Failed");
    expect(markup).not.toContain('aria-label="Move queued message 2 up"');
  });

  it("moves an iteration group as one unit", () => {
    const onMessageMove = vi.fn();
    const message = {
      content: "Improve the UI",
      attachments: [],
      status: "queued" as const,
      createdAt: 1,
    };

    render(
      createElement(QueuedMessagesPanel, {
        messages: [
          { ...message, id: "single" },
          {
            ...message,
            id: "first",
            iteration: { groupId: "group", index: 1, total: 2 },
          },
          {
            ...message,
            id: "second",
            iteration: { groupId: "group", index: 2, total: 2 },
            waitingForIteration: 1,
          },
        ],
        imageInputDisabled: false,
        imageInputDisabledReason: null,
        onMessageMove,
      }),
    );

    const moveButton = (name: string): HTMLButtonElement =>
      screen.getByRole<HTMLButtonElement>("button", { name });

    expect(moveButton("Move queued message 2 down").disabled).toBe(true);
    expect(moveButton("Move queued message 3 down").disabled).toBe(true);
    expect(
      moveButton("Drag queued message 3 to reorder").getAttribute("draggable"),
    ).toBe("true");

    fireEvent.click(moveButton("Move queued message 3 up"));

    expect(onMessageMove).toHaveBeenCalledWith("second", -1);
  });

  it("drags an iteration group and highlights every row in the drop target", () => {
    const onMessageReorder = vi.fn();
    const message = {
      content: "Improve the UI",
      attachments: [],
      status: "queued" as const,
      createdAt: 1,
    };

    render(
      createElement(QueuedMessagesPanel, {
        messages: [
          {
            ...message,
            id: "first",
            iteration: { groupId: "group", index: 1, total: 2 },
          },
          {
            ...message,
            id: "second",
            iteration: { groupId: "group", index: 2, total: 2 },
            waitingForIteration: 1,
          },
          { ...message, id: "single" },
        ],
        imageInputDisabled: false,
        imageInputDisabledReason: null,
        onMessageReorder,
      }),
    );

    const row = (position: number): HTMLElement =>
      screen.getByRole("listitem", {
        name: `Queued message ${position} of 3`,
      });
    const dataTransfer = {
      effectAllowed: "",
      dropEffect: "",
      setData: vi.fn(),
      getData: vi.fn(() => ""),
    };

    fireEvent.dragStart(
      screen.getByRole("button", { name: "Drag queued message 3 to reorder" }),
      { dataTransfer },
    );
    fireEvent.dragEnter(row(2), { dataTransfer });

    expect(row(1).className).toContain("border-sky-300/60");
    expect(row(2).className).toContain("border-sky-300/60");
    expect(row(3).className).toContain("opacity-70");

    fireEvent.drop(row(1), { dataTransfer });

    expect(onMessageReorder).toHaveBeenCalledWith("single", 0);
  });

  it("hides reorder controls when one iteration group fills the queue", () => {
    const message = {
      content: "Improve the UI",
      attachments: [],
      status: "queued" as const,
      createdAt: 1,
    };

    const markup = renderToStaticMarkup(
      createElement(QueuedMessagesPanel, {
        messages: [
          {
            ...message,
            id: "first",
            iteration: { groupId: "group", index: 1, total: 2 },
          },
          {
            ...message,
            id: "second",
            iteration: { groupId: "group", index: 2, total: 2 },
          },
        ],
        imageInputDisabled: false,
        imageInputDisabledReason: null,
      }),
    );

    expect(markup).not.toContain("to reorder");
    expect(markup).not.toContain("Move queued message");
  });
});
