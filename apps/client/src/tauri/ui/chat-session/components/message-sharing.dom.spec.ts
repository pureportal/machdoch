// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { createElement, createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSession,
  type ChatSessionMessage,
} from "../../chat-session.model";
import { useMessageSharing } from "../_helpers/use-message-sharing";
import { ConversationFeed } from "./conversation-feed";
import { ShareMessageDialog } from "./share-message-dialog";

const forwarded: ChatSessionMessage = {
  id: "forwarded",
  role: "user",
  content: "Important information",
  reference: { sessionId: "origin", messageId: "origin-answer" },
};

const origin = createSession({
  id: "origin",
  manualTitle: "Origin",
  updatedAt: 2,
  messages: [
    { id: "origin-request", role: "user", content: "Find the cause." },
    { id: "origin-answer", role: "agent", content: "The cache is stale." },
  ],
});
const target = createSession({
  id: "target",
  manualTitle: "Target",
  updatedAt: 1,
});

const renderFeed = (
  props: Partial<Parameters<typeof ConversationFeed>[0]> = {},
) =>
  render(
    createElement(ConversationFeed, {
      visibleMessages: [forwarded],
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
      ...props,
    }),
  );

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
});

describe("message references", () => {
  it("links a forwarded message to its original chat", () => {
    const open = vi.fn();
    renderFeed({
      getMessageReferenceTitle: () => "Origin",
      onOpenMessageReference: open,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Open original message in Origin" }),
    );
    expect(open).toHaveBeenCalledWith(forwarded.reference);
  });

  it("hides the link when the original message is gone", () => {
    renderFeed({ getMessageReferenceTitle: () => null });
    expect(
      screen.queryByRole("button", { name: /Open original message/ }),
    ).toBeNull();
  });

  it("scrolls to a requested message once", () => {
    const handled = vi.fn();
    renderFeed({
      navigationRequestMessageId: "forwarded",
      onNavigationRequestHandled: handled,
    });
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expect(handled).toHaveBeenCalledOnce();
  });

  it("offers sending a message to another chat from its context menu", () => {
    const share = vi.fn();
    const { container } = renderFeed({ onShareMessage: share });
    fireEvent.contextMenu(container.querySelector(".app-message-bubble")!, {
      clientX: 10,
      clientY: 10,
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "Send to chat…" }));
    expect(share).toHaveBeenCalledWith(forwarded);
  });
});

describe("message sharing", () => {
  it("prefills the latest answer of a sidebar chat for the active chat and sends it with a reference", () => {
    const submit = vi.fn(() => true);
    const { result } = renderHook(() =>
      useMessageSharing({
        sessions: [target, origin],
        activeSessionId: "target",
        onActivateSession: vi.fn(),
        onSubmitMessage: submit,
      }),
    );
    act(() => result.current.shareSessionMessage("origin"));
    expect(result.current.dialog.draft).toEqual({
      sourceSessionId: "origin",
      messageId: "origin-answer",
      targetSessionId: "target",
    });
    act(() => result.current.dialog.onSend(result.current.dialog.draft!));
    expect(submit).toHaveBeenCalledWith({
      sessionId: "target",
      prompt:
        'Important information from the chat "Origin":\n\nThe cache is stale.',
      reference: { sessionId: "origin", messageId: "origin-answer" },
    });
    expect(result.current.dialog.draft).toBeNull();
  });

  it("opens the original chat and requests the referenced message", () => {
    const activate = vi.fn();
    const { result, rerender } = renderHook(
      ({ activeSessionId }) =>
        useMessageSharing({
          sessions: [target, origin],
          activeSessionId,
          onActivateSession: activate,
          onSubmitMessage: vi.fn(() => true),
        }),
      { initialProps: { activeSessionId: "target" } },
    );
    expect(result.current.getReferenceTitle(forwarded.reference!)).toBe(
      "Origin",
    );
    act(() => result.current.openReference(forwarded.reference!));
    expect(activate).toHaveBeenCalledWith("origin");
    rerender({ activeSessionId: "origin" });
    expect(result.current.navigationRequestMessageId).toBe("origin-answer");
  });

  it("sends only once a target chat is chosen", () => {
    const send = vi.fn();
    const draft = {
      sourceSessionId: "origin",
      messageId: "origin-answer",
      targetSessionId: null,
    };
    const { rerender } = render(
      createElement(ShareMessageDialog, {
        draft,
        sessions: [origin, target],
        onDraftChange: vi.fn(),
        onClose: vi.fn(),
        onSend: send,
      }),
    );
    const sendButton = screen.getByRole("button", { name: "Send" });
    expect(sendButton).toHaveProperty("disabled", true);
    expect(screen.getByText("The cache is stale.")).toBeTruthy();
    rerender(
      createElement(ShareMessageDialog, {
        draft: { ...draft, targetSessionId: "target" },
        sessions: [origin, target],
        onDraftChange: vi.fn(),
        onClose: vi.fn(),
        onSend: send,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(send).toHaveBeenCalledWith({ ...draft, targetSessionId: "target" });
  });
});
