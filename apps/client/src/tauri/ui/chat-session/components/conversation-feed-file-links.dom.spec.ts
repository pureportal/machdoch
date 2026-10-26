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
  expect(latestOpen).toHaveBeenCalledWith(path, undefined, false);
  fireEvent.click(link, { ctrlKey: true });
  expect(latestOpen).toHaveBeenLastCalledWith(path, undefined, true);
  expect(firstOpen).not.toHaveBeenCalled();
  expect(onOpenWorkspaceFile).not.toHaveBeenCalled();
});

it("opens relative chat links with their message workspace and external modifier", () => {
  const onOpenWorkspaceFile = vi.fn();
  render(
    createElement(ConversationFeed, {
      visibleMessages: [
        { id: "reply", role: "agent", content: "[Chart](images/chart.png)" },
      ],
      workspaceRoot: "C:/Project",
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
    }),
  );
  const link = screen.getByRole("button", { name: "Chart" });
  fireEvent.click(link);
  expect(onOpenWorkspaceFile).toHaveBeenLastCalledWith(
    "images/chart.png",
    undefined,
    "C:/Project",
    false,
  );
  fireEvent.click(link, { ctrlKey: true });
  expect(onOpenWorkspaceFile).toHaveBeenLastCalledWith(
    "images/chart.png",
    undefined,
    "C:/Project",
    true,
  );
});
