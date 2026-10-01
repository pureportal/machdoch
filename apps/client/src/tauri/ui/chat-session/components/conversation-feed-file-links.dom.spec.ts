// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ConversationFeed } from "./conversation-feed";

afterEach(cleanup);

it("opens preview links from existing agent replies with the current file handler", () => {
  const path =
    "C:/Users/ehrha/AppData/Local/Temp/machdoch-goal-ui-review/final-composer-desktop.png";
  const firstOpen = vi.fn();
  const latestOpen = vi.fn();
  const onOpenWorkspaceFile = vi.fn();
  const props = {
    visibleMessages: [
      {
        id: "agent-result",
        role: "agent" as const,
        content: `Moved goal entry into a rounded inner field within the chat composer.\n\n[View preview](${path})`,
      },
    ],
    workspaceRoot: "C:\\Development\\machdoch",
    bottomRef: { current: null },
    onRetryTask: vi.fn(),
    onContinueTask: vi.fn(),
    onOpenWorkspaceFile,
    voicePlayback: {
      supported: false,
      speakingMessageId: null,
      onSpeakMessage: vi.fn(),
      onStopSpeaking: vi.fn(),
    },
  };

  const { rerender } = render(
    createElement(ConversationFeed, { ...props, onOpenLocalFile: firstOpen }),
  );
  const link = screen.getByRole("button", { name: "View preview" });
  expect(firstOpen).not.toHaveBeenCalled();
  rerender(
    createElement(ConversationFeed, { ...props, onOpenLocalFile: latestOpen }),
  );
  expect(screen.getByRole("button", { name: "View preview" })).toBe(link);
  fireEvent.click(link);
  expect(latestOpen).toHaveBeenCalledWith(path, undefined);
  expect(firstOpen).not.toHaveBeenCalled();
  expect(onOpenWorkspaceFile).not.toHaveBeenCalled();
});
