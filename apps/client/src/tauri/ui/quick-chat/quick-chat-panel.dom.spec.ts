// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandProvider } from "@machdoch/media-studio/tauri/ui/commands/command-context.js";
import { TooltipProvider } from "@machdoch/media-studio/tauri/ui/components/ui/tooltip.js";
import { appControl } from "@machdoch/media-studio/tauri/ui/app-control/app-control-registry.js";
import { QuickChatPanel, type QuickChatPanelProps } from "./quick-chat-panel";
import { QuickChatButton } from "./quick-chat-button";

vi.mock("../chat-session/components/session-model-picker", () => ({
  SessionModelPicker: () => createElement("span", null, "Model"),
}));

afterEach(cleanup);

const composer = (
  overrides: Partial<QuickChatPanelProps["composer"]> = {},
): QuickChatPanelProps["composer"] =>
  ({
    draft: "",
    draftRevision: 0,
    chooserProviders: [],
    provider: "codex-cli",
    model: "gpt-5.5",
    autopilotEnabled: true,
    globalMemoryAvailable: false,
    globalMemoryEnabled: false,
    uiControlAvailable: false,
    uiControlEnabled: false,
    contextAttachments: [],
    imageInputSupported: true,
    imageInputDisabledReason: null,
    canSend: true,
    sendDisabledReason: null,
    isExecuting: false,
    onModelSelection: vi.fn(),
    onAutopilotChange: vi.fn(),
    onSelectContextFiles: vi.fn(async () => undefined),
    onSelectContextFolders: vi.fn(async () => undefined),
    onSelectContextImages: vi.fn(async () => undefined),
    onPasteContextImages: vi.fn(async () => undefined),
    onOpenContextAttachment: vi.fn(),
    onRemoveContextAttachment: vi.fn(),
    onClearContextAttachments: vi.fn(),
    onGlobalMemoryChange: vi.fn(),
    onUiControlChange: vi.fn(),
    onDraftChange: vi.fn(),
    onSend: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  }) as QuickChatPanelProps["composer"];

const quickTask = (
  overrides: Partial<QuickChatPanelProps["quickTask"]> = {},
): QuickChatPanelProps["quickTask"] => ({
  session: null,
  visibleMessages: [],
  workspaceRoot: null,
  onOpenWorkspaceFile: vi.fn(),
  onOpenLocalFile: vi.fn(),
  canClearHistory: false,
  status: "empty",
  ...overrides,
});

describe("QuickChatPanel", () => {
  it("shows the current view, sends drafts, and closes", () => {
    const unregister = appControl.register("media-test", 1, () => ({
      location: ["Media Studio", "Basic", "Image"],
    }));
    const onOpenChange = vi.fn();
    const onSend = vi.fn();
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(QuickChatPanel, {
          open: true,
          onOpenChange,
          quickTask: quickTask(),
          composer: composer({ onSend }),
          focusRequest: 0,
          onClearHistory: vi.fn(),
          onOpenInChat: vi.fn(),
          onOpenAttachment: vi.fn(),
        }),
      ),
    );

    expect(screen.getByRole("dialog", { name: "Quick Chat" })).toBeTruthy();
    expect(screen.getByLabelText("Current view").textContent).toBe(
      "Media Studio › Basic › Image",
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Clear Quick Chat history",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    expect(
      (
        screen.getByRole("button", {
          name: "Open Quick Chat in Chat",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    const input = screen.getByRole("textbox", { name: "Quick Chat message" });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "find a Tomb Raider LoRA" } });
    fireEvent.submit(input.closest("form")!);
    expect(onSend).toHaveBeenCalledWith("find a Tomb Raider LoRA");

    fireEvent.click(screen.getByRole("button", { name: "Close Quick Chat" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    unregister();
  });
});

describe("QuickChatPanel focus and session actions", () => {
  it("refocuses the composer on request and opens the session in Chat", () => {
    const onOpenInChat = vi.fn();
    const props = {
      open: true,
      onOpenChange: vi.fn(),
      quickTask: quickTask({
        session: { id: "quick" } as QuickChatPanelProps["quickTask"]["session"],
        canClearHistory: true,
      }),
      composer: composer(),
      onClearHistory: vi.fn(),
      onOpenInChat,
      onOpenAttachment: vi.fn(),
    };
    const view = render(
      createElement(
        TooltipProvider,
        null,
        createElement(QuickChatPanel, { ...props, focusRequest: 0 }),
      ),
    );
    const input = screen.getByRole("textbox", { name: "Quick Chat message" });
    input.blur();
    view.rerender(
      createElement(
        TooltipProvider,
        null,
        createElement(QuickChatPanel, { ...props, focusRequest: 1 }),
      ),
    );
    expect(document.activeElement).toBe(input);
    fireEvent.click(
      screen.getByRole("button", { name: "Open Quick Chat in Chat" }),
    );
    expect(onOpenInChat).toHaveBeenCalledOnce();
  });
});

describe("QuickChatButton", () => {
  const renderButton = (props: { running: boolean; unread: boolean }) =>
    render(
      createElement(CommandProvider, {
        activeView: "chat",
        platform: "windows",
        runtime: "browser",
        children: createElement(
          TooltipProvider,
          null,
          createElement(QuickChatButton, {
            open: false,
            onToggle: vi.fn(),
            ...props,
          }),
        ),
      }),
    );

  it("announces work and unread replies", () => {
    renderButton({ running: true, unread: false });
    expect(
      screen.getByRole("button", { name: "Quick Chat, working" }),
    ).toBeTruthy();
    cleanup();
    renderButton({ running: false, unread: true });
    expect(
      screen.getByRole("button", { name: "Quick Chat, new reply" }),
    ).toBeTruthy();
  });
});
