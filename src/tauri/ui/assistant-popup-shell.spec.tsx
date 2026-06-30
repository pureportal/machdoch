import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
  it("does not expose settings in the Quick Chat window", async () => {
    render(<AssistantPopupShell />);

    await waitFor(() => {
      expect(windowFocusChangedListeners.size).toBe(1);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      screen.queryByRole("button", { name: /open settings/i }),
    ).toBeNull();
    expect(screen.queryByText(/^settings$/i)).toBeNull();
  });

  it("hides the Quick Chat window when it loses focus", async () => {
    render(<AssistantPopupShell />);

    await waitFor(() => {
      expect(windowFocusChangedListeners.size).toBe(1);
    });

    await act(async () => {
      for (const listener of windowFocusChangedListeners) {
        listener({ payload: false });
      }
    });

    await waitFor(() => {
      expect(currentWindowMock.hide).toHaveBeenCalledTimes(1);
    });
  });

  it("does not hide the Quick Chat window on focus loss while pinned", async () => {
    render(<AssistantPopupShell />);

    await waitFor(() => {
      expect(windowFocusChangedListeners.size).toBe(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Pin Quick Chat" }));

    expect(
      screen
        .getByRole("button", { name: "Unpin Quick Chat" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    vi.useFakeTimers();

    try {
      act(() => {
        for (const listener of windowFocusChangedListeners) {
          listener({ payload: false });
        }

        vi.advanceTimersByTime(150);
      });

      expect(currentWindowMock.hide).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
