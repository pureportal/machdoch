// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { createElement, useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationFeed } from "./conversation-feed";

const openedFiles = vi.fn();

function IdleChat(): React.ReactElement {
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const interval = window.setInterval(
      () => setRefresh((value) => value + 1),
      3_000,
    );
    return () => window.clearInterval(interval);
  }, []);

  return createElement(ConversationFeed, {
    visibleMessages: [
      {
        id: "user-message",
        role: "user",
        content: "Review the selected text.",
      },
      {
        id: "agent-message",
        role: "agent",
        content: "The selected text stays available. [Open README](README.md)",
      },
    ],
    bottomRef: { current: null },
    onRetryTask: () => {},
    onContinueTask: () => {},
    onOpenWorkspaceFile: (relativePath: string, line?: number) =>
      openedFiles(relativePath, line, refresh),
    voicePlayback: {
      supported: false,
      speakingMessageId: null,
      onSpeakMessage: () => {},
      onStopSpeaking: () => {},
    },
  });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.getSelection()?.removeAllRanges();
});

describe("ConversationFeed text selection", () => {
  it("keeps selected message text attached during idle updates", () => {
    vi.useFakeTimers();
    const { container } = render(createElement(IdleChat));
    const paragraph = container.querySelector(
      '[data-message-id="agent-message"] .app-markdown-paragraph',
    );
    const textNode = paragraph?.firstChild;
    expect(textNode).toBeInstanceOf(Text);

    const range = document.createRange();
    range.setStart(textNode!, 4);
    range.setEnd(textNode!, 17);
    const selection = window.getSelection()!;
    selection.addRange(range);
    expect(selection.toString()).toBe("selected text");

    act(() => vi.advanceTimersByTime(9_000));

    expect(textNode?.isConnected).toBe(true);
    expect(selection.toString()).toBe("selected text");
    expect(selection.rangeCount).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Open README" }));
    expect(openedFiles).toHaveBeenCalledWith("README.md", undefined, 3);
  });
});
