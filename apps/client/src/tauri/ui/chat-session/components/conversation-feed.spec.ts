import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatSessionMessage } from "../../chat-session.model";
import { ConversationFeed } from "./conversation-feed";

const noop = (): void => {};

const renderFeed = (messages: ChatSessionMessage[], overrides = {}): string =>
  renderToStaticMarkup(
    createElement(ConversationFeed, {
      visibleMessages: messages,
      bottomRef: createRef<HTMLDivElement>(),
      onRetryTask: noop,
      onContinueTask: noop,
      onOpenWorkspaceFile: noop,
      voicePlayback: {
        supported: false,
        speakingMessageId: null,
        onSpeakMessage: noop,
        onStopSpeaking: noop,
      },
      ...overrides,
    }),
  );

describe("ConversationFeed message states", () => {
  it("selects the edited message and dims the remaining conversation", () => {
    const markup = renderFeed(
      [
        {
          id: "editing-message",
          role: "user",
          content: "Update the release notes.",
        },
        {
          id: "other-message",
          role: "user",
          content: "Keep this message visible but secondary.",
        },
      ],
      {
        activeEditingMessageId: "editing-message",
        editingPromptEnhancement: { messageId: "editing-message" },
        onCancelPromptEnhancement: noop,
      },
    );

    expect(markup).toContain("Editing");
    expect(markup).toContain("Enhancing prompt");
    expect(markup).toContain("opacity-40");
    expect(markup).toContain('aria-label="Cancel enhancement"');
  });

  it("renders an in-conversation enhancement bubble for a new request", () => {
    const markup = renderFeed([
      {
        id: "prompt-enhancement-user",
        taskId: "prompt-enhancement-1",
        role: "user",
        content: "Turn this into a release checklist.",
        lifecycle: {
          kind: "transient",
          owner: "prompt-enhancement",
          operationId: "prompt-enhancement-1",
          slot: "user",
          ownerLaunchId: "launch-1",
          ownerWindowId: "window-1",
          ownerInstanceId: "instance-1",
          placement: "message",
        },
      },
    ]);

    expect(markup).toContain("Turn this into a release checklist.");
    expect(markup).toContain("Enhancing prompt");
  });
});
