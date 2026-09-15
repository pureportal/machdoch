// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement, createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSessionMessage } from "../../chat-session.model";
import * as messageExport from "../_helpers/message-export";
import { ConversationFeed } from "./conversation-feed";

const writeText = vi.fn<(text: string) => Promise<void>>();
const saveAsPack = vi.fn();

const renderFeed = (message: ChatSessionMessage) =>
  render(
    createElement(ConversationFeed, {
      visibleMessages: [message],
      bottomRef: createRef<HTMLDivElement>(),
      onRetryTask: vi.fn(),
      onContinueTask: vi.fn(),
      onOpenWorkspaceFile: vi.fn(),
      onSaveMessageAsContextPack: saveAsPack,
      voicePlayback: {
        supported: false,
        speakingMessageId: null,
        onSpeakMessage: vi.fn(),
        onStopSpeaking: vi.fn(),
      },
    }),
  );

const openMenu = (container: HTMLElement): HTMLElement => {
  const bubble = container.querySelector<HTMLElement>(".app-message-bubble")!;
  fireEvent.contextMenu(bubble, { clientX: 100, clientY: 100 });
  return bubble;
};

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  saveAsPack.mockReset();
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 196,
    bottom: 234,
    width: 196,
    height: 234,
    toJSON: () => ({}),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ConversationFeed message exports", () => {
  it.each(["user", "agent"] as const)(
    "offers all copy formats for %s messages",
    (role) => {
      const { container } = renderFeed({
        id: "message",
        role,
        content: "**Hello**",
      });
      openMenu(container);
      expect(
        screen.getAllByRole("menuitem").map((item) => item.textContent),
      ).toEqual([
        ...(role === "user" ? ["Save as pack"] : []),
        "Copy Markdown",
        "Copy as text",
        "Copy as raw text",
        "Copy as image",
        "Save Markdown",
      ]);
    },
  );

  it("copies rendered Markdown and closes after success", async () => {
    const { container } = renderFeed({
      id: "message",
      role: "user",
      content: "**Hello**  \n",
    });
    openMenu(container);
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Markdown" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(writeText).toHaveBeenCalledExactlyOnceWith("**Hello**");
  });

  it("copies raw stored text without trimming whitespace", async () => {
    const content = "  **Hello**  \n\n";
    const { container } = renderFeed({ id: "message", role: "user", content });
    openMenu(container);
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy as raw text" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledExactlyOnceWith(content),
    );
  });

  it("copies plain text from the selected bubble", async () => {
    const plainText = vi
      .spyOn(messageExport, "getMessagePlainText")
      .mockReturnValue("Hello\n\nWorld");
    const { container } = renderFeed({
      id: "message",
      role: "agent",
      content: "**Hello**\n\nWorld",
    });
    const bubble = openMenu(container);
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy as text" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledExactlyOnceWith("Hello\n\nWorld"),
    );
    expect(plainText).toHaveBeenCalledExactlyOnceWith(bubble);
  });

  it("copies only the selected message as an image", async () => {
    const copyImage = vi
      .spyOn(messageExport, "copyMessageImage")
      .mockResolvedValue(undefined);
    const { container } = renderFeed({
      id: "message",
      role: "agent",
      content: "Hello",
    });
    const bubble = openMenu(container);
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy as image" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(copyImage).toHaveBeenCalledExactlyOnceWith(bubble);
  });

  it("shows clipboard rejection and lets the user retry", async () => {
    writeText.mockRejectedValueOnce(
      new DOMException("Denied", "NotAllowedError"),
    );
    const { container } = renderFeed({
      id: "message",
      role: "user",
      content: "Hello",
    });
    openMenu(container);
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Markdown" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "try again",
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Markdown" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it("reports image rendering failures and keeps the menu available", async () => {
    vi.spyOn(messageExport, "copyMessageImage").mockRejectedValue(
      new Error("Image could not be created. Try again."),
    );
    const { container } = renderFeed({
      id: "message",
      role: "agent",
      content: "Hello",
    });
    openMenu(container);
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy as image" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Image could not be created",
    );
    expect(
      screen
        .getByRole("menuitem", { name: "Copy as text" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it("prevents duplicate exports while a copy is pending", async () => {
    let resolveCopy!: () => void;
    writeText.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveCopy = resolve;
        }),
    );
    const { container } = renderFeed({
      id: "message",
      role: "user",
      content: "Hello",
    });
    openMenu(container);
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Markdown" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Markdown" }));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(
      screen
        .getAllByRole("menuitem")
        .every((item) => item.hasAttribute("disabled")),
    ).toBe(true);
    resolveCopy();
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("saves the displayed Markdown with the message filename", async () => {
    const save = vi
      .spyOn(messageExport, "saveMessageMarkdown")
      .mockImplementation(() => {});
    const { container } = renderFeed({
      id: "my-message",
      role: "agent",
      content: "# Answer",
    });
    openMenu(container);
    fireEvent.click(screen.getByRole("menuitem", { name: "Save Markdown" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(save).toHaveBeenCalledExactlyOnceWith(
      "# Answer",
      "machdoch-assistant-message-my-message.md",
    );
  });

  it("does not dismiss a newly opened menu when an earlier copy finishes", async () => {
    let resolveCopy!: () => void;
    writeText.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveCopy = resolve;
        }),
    );
    const { container } = renderFeed({
      id: "message",
      role: "user",
      content: "Hello",
    });
    const bubble = openMenu(container);
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Markdown" }));
    fireEvent.contextMenu(bubble, { clientX: 200, clientY: 200 });
    await act(async () => resolveCopy());
    expect(
      screen
        .getByRole("menuitem", { name: "Copy Markdown" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it("preserves saving a user message as a context pack", async () => {
    const message: ChatSessionMessage = {
      id: "message",
      role: "user",
      content: "Hello",
    };
    const { container } = renderFeed(message);
    openMenu(container);
    fireEvent.click(screen.getByRole("menuitem", { name: "Save as pack" }));
    await waitFor(() =>
      expect(saveAsPack).toHaveBeenCalledExactlyOnceWith(message),
    );
  });

  it("supports keyboard navigation and Escape", () => {
    const { container } = renderFeed({
      id: "message",
      role: "agent",
      content: "Hello",
    });
    openMenu(container);
    expect(document.activeElement?.textContent).toBe("Copy Markdown");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("Copy as text");
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement?.textContent).toBe("Save Markdown");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps the expanded menu within the viewport and allows scrolling inside it", () => {
    const { container } = renderFeed({
      id: "message",
      role: "user",
      content: "Hello",
    });
    const bubble = container.querySelector(".app-message-bubble")!;
    fireEvent.contextMenu(bubble, {
      clientX: window.innerWidth,
      clientY: window.innerHeight,
    });
    const menu = screen.getByRole("menu");
    expect(menu.style.left).toBe(`${window.innerWidth - 204}px`);
    expect(menu.style.top).toBe(`${window.innerHeight - 242}px`);
    fireEvent.scroll(menu);
    expect(screen.getByRole("menu")).toBe(menu);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
