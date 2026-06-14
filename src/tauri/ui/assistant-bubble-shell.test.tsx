import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInitialShellState,
  createSession,
  type ShellPersistedState,
} from "./chat-session.model";
import { AssistantBubbleShell } from "./assistant-bubble-shell";
import { isTauriMock } from "./test/tauri-test-mocks";
import type { AppearanceSettings } from "./lib/shell-store";

const SHELL_STATE_STORAGE_KEY = "machdoch.desktop.shell-state";
const APPEARANCE_STORAGE_KEY = "machdoch.desktop.appearance-state";

const storeShellState = (value: ShellPersistedState): void => {
  window.localStorage.setItem(SHELL_STATE_STORAGE_KEY, JSON.stringify(value));
};

const storeAppearanceSettings = (
  partial: Partial<AppearanceSettings>,
): void => {
  window.localStorage.setItem(
    APPEARANCE_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      theme: "dark",
      density: "comfortable",
      accent: "sky",
      quickChatBubbleStyle: "classic",
      ...partial,
    } satisfies AppearanceSettings),
  );
};

describe("AssistantBubbleShell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isTauriMock.mockReturnValue(false);
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("exposes idle launcher state and popup accessibility metadata", async () => {
    render(<AssistantBubbleShell />);

    const bubble = await screen.findByRole("button", {
      name: "Open Quick Chat",
    });

    await waitFor(() => {
      expect(bubble.getAttribute("data-state")).toBe("idle");
    });

    expect(bubble.getAttribute("aria-haspopup")).toBe("dialog");
    expect(bubble.getAttribute("aria-expanded")).toBe("false");
    expect(bubble.getAttribute("data-running")).toBe("false");
    expect(bubble.getAttribute("data-has-notification")).toBe("false");
    expect(bubble.getAttribute("data-voice-enabled")).toBe("true");
  });

  it("marks running sessions for stateful attention styles", async () => {
    const runningSession = createSession({
      id: "session-running",
      messages: [
        {
          id: "task-running",
          role: "user",
          content: "Run the task",
          createdAt: 1,
        },
      ],
      updatedAt: 1,
    });

    storeShellState({
      ...createInitialShellState(),
      activeSessionId: runningSession.id,
      sessions: [runningSession],
    });
    storeAppearanceSettings({ quickChatBubbleStyle: "pulse" });

    render(<AssistantBubbleShell />);

    const bubble = await screen.findByRole("button", {
      name: "Open Quick Chat",
    });

    await waitFor(() => {
      expect(bubble.getAttribute("data-style")).toBe("pulse");
      expect(bubble.getAttribute("data-state")).toBe("running");
      expect(bubble.getAttribute("data-running")).toBe("true");
      expect(bubble.getAttribute("data-has-notification")).toBe("true");
    });

    expect(screen.getByText("1")).toBeDefined();
  });
});
