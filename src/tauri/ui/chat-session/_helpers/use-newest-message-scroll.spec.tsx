import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useNewestMessageScroll } from "./use-newest-message-scroll";

interface ScrollMetrics {
  clientHeight: number;
  scrollHeight: number;
}

class ResizeObserverMock implements ResizeObserver {
  observe(): void {}

  unobserve(): void {}

  disconnect(): void {}
}

const ScrollHarness = ({
  contentKey,
  metrics,
}: {
  contentKey: unknown;
  metrics: ScrollMetrics;
}) => {
  const newestMessageScroll = useNewestMessageScroll({
    resetKey: "chat-session",
    contentKey,
  });

  return (
    <div
      data-testid="scroll-viewport"
      data-slot="scroll-area-viewport"
      ref={(node) => {
        if (!node) {
          return;
        }

        Object.defineProperties(node, {
          clientHeight: {
            configurable: true,
            get: () => metrics.clientHeight,
          },
          scrollHeight: {
            configurable: true,
            get: () => metrics.scrollHeight,
          },
        });
      }}
    >
      <div>
        <div ref={newestMessageScroll.bottomRef} />
      </div>
      {newestMessageScroll.showScrollToNewestButton ? (
        <button
          type="button"
          onClick={newestMessageScroll.scrollToNewest}
        >
          Scroll to newest message
        </button>
      ) : null}
    </div>
  );
};

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
});

beforeEach(() => {
  cleanup();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useNewestMessageScroll", () => {
  it("shows a newest-message action after the user scrolls away and jumps back on click", async () => {
    const metrics: ScrollMetrics = {
      clientHeight: 500,
      scrollHeight: 1_000,
    };

    render(<ScrollHarness contentKey="initial" metrics={metrics} />);

    const viewport = screen.getByTestId("scroll-viewport");

    await waitFor(() => {
      expect(viewport.scrollTop).toBe(500);
    });

    act(() => {
      viewport.scrollTop = 240;
    });
    fireEvent.scroll(viewport);

    expect(
      screen.getByRole("button", { name: "Scroll to newest message" }),
    ).toBeDefined();

    fireEvent.click(
      screen.getByRole("button", { name: "Scroll to newest message" }),
    );

    expect(viewport.scrollTop).toBe(500);
    expect(
      screen.queryByRole("button", { name: "Scroll to newest message" }),
    ).toBeNull();
  });
});
