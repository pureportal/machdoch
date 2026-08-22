// @vitest-environment jsdom

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach } from "vitest";
import { QueuedMessagesPanel } from "./queued-messages-panel";

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
            canSendNow: false,
            createdAt: 1,
          },
          {
            id: "enhancing",
            content: "Improve this request.",
            attachments: [],
            status: "enhancing",
            promptEnhancementMode: "simple",
            canSendNow: false,
            createdAt: 2,
          },
          {
            id: "dispatching",
            content: "Dispatch this request.",
            attachments: [],
            status: "dispatching",
            canSendNow: false,
            createdAt: 3,
          },
          {
            id: "failed",
            content: "Retry this request.",
            attachments: [],
            status: "failed",
            failureMessage: "Enhancement failed.",
            canSendNow: false,
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
            canSendNow: false,
            createdAt: 1,
          },
          {
            id: "queued",
            content: "Keep this order stable.",
            attachments: [],
            status: "queued",
            canSendNow: false,
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

  it("keeps the next marker on an in-progress queue head", () => {
    const markup = renderToStaticMarkup(
      createElement(QueuedMessagesPanel, {
        messages: [
          {
            id: "enhancing",
            content: "Improve this request.",
            attachments: [],
            status: "enhancing",
            canSendNow: false,
            createdAt: 1,
          },
        ],
        imageInputDisabled: false,
        imageInputDisabledReason: null,
      }),
    );

    expect(markup).toContain("Next · Enhancing");
  });
});
