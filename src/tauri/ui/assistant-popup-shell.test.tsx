import { cleanup, render, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { AssistantPopupShell } from "./assistant-popup-shell";
import {
  currentWindowMock,
  isTauriMock,
  windowDragDropListeners,
  windowFocusChangedListeners,
} from "./test/tauri-test-mocks";

class ResizeObserverMock {
  observe(): void {}

  unobserve(): void {}

  disconnect(): void {}
}

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
});

beforeEach(() => {
  vi.clearAllMocks();
  isTauriMock.mockReturnValue(true);
  windowDragDropListeners.clear();
  windowFocusChangedListeners.clear();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  windowDragDropListeners.clear();
  windowFocusChangedListeners.clear();
  window.localStorage.clear();
});

describe("AssistantPopupShell", () => {
  it("hides the Quick Chat window when it loses focus", async () => {
    render(<AssistantPopupShell />);

    await waitFor(() => {
      expect(windowFocusChangedListeners.size).toBe(1);
    });

    for (const listener of windowFocusChangedListeners) {
      listener({ payload: false });
    }

    await waitFor(() => {
      expect(currentWindowMock.hide).toHaveBeenCalledTimes(1);
    });
  });
});
