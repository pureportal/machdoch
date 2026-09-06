// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSessionMessage } from "../../chat-session.model";
import { createPreviewFixture } from "../../preview/fixtures";
import { createInitialThinkingTrace } from "../../task-thinking.model";
import {
  ConversationFeed,
  type ConversationFeedProps,
} from "./conversation-feed";

const enhancementLifecycle = {
  kind: "transient",
  owner: "prompt-enhancement",
  operationId: "prompt-enhancement-1",
  ownerLaunchId: "launch-1",
  ownerWindowId: "window-1",
  ownerInstanceId: "instance-1",
  placement: "message",
} as const;

const enhancingUserMessage: ChatSessionMessage = {
  id: "prompt-enhancement-user",
  taskId: enhancementLifecycle.operationId,
  role: "user",
  content: "Investigate and fix the problem.",
  contextAttachments: [
    {
      id: "screenshot",
      source: "path",
      kind: "image",
      name: "screenshot.png",
      path: "C:\\workspace\\screenshot.png",
    },
  ],
  lifecycle: { ...enhancementLifecycle, slot: "user" },
};

const enhancementActivity: ChatSessionMessage = {
  id: "prompt-enhancement-thinking",
  taskId: enhancementLifecycle.operationId,
  role: "agent",
  content: "",
  lifecycle: { ...enhancementLifecycle, slot: "thinking" },
  source: { kind: "thinking", thinking: createInitialThinkingTrace("ask", 1) },
};

const firstUserMessage: ChatSessionMessage = {
  id: "first-user",
  role: "user",
  content: "Review the application.",
};

const agentResponse: ChatSessionMessage = {
  id: "agent-response",
  role: "agent",
  content: "The review is complete.",
};

const feedElement = (
  visibleMessages: ChatSessionMessage[],
  overrides: Partial<ConversationFeedProps> = {},
) =>
  createElement(ConversationFeed, {
    visibleMessages,
    bottomRef: createRef<HTMLDivElement>(),
    onRetryTask: vi.fn(),
    onContinueTask: vi.fn(),
    onOpenWorkspaceFile: vi.fn(),
    voicePlayback: {
      supported: false,
      speakingMessageId: null,
      onSpeakMessage: vi.fn(),
      onStopSpeaking: vi.fn(),
    },
    ...overrides,
  });

const scrollIntoView = vi.fn();

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
  scrollIntoView.mockClear();
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

const expectNavigation = (
  container: HTMLElement,
  position: number,
  total: number,
  messageId: string,
): void => {
  expect(
    screen.getByRole("status", { name: `Message ${position} of ${total}` })
      .textContent,
  ).toBe(`${position} / ${total}`);
  expect(
    screen
      .getByRole("button", { name: "Previous message" })
      .hasAttribute("disabled"),
  ).toBe(position === 1);
  expect(
    screen
      .getByRole("button", { name: "Next message" })
      .hasAttribute("disabled"),
  ).toBe(position === total);
  expect(
    container
      .querySelector('[data-message-id][aria-current="true"]')
      ?.getAttribute("data-message-id"),
  ).toBe(messageId);
};

const expectHighlightedMessage = (
  container: HTMLElement,
  messageId: string,
): void => {
  const highlightedMessages = container.querySelectorAll(
    ".app-message-container--navigation-highlight",
  );
  expect(highlightedMessages).toHaveLength(1);
  expect(highlightedMessages[0]?.getAttribute("data-message-id")).toBe(
    messageId,
  );
  expect(scrollIntoView.mock.contexts.at(-1)).toBe(highlightedMessages[0]);
  expect(scrollIntoView).toHaveBeenLastCalledWith({
    behavior: "smooth",
    block: "center",
    inline: "nearest",
  });
};

describe("ConversationFeed message navigation", () => {
  it("counts a prompt being enhanced once with no empty next destination", () => {
    const { container } = render(
      feedElement([enhancingUserMessage, enhancementActivity]),
    );

    expect(screen.getAllByText("Enhancing prompt")).toHaveLength(1);
    expect(screen.getByText("screenshot.png")).toBeTruthy();
    expect(container.querySelectorAll("[data-message-id]")).toHaveLength(1);
    expectNavigation(container, 1, 1, enhancingUserMessage.id);

    fireEvent.click(screen.getByRole("button", { name: "Next message" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous message" }));

    expectNavigation(container, 1, 1, enhancingUserMessage.id);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("highlights the correct messages in both directions around enhancement activity", () => {
    const { container } = render(
      feedElement([
        firstUserMessage,
        {
          id: "preview",
          role: "agent",
          content: "",
          source: {
            kind: "preview",
            preview: createPreviewFixture("Review the application."),
          },
        },
        agentResponse,
        enhancingUserMessage,
        enhancementActivity,
      ]),
    );

    expect(container.querySelectorAll("[data-message-id]")).toHaveLength(3);
    expectNavigation(container, 3, 3, enhancingUserMessage.id);

    for (const [position, message] of [
      [2, agentResponse],
      [1, firstUserMessage],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name: "Previous message" }));
      expectNavigation(container, position, 3, message.id);
      expectHighlightedMessage(container, message.id);
    }

    for (const [position, message] of [
      [2, agentResponse],
      [3, enhancingUserMessage],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name: "Next message" }));
      expectNavigation(container, position, 3, message.id);
      expectHighlightedMessage(container, message.id);
    }

    expect(scrollIntoView).toHaveBeenCalledTimes(4);
  });

  it("keeps normal task activity navigable", () => {
    const thinkingMessage: ChatSessionMessage = {
      id: "agent-thinking",
      role: "agent",
      content: "",
      source: {
        kind: "thinking",
        thinking: createInitialThinkingTrace("ask", 1),
      },
    };
    const { container } = render(
      feedElement([firstUserMessage, thinkingMessage]),
    );

    expectNavigation(container, 2, 2, thinkingMessage.id);
    fireEvent.click(screen.getByRole("button", { name: "Previous message" }));
    expectNavigation(container, 1, 2, firstUserMessage.id);
    expectHighlightedMessage(container, firstUserMessage.id);

    fireEvent.click(screen.getByRole("button", { name: "Next message" }));
    expectNavigation(container, 2, 2, thinkingMessage.id);
    expectHighlightedMessage(container, thinkingMessage.id);
  });

  it("keeps edit enhancement attached to the original message", () => {
    const { container } = render(
      feedElement(
        [
          firstUserMessage,
          agentResponse,
          {
            ...enhancementActivity,
            lifecycle: {
              ...enhancementLifecycle,
              slot: "marker",
              placement: "edit-composer",
              targetMessageId: firstUserMessage.id,
            },
          },
        ],
        {
          activeEditingMessageId: firstUserMessage.id,
          editingPromptEnhancement: { messageId: firstUserMessage.id },
        },
      ),
    );

    expect(screen.getAllByText("Enhancing prompt")).toHaveLength(1);
    expect(container.querySelectorAll("[data-message-id]")).toHaveLength(2);
    expectNavigation(container, 2, 2, agentResponse.id);

    fireEvent.click(screen.getByRole("button", { name: "Previous message" }));
    expectNavigation(container, 1, 2, firstUserMessage.id);
    expectHighlightedMessage(container, firstUserMessage.id);

    fireEvent.click(screen.getByRole("button", { name: "Next message" }));
    expectNavigation(container, 2, 2, agentResponse.id);
    expectHighlightedMessage(container, agentResponse.id);
  });

  it("updates the count and destinations when enhancement finishes", () => {
    const { container, rerender } = render(
      feedElement([enhancingUserMessage, enhancementActivity]),
    );
    expectNavigation(container, 1, 1, enhancingUserMessage.id);

    const completedUserMessage: ChatSessionMessage = {
      id: "enhanced-user",
      role: "user",
      content: "Investigate the application and fix the reported problem.",
      promptEnhancement: { originalContent: enhancingUserMessage.content },
    };
    rerender(feedElement([completedUserMessage, agentResponse]));

    expect(screen.queryByText("Enhancing prompt")).toBeNull();
    expectNavigation(container, 2, 2, agentResponse.id);
    fireEvent.click(screen.getByRole("button", { name: "Previous message" }));
    expectNavigation(container, 1, 2, completedUserMessage.id);
    expectHighlightedMessage(container, completedUserMessage.id);

    fireEvent.click(screen.getByRole("button", { name: "Next message" }));
    expectNavigation(container, 2, 2, agentResponse.id);
    expectHighlightedMessage(container, agentResponse.id);
  });
});
