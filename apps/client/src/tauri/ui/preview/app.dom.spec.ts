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
  QUICK_VOICE_WINDOW_LABEL: "quick-voice",
  TRAY_MENU_WINDOW_LABEL: "tray-menu",
}));
vi.mock("../chat-session-shell", () => ({
  ChatSession: () => {
    if (!chat.isLoaded()) throw chat.loading;
    return createElement("div", null, "Chat");
  },
}));
vi.mock("../quick-voice-shell", () => ({
  QuickVoiceShell: () => createElement("div", null, "Quick voice"),
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

  it("does not apply main startup settings from a secondary window", async () => {
    native.label = "quick-voice";
    render(createElement(App));
    await screen.findByText("Quick voice");
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it("does not invoke desktop startup in a browser", async () => {
    native.isTauri.mockReturnValue(false);
    render(createElement(App));
    await screen.findByText("Chat");
    expect(native.invoke).not.toHaveBeenCalled();
  });
});
