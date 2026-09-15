import { describe, expect, it } from "vitest";
import type { ChatSessionMessage } from "../../chat-session.model";
import {
  getConversationMessageNavigationState,
  getVisibleConversationMessageId,
  type ConversationMessageViewportBounds,
} from "./message-navigation";

const getActiveMessageId = (
  messageBounds: ConversationMessageViewportBounds[],
  isAtBottom = false,
): string | null =>
  getVisibleConversationMessageId(messageBounds, 0, 120, isAtBottom);

describe("getVisibleConversationMessageId", () => {
  it("keeps a short message at the top active before a long response", () => {
    expect(
      getActiveMessageId([
        { id: "short-message", top: 0, bottom: 24 },
        { id: "long-response", top: 40, bottom: 2_000 },
      ]),
    ).toBe("short-message");
  });

  it("follows messages while scrolling upward from the last entry", () => {
    expect(
      getActiveMessageId(
        [
          { id: "26", top: -220, bottom: -120 },
          { id: "27", top: -100, bottom: 0 },
          { id: "28", top: 20, bottom: 120 },
        ],
        true,
      ),
    ).toBe("28");
    expect(
      getActiveMessageId([
        { id: "26", top: -160, bottom: -60 },
        { id: "27", top: -40, bottom: 60 },
        { id: "28", top: 80, bottom: 180 },
      ]),
    ).toBe("27");
    expect(
      getActiveMessageId([
        { id: "26", top: -40, bottom: 60 },
        { id: "27", top: 80, bottom: 180 },
        { id: "28", top: 200, bottom: 300 },
      ]),
    ).toBe("26");
  });

  it("follows messages while scrolling downward", () => {
    expect(
      getActiveMessageId([
        { id: "26", top: -40, bottom: 60 },
        { id: "27", top: 80, bottom: 180 },
        { id: "28", top: 200, bottom: 300 },
      ]),
    ).toBe("26");
    expect(
      getActiveMessageId([
        { id: "26", top: -160, bottom: -60 },
        { id: "27", top: -40, bottom: 60 },
        { id: "28", top: 80, bottom: 180 },
      ]),
    ).toBe("27");
    expect(
      getActiveMessageId(
        [
          { id: "26", top: -220, bottom: -120 },
          { id: "27", top: -100, bottom: 0 },
          { id: "28", top: 20, bottom: 120 },
        ],
        true,
      ),
    ).toBe("28");
  });

  it("keeps the first and last visible messages active at scroll edges", () => {
    const messageBounds = [
      { id: "26", top: -20, bottom: 80 },
      { id: "27", top: 100, bottom: 200 },
    ];

    expect(getActiveMessageId(messageBounds)).toBe("26");
    expect(getActiveMessageId(messageBounds, true)).toBe("27");
  });

  it("ignores messages outside the viewport", () => {
    expect(
      getActiveMessageId([
        { id: "26", top: -200, bottom: -100 },
        { id: "27", top: 140, bottom: 240 },
      ]),
    ).toBeNull();
  });

  it("preserves the total and button neighbors for the visible message", () => {
    const messages: ChatSessionMessage[] = ["26", "27", "28"].map((id) => ({
      id,
      role: "agent",
      content: id,
    }));
    const navigationState = getConversationMessageNavigationState(
      messages,
      "27",
    );

    expect(navigationState.currentIndex).toBe(1);
    expect(navigationState.currentMessage?.id).toBe("27");
    expect(navigationState.previousMessage?.id).toBe("26");
    expect(navigationState.nextMessage?.id).toBe("28");
    expect(navigationState.messages).toHaveLength(3);
  });
});
