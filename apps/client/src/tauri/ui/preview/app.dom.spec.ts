// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./app";

const native = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  isTauri: vi.fn().mockReturnValue(true),
  label: "main",
}));

const chat = vi.hoisted(() => {
  let loaded = false;
  let resolve: () => void = () => undefined;
  const loading = new Promise<void>((done) => {
    resolve = done;
  });
  return {
    loading,
    isLoaded: () => loaded,
    finish: () => {
      loaded = true;
      resolve();
    },
  };
});

vi.mock("@tauri-apps/api/core", () => native);
vi.mock("../lib/shell-store", () => ({
  getCurrentShellWindowLabel: () => native.label,
}));
vi.mock("../runtime", () => ({
  ASSISTANT_BUBBLE_WINDOW_LABEL: "assistant-bubble",
  ASSISTANT_POPUP_WINDOW_LABEL: "assistant-popup",
  QUICK_VOICE_WINDOW_LABEL: "quick-voice",
  TRAY_MENU_WINDOW_LABEL: "tray-menu",
}));
vi.mock("../chat-session-shell", () => ({
  ChatSession: () => {
    if (!chat.isLoaded()) throw chat.loading;
    return createElement("div", null, "Chat");
  },
}));
vi.mock("../assistant-bubble-shell", () => ({
  AssistantBubbleShell: () => createElement("div", null, "Bubble"),
}));

beforeEach(() => {
  native.invoke.mockClear();
  native.isTauri.mockReturnValue(true);
  native.label = "main";
});
afterEach(cleanup);

describe("desktop startup readiness", () => {
  it("waits for the main UI to mount before applying startup visibility", async () => {
    render(createElement(App));
    expect(native.invoke).not.toHaveBeenCalled();
    await act(async () => chat.finish());
    await screen.findByText("Chat");
    await waitFor(() => {
      expect(native.invoke).toHaveBeenCalledWith("main_window_ready");
    });
  });

  it("does not apply main startup settings from an assistant window", async () => {
    native.label = "assistant-bubble";
    render(createElement(App));
    await screen.findByText("Bubble");
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it("does not invoke desktop startup in a browser", async () => {
    native.isTauri.mockReturnValue(false);
    render(createElement(App));
    await screen.findByText("Chat");
    expect(native.invoke).not.toHaveBeenCalled();
  });
});
