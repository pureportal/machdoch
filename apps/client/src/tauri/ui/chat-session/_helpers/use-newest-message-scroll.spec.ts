// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createElement,
  Fragment,
  StrictMode,
  useCallback,
  useState,
  type ChangeEvent,
  type JSX,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScrollToNewestButton } from "../components/scroll-to-newest-button";
import { ScrollToTopButton } from "../components/scroll-to-top-button";
import { useNewestMessageScroll } from "./use-newest-message-scroll";

interface ViewportMetrics {
  scrollHeight: number;
  clientHeight: number;
}

const resizeObservers: ResizeObserverMock[] = [];

class ResizeObserverMock {
  readonly callback: ResizeObserverCallback;
  readonly observedElements = new Set<Element>();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    resizeObservers.push(this);
  }

  observe(element: Element): void {
    this.observedElements.add(element);
  }

  unobserve(element: Element): void {
    this.observedElements.delete(element);
  }

  disconnect = vi.fn((): void => {
    this.observedElements.clear();
  });

  notify(): void {
    if (this.observedElements.size > 0) {
      this.callback([], this as unknown as ResizeObserver);
    }
  }
}

const ChatHarness = ({
  contentKey = "messages",
  resetKey = "session-1",
  mounted = true,
  viewportKey = "viewport",
  metrics,
}: {
  contentKey?: unknown;
  resetKey?: string;
  mounted?: boolean;
  viewportKey?: string;
  metrics: ViewportMetrics;
}): JSX.Element => {
  const [draft, setDraft] = useState("");
  const newestMessageScroll = useNewestMessageScroll({
    resetKey,
    contentKey,
  });
  const setViewport = useCallback(
    (node: HTMLDivElement | null): void => {
      if (!node) {
        return;
      }

      Object.defineProperties(node, {
        scrollHeight: {
          configurable: true,
          get: () => metrics.scrollHeight,
        },
        clientHeight: {
          configurable: true,
          get: () => metrics.clientHeight,
        },
      });
    },
    [metrics],
  );
  const handleDraftChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    setDraft(event.target.value);
  };

  return createElement(
    Fragment,
    null,
    mounted
      ? createElement(
          "div",
          {
            key: viewportKey,
            "data-slot": "scroll-area-viewport",
            "data-testid": "conversation-viewport",
            ref: setViewport,
          },
          createElement(
            "div",
            { key: resetKey },
            createElement("div", { ref: newestMessageScroll.bottomRef }),
          ),
        )
      : null,
    createElement("textarea", {
      "aria-label": "Task composer",
      value: draft,
      onChange: handleDraftChange,
    }),
    createElement(ScrollToTopButton, {
      visible: newestMessageScroll.showScrollToTopButton,
      onClick: newestMessageScroll.scrollToTop,
    }),
    createElement(ScrollToNewestButton, {
      visible: newestMessageScroll.showScrollToNewestButton,
      onClick: newestMessageScroll.scrollToNewest,
    }),
  );
};

beforeEach(() => {
  resizeObservers.length = 0;
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useNewestMessageScroll", () => {
  it("tracks scrolling when the conversation mounts after hydration without a chat change", () => {
    const metrics = { scrollHeight: 1_000, clientHeight: 200 };
    const { rerender } = render(
      createElement(ChatHarness, { metrics, mounted: false }),
    );

    rerender(createElement(ChatHarness, { metrics }));

    const viewport = screen.getByTestId("conversation-viewport");
    expect(viewport.scrollTop).toBe(800);
    fireEvent.click(screen.getByRole("button", { name: "Scroll to top" }));
    expect(viewport.scrollTop).toBe(0);
    expect(screen.queryByRole("button", { name: "Scroll to top" })).toBeNull();
    viewport.scrollTop = 320;
    fireEvent.scroll(viewport);
    expect(screen.getByRole("button", { name: "Scroll to top" })).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Scroll to newest message" }),
    );

    expect(viewport.scrollTop).toBe(800);
    expect(screen.getByRole("button", { name: "Scroll to top" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Scroll to newest message" }),
    ).toBeNull();
  });

  it("tracks a replacement conversation viewport without a chat change", () => {
    const metrics = { scrollHeight: 1_000, clientHeight: 200 };
    const { rerender } = render(createElement(ChatHarness, { metrics }));
    const previousViewport = screen.getByTestId("conversation-viewport");
    const previousObserver = resizeObservers.at(-1);

    rerender(
      createElement(ChatHarness, { metrics, viewportKey: "replacement" }),
    );

    const viewport = screen.getByTestId("conversation-viewport");
    expect(viewport).not.toBe(previousViewport);
    expect(previousObserver?.disconnect).toHaveBeenCalledOnce();
    expect(viewport.scrollTop).toBe(800);
    viewport.scrollTop = 320;
    fireEvent.scroll(viewport);

    previousViewport.scrollTop = 800;
    fireEvent.scroll(previousViewport);

    expect(
      screen.getByRole("button", { name: "Scroll to newest message" }),
    ).toBeTruthy();

    viewport.scrollTop = 0;
    fireEvent.scroll(viewport);
    fireEvent.scroll(previousViewport);
    expect(screen.queryByRole("button", { name: "Scroll to top" })).toBeNull();
  });

  it("preserves a manually scrolled viewport through repeated composer edits", () => {
    const metrics = { scrollHeight: 1_000, clientHeight: 200 };
    render(createElement(ChatHarness, { metrics }));

    const viewport = screen.getByTestId("conversation-viewport");
    const composer = screen.getByRole("textbox", {
      name: "Task composer",
    }) as HTMLTextAreaElement;
    const resizeObserver = resizeObservers[0];

    expect(viewport.scrollTop).toBe(800);
    expect(resizeObserver).toBeDefined();

    viewport.scrollTop = 320;
    composer.focus();
    metrics.clientHeight = 180;
    fireEvent.change(composer, { target: { value: "First edit" } });
    act(() => resizeObserver?.notify());
    act(() => resizeObserver?.notify());

    expect(document.activeElement).toBe(composer);
    expect(composer.value).toBe("First edit");
    expect(viewport.scrollTop).toBe(320);
    expect(
      screen.getByRole("button", { name: "Scroll to newest message" }),
    ).toBeTruthy();

    metrics.clientHeight = 160;
    fireEvent.change(composer, {
      target: { value: "First edit with more text" },
    });
    act(() => resizeObserver?.notify());
    fireEvent.change(composer, { target: { value: "First edit" } });
    metrics.clientHeight = 180;
    act(() => resizeObserver?.notify());

    expect(composer.value).toBe("First edit");
    expect(viewport.scrollTop).toBe(320);
  });

  it("keeps following resize-driven chat updates while pinned to newest", () => {
    const metrics = { scrollHeight: 1_000, clientHeight: 200 };
    render(createElement(ChatHarness, { metrics }));

    const viewport = screen.getByTestId("conversation-viewport");
    const resizeObserver = resizeObservers[0];

    expect(viewport.scrollTop).toBe(800);

    metrics.scrollHeight = 1_120;
    act(() => resizeObserver?.notify());

    expect(viewport.scrollTop).toBe(920);

    viewport.scrollTop = 400;
    fireEvent.scroll(viewport);
    fireEvent.click(
      screen.getByRole("button", { name: "Scroll to newest message" }),
    );

    expect(viewport.scrollTop).toBe(920);
  });

  it("shows the button only outside the near-bottom threshold", () => {
    const metrics = { scrollHeight: 1_000, clientHeight: 200 };
    render(createElement(ChatHarness, { metrics }), { wrapper: StrictMode });
    const viewport = screen.getByTestId("conversation-viewport");

    for (const scrollTop of [800, 791, 792, 0, 800]) {
      viewport.scrollTop = scrollTop;
      fireEvent.scroll(viewport);

      expect(
        screen.queryByRole("button", { name: "Scroll to newest message" }) !==
          null,
      ).toBe(scrollTop < 792);
    }
  });

  it("shows the top button only outside the near-top threshold", () => {
    const metrics = { scrollHeight: 1_000, clientHeight: 200 };
    render(createElement(ChatHarness, { metrics }), { wrapper: StrictMode });
    const viewport = screen.getByTestId("conversation-viewport");

    for (const scrollTop of [800, 9, 8, 0, -1, 320, 800]) {
      viewport.scrollTop = scrollTop;
      fireEvent.scroll(viewport);

      expect(
        screen.queryByRole("button", { name: "Scroll to top" }) !== null,
      ).toBe(scrollTop > 8);
      expect(
        screen.queryByRole("button", { name: "Scroll to newest message" }) !==
          null,
      ).toBe(scrollTop < 792);
    }
  });

  it("stays at the top through incoming messages and resizes until returning to the bottom", () => {
    const metrics = { scrollHeight: 1_000, clientHeight: 200 };
    const { rerender } = render(createElement(ChatHarness, { metrics }));
    const viewport = screen.getByTestId("conversation-viewport");

    fireEvent.click(screen.getByRole("button", { name: "Scroll to top" }));

    expect(viewport.scrollTop).toBe(0);
    expect(screen.queryByRole("button", { name: "Scroll to top" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Scroll to newest message" }),
    ).toBeTruthy();

    metrics.scrollHeight = 1_120;
    rerender(createElement(ChatHarness, { metrics, contentKey: "message-2" }));
    expect(viewport.scrollTop).toBe(0);
    expect(screen.queryByRole("button", { name: "Scroll to top" })).toBeNull();

    metrics.scrollHeight = 1_240;
    metrics.clientHeight = 180;
    act(() => resizeObservers.at(-1)?.notify());
    expect(viewport.scrollTop).toBe(0);
    expect(screen.queryByRole("button", { name: "Scroll to top" })).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Scroll to newest message" }),
    );
    expect(viewport.scrollTop).toBe(1_060);
    expect(screen.getByRole("button", { name: "Scroll to top" })).toBeTruthy();

    metrics.scrollHeight = 1_360;
    rerender(createElement(ChatHarness, { metrics, contentKey: "message-3" }));
    expect(viewport.scrollTop).toBe(1_180);
    expect(screen.getByRole("button", { name: "Scroll to top" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Scroll to newest message" }),
    ).toBeNull();
  });

  it.each(["{Enter}", " "])(
    "scrolls to the top with the %s key",
    async (key) => {
      const user = userEvent.setup();
      const metrics = { scrollHeight: 1_000, clientHeight: 200 };
      render(createElement(ChatHarness, { metrics }));
      const viewport = screen.getByTestId("conversation-viewport");

      await user.tab();
      await user.tab();
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Scroll to top" }),
      );
      await user.keyboard(key);

      expect(viewport.scrollTop).toBe(0);
      expect(
        screen.queryByRole("button", { name: "Scroll to top" }),
      ).toBeNull();
      expect(
        screen.getByRole("button", { name: "Scroll to newest message" }),
      ).toBeTruthy();
    },
  );

  it("follows new messages only while near the bottom and resumes after clicking the button", () => {
    const metrics = { scrollHeight: 1_000, clientHeight: 200 };
    const { rerender } = render(createElement(ChatHarness, { metrics }));
    const viewport = screen.getByTestId("conversation-viewport");

    viewport.scrollTop = 792;
    fireEvent.scroll(viewport);
    metrics.scrollHeight = 1_120;
    rerender(createElement(ChatHarness, { metrics, contentKey: "message-2" }));

    expect(viewport.scrollTop).toBe(920);
    expect(screen.getByRole("button", { name: "Scroll to top" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Scroll to newest message" }),
    ).toBeNull();

    viewport.scrollTop = 320;
    fireEvent.scroll(viewport);
    metrics.scrollHeight = 1_240;
    rerender(createElement(ChatHarness, { metrics, contentKey: "message-3" }));

    expect(viewport.scrollTop).toBe(320);
    expect(screen.getByRole("button", { name: "Scroll to top" })).toBeTruthy();
    const button = screen.getByRole("button", {
      name: "Scroll to newest message",
    });

    metrics.scrollHeight = 1_360;
    act(() => resizeObservers.at(-1)?.notify());
    expect(viewport.scrollTop).toBe(320);
    expect(button.isConnected).toBe(true);

    fireEvent.click(button);
    expect(viewport.scrollTop).toBe(1_160);
    expect(
      screen.queryByRole("button", { name: "Scroll to newest message" }),
    ).toBeNull();

    metrics.scrollHeight = 1_480;
    rerender(createElement(ChatHarness, { metrics, contentKey: "message-4" }));
    expect(viewport.scrollTop).toBe(1_280);
  });

  it("initializes each chat and observes its new content inside the same viewport", () => {
    const metrics = { scrollHeight: 1_000, clientHeight: 200 };
    const { rerender } = render(createElement(ChatHarness, { metrics }));
    const viewport = screen.getByTestId("conversation-viewport");

    for (const resetKey of ["session-2", "session-1"]) {
      fireEvent.click(screen.getByRole("button", { name: "Scroll to top" }));
      const previousObserver = resizeObservers.at(-1);
      metrics.scrollHeight += 120;

      rerender(createElement(ChatHarness, { metrics, resetKey }));

      expect(screen.getByTestId("conversation-viewport")).toBe(viewport);
      expect(previousObserver?.disconnect).toHaveBeenCalledOnce();
      expect(resizeObservers.at(-1)?.observedElements).toEqual(
        new Set([viewport, viewport.firstElementChild]),
      );
      expect(viewport.scrollTop).toBe(metrics.scrollHeight - 200);
      expect(
        screen.getByRole("button", { name: "Scroll to top" }),
      ).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: "Scroll to newest message" }),
      ).toBeNull();

      metrics.scrollHeight += 120;
      act(() => resizeObservers.at(-1)?.notify());
      expect(viewport.scrollTop).toBe(metrics.scrollHeight - 200);

      viewport.scrollTop = 0;
      fireEvent.scroll(viewport);
      expect(
        screen.queryByRole("button", { name: "Scroll to top" }),
      ).toBeNull();
      viewport.scrollTop = 320;
      fireEvent.scroll(viewport);
      expect(
        screen.getByRole("button", { name: "Scroll to top" }),
      ).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "Scroll to newest message" }),
      ).toBeTruthy();
    }
  });

  it("cleans up when leaving Chat and tracks scrolling after returning to the same chat", () => {
    const metrics = { scrollHeight: 1_000, clientHeight: 200 };
    const { rerender, unmount } = render(
      createElement(ChatHarness, { metrics }),
    );
    const previousViewport = screen.getByTestId("conversation-viewport");
    const previousObserver = resizeObservers.at(-1);

    previousViewport.scrollTop = 320;
    fireEvent.scroll(previousViewport);
    rerender(createElement(ChatHarness, { metrics, mounted: false }));

    expect(previousObserver?.disconnect).toHaveBeenCalledOnce();
    fireEvent.scroll(previousViewport);
    expect(screen.queryByRole("button", { name: "Scroll to top" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Scroll to newest message" }),
    ).toBeNull();

    rerender(createElement(ChatHarness, { metrics }));
    const viewport = screen.getByTestId("conversation-viewport");
    expect(viewport.scrollTop).toBe(800);
    fireEvent.click(screen.getByRole("button", { name: "Scroll to top" }));
    expect(viewport.scrollTop).toBe(0);
    expect(screen.queryByRole("button", { name: "Scroll to top" })).toBeNull();
    viewport.scrollTop = 320;
    fireEvent.scroll(viewport);
    expect(screen.getByRole("button", { name: "Scroll to top" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Scroll to newest message" }),
    ).toBeTruthy();

    const observer = resizeObservers.at(-1);
    unmount();
    expect(observer?.disconnect).toHaveBeenCalledOnce();
  });

  it("keeps short conversations at the bottom as they grow to overflow", () => {
    const metrics = { scrollHeight: 120, clientHeight: 200 };
    render(createElement(ChatHarness, { metrics }));
    const viewport = screen.getByTestId("conversation-viewport");

    expect(viewport.scrollTop).toBe(0);
    expect(screen.queryByRole("button", { name: "Scroll to top" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Scroll to newest message" }),
    ).toBeNull();

    metrics.scrollHeight = 320;
    act(() => resizeObservers.at(-1)?.notify());
    expect(viewport.scrollTop).toBe(120);
    expect(screen.getByRole("button", { name: "Scroll to top" })).toBeTruthy();

    viewport.scrollTop = 0;
    fireEvent.scroll(viewport);
    expect(screen.queryByRole("button", { name: "Scroll to top" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Scroll to newest message" }),
    ).toBeTruthy();
  });

  it("updates top visibility as content grows and the viewport expands to fit it", () => {
    const metrics = { scrollHeight: 120, clientHeight: 200 };
    const { rerender } = render(createElement(ChatHarness, { metrics }));
    const viewport = screen.getByTestId("conversation-viewport");

    metrics.scrollHeight = 208;
    rerender(createElement(ChatHarness, { metrics, contentKey: "message-2" }));
    expect(viewport.scrollTop).toBe(8);
    expect(screen.queryByRole("button", { name: "Scroll to top" })).toBeNull();

    metrics.scrollHeight = 320;
    rerender(createElement(ChatHarness, { metrics, contentKey: "message-3" }));
    expect(viewport.scrollTop).toBe(120);
    expect(screen.getByRole("button", { name: "Scroll to top" })).toBeTruthy();

    metrics.clientHeight = 400;
    act(() => resizeObservers.at(-1)?.notify());
    expect(viewport.scrollTop).toBe(0);
    expect(screen.queryByRole("button", { name: "Scroll to top" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Scroll to newest message" }),
    ).toBeNull();
  });
});
