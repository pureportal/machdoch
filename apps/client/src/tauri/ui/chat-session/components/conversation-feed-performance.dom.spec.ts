// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatSessionContextAttachment } from "@machdoch/client-ui/composer/model";
import { ConversationFeed } from "./conversation-feed";

const markdownRendered = vi.hoisted(() => vi.fn());

vi.mock("@machdoch/client-ui/conversation/markdown-content", () => ({
  MarkdownContent: ({
    onOpenWorkspaceFile,
  }: {
    onOpenWorkspaceFile: (path: string) => void;
  }) => {
    markdownRendered();
    return createElement(
      "button",
      { type: "button", onClick: () => onOpenWorkspaceFile("README.md") },
      "Open file",
    );
  },
}));

afterEach(() => {
  cleanup();
  markdownRendered.mockClear();
});

it("keeps unchanged message rows mounted while using the latest file handler", () => {
  const messages = [
    { id: "message-1", role: "agent" as const, content: "Answer" },
  ];
  const onRetryTask = vi.fn();
  const onContinueTask = vi.fn();
  const voicePlayback = {
    supported: false,
    speakingMessageId: null,
    onSpeakMessage: vi.fn(),
    onStopSpeaking: vi.fn(),
  };
  const firstOpen = vi.fn();
  const latestOpen = vi.fn();
  const props = {
    visibleMessages: messages,
    workspaceRoot: "workspace-1",
    bottomRef: { current: null },
    onRetryTask,
    onContinueTask,
    voicePlayback,
  };

  const { rerender } = render(
    createElement(ConversationFeed, {
      ...props,
      onOpenWorkspaceFile: firstOpen,
    }),
  );
  expect(markdownRendered).toHaveBeenCalledTimes(1);

  rerender(
    createElement(ConversationFeed, {
      ...props,
      onOpenWorkspaceFile: latestOpen,
    }),
  );
  expect(markdownRendered).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole("button", { name: "Open file" }));
  expect(firstOpen).not.toHaveBeenCalled();
  expect(latestOpen).toHaveBeenCalledWith(
    "README.md",
    undefined,
    "workspace-1",
  );
});

it("opens attachments with the current handler and message workspace", () => {
  const attachment: ChatSessionContextAttachment = {
    id: "attachment-1",
    source: "path",
    kind: "file",
    name: "notes.txt",
    path: "notes.txt",
  };
  const messages = [
    {
      id: "message-1",
      role: "user" as const,
      content: "See attachment",
      settings: {
        workspace: "original-workspace",
        provider: "openai" as const,
        model: "test-model",
        parallelAgentMode: "disabled" as const,
        sessionMemoryEnabled: false,
        useWorkspaceMemory: false,
        useGlobalMemory: false,
        uiControlEnabled: false,
        promptEnhancementMode: "off" as const,
        interviewEnabled: false,
      },
      contextAttachments: [attachment],
    },
  ];
  const firstOpen = vi.fn();
  const latestOpen = vi.fn();
  const props = {
    visibleMessages: messages,
    workspaceRoot: "current-workspace",
    bottomRef: { current: null },
    onRetryTask: vi.fn(),
    onContinueTask: vi.fn(),
    onOpenWorkspaceFile: vi.fn(),
    voicePlayback: {
      supported: false,
      speakingMessageId: null,
      onSpeakMessage: vi.fn(),
      onStopSpeaking: vi.fn(),
    },
  };

  const { rerender } = render(
    createElement(ConversationFeed, { ...props, onOpenAttachment: firstOpen }),
  );
  rerender(
    createElement(ConversationFeed, { ...props, onOpenAttachment: latestOpen }),
  );

  fireEvent.click(screen.getByRole("button", { name: "Show file notes.txt" }));
  expect(firstOpen).not.toHaveBeenCalled();
  expect(latestOpen).toHaveBeenCalledWith(attachment, "original-workspace");
});
