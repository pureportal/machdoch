// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssetStorageSettingsPanel } from "./asset-storage-settings-panel";

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  open: vi.fn(),
  isTauri: vi.fn(() => true),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: native.invoke,
  isTauri: native.isTauri,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: native.open }));

const ready = {
  folder: "C:\\Media",
  destination: null,
  phase: "ready",
  completedBytes: 0,
  totalBytes: 0,
  error: null,
};
const moving = {
  ...ready,
  destination: "D:\\Media",
  phase: "moving",
  totalBytes: 100,
  completedBytes: 25,
};

beforeEach(() => {
  vi.clearAllMocks();
  native.isTauri.mockReturnValue(true);
  native.invoke.mockResolvedValue(ready);
  native.open.mockResolvedValue("D:\\Media");
});
afterEach(cleanup);

describe("asset storage settings", () => {
  it("reviews the destination before starting the move and shows native progress", async () => {
    native.invoke.mockImplementation(async (command: string) =>
      command === "media_move_asset_storage" ? moving : ready,
    );
    render(createElement(AssetStorageSettingsPanel));
    await screen.findByText("C:\\Media");
    fireEvent.click(screen.getByRole("button", { name: "Choose folder" }));
    await screen.findByText("D:\\Media");
    expect(native.invoke).not.toHaveBeenCalledWith(
      "media_move_asset_storage",
      expect.anything(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Move assets" }));
    await screen.findByText("Moving assets");
    expect(native.invoke).toHaveBeenCalledWith("media_move_asset_storage", {
      folder: "D:\\Media",
    });
    expect(screen.getByRole("progressbar").getAttribute("value")).toBe("25");
    expect(screen.queryByRole("button", { name: "Choose folder" })).toBeNull();
  });

  it("rediscovers an interrupted move when reopened and resumes it", async () => {
    native.invoke.mockImplementation(async (command: string) =>
      command === "media_resume_asset_storage"
        ? moving
        : {
            ...moving,
            phase: "paused",
            error: "Reconnect the disk and resume.",
          },
    );
    render(createElement(AssetStorageSettingsPanel));
    await screen.findByText("Move paused");
    expect(screen.getByRole("alert").textContent).toBe(
      "Reconnect the disk and resume.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Resume move" }));
    await screen.findByText("Moving assets");
    expect(native.invoke).toHaveBeenCalledWith(
      "media_resume_asset_storage",
      undefined,
    );
  });

  it("keeps the chosen destination when the disk is full", async () => {
    native.invoke.mockImplementation(async (command: string) => {
      if (command === "media_move_asset_storage")
        throw { message: "Not enough free space. Free up space and retry." };
      return ready;
    });
    render(createElement(AssetStorageSettingsPanel));
    await screen.findByText("C:\\Media");
    fireEvent.click(screen.getByRole("button", { name: "Choose folder" }));
    fireEvent.click(await screen.findByRole("button", { name: "Move assets" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "Not enough free space",
      ),
    );
    expect(screen.getByText("D:\\Media")).toBeDefined();
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Move assets" })
        .disabled,
    ).toBe(false);
  });

  it("does not start a move when the folder picker is cancelled", async () => {
    native.open.mockResolvedValue(null);
    render(createElement(AssetStorageSettingsPanel));
    await screen.findByText("C:\\Media");
    fireEvent.click(screen.getByRole("button", { name: "Choose folder" }));
    await waitFor(() => expect(native.open).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Move assets" })).toBeNull();
  });

  it("does not expose local folder controls in a browser", () => {
    native.isTauri.mockReturnValue(false);
    render(createElement(AssetStorageSettingsPanel));
    expect(
      screen.getByText("Open the desktop app to change the asset folder."),
    ).toBeDefined();
    expect(native.invoke).not.toHaveBeenCalled();
  });
});
