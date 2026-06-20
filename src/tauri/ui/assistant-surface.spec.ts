import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  disableInvokeMock,
  enableInvokeMock,
  invokeMock,
  isTauriMock,
  Window,
} from "./test/tauri-test-mocks";
import { revealMainWindow } from "./assistant-surface";

describe("assistant surface window controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enableInvokeMock();
    isTauriMock.mockReturnValue(true);
    invokeMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    disableInvokeMock();
  });

  it("reveals the main window through the desktop shell command", async () => {
    await revealMainWindow();

    expect(invokeMock).toHaveBeenCalledWith("reveal_main_window");
    expect(Window.getByLabel).not.toHaveBeenCalled();
  });
});
