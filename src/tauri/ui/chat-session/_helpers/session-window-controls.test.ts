import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ASSISTANT_POPUP_WINDOW_LABEL,
  QUICK_VOICE_WINDOW_LABEL,
} from "../../runtime";
import {
  currentWindowMock,
  isTauriMock,
  Window,
} from "../../test/tauri-test-mocks";
import { closeDesktopWindow } from "./session-window-controls";

type MockWindowHandle = Awaited<ReturnType<typeof Window.getByLabel>>;

describe("session window controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isTauriMock.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hides transient assistant windows before closing the main window", async () => {
    const popupWindow = {
      hide: vi.fn().mockResolvedValue(undefined),
    } as unknown as MockWindowHandle;
    const quickVoiceWindow = {
      hide: vi.fn().mockResolvedValue(undefined),
    } as unknown as MockWindowHandle;
    const getByLabelSpy = vi
      .spyOn(Window, "getByLabel")
      .mockImplementation(async (label: string) => {
        if (label === ASSISTANT_POPUP_WINDOW_LABEL) {
          return popupWindow;
        }

        if (label === QUICK_VOICE_WINDOW_LABEL) {
          return quickVoiceWindow;
        }

        return null as unknown as MockWindowHandle;
      });

    await closeDesktopWindow();

    expect(getByLabelSpy).toHaveBeenCalledWith(ASSISTANT_POPUP_WINDOW_LABEL);
    expect(getByLabelSpy).toHaveBeenCalledWith(QUICK_VOICE_WINDOW_LABEL);
    expect(popupWindow.hide).toHaveBeenCalledTimes(1);
    expect(quickVoiceWindow.hide).toHaveBeenCalledTimes(1);
    expect(currentWindowMock.close).toHaveBeenCalledTimes(1);

    expect(
      popupWindow.hide.mock.invocationCallOrder[0],
    ).toBeLessThan(currentWindowMock.close.mock.invocationCallOrder[0]);
    expect(
      quickVoiceWindow.hide.mock.invocationCallOrder[0],
    ).toBeLessThan(currentWindowMock.close.mock.invocationCallOrder[0]);
  });
});
