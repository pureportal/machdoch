// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  createElement,
  Fragment,
  useCallback,
  useState,
  type ChangeEvent,
  type JSX,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNewestMessageScroll } from "./use-newest-message-scroll";

interface ViewportMetrics {
  scrollHeight: number;
  clientHeight: number;
}

const resizeObservers: ResizeObserverMock[] = [];

class ResizeObserverMock {
  readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    resizeObservers.push(this);
  }

  observe(): void {}

  unobserve(): void {}

  disconnect(): void {}

  notify(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}

const ChatHarness = ({
  contentKey = "messages",
  metrics,
}: {
  contentKey?: unknown;
  metrics: ViewportMetrics;
}): JSX.Element => {
  const [draft, setDraft] = useState("");
  const newestMessageScroll = useNewestMessageScroll({
    resetKey: "session-1",
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
    createElement(
      "div",
      {
        "data-slot": "scroll-area-viewport",
        "data-testid": "conversation-viewport",
        ref: setViewport,
      },
      createElement(
        "div",
        null,
        createElement("div", { ref: newestMessageScroll.bottomRef }),
      ),
    ),
    createElement("textarea", {
      "aria-label": "Task composer",
      value: draft,
      onChange: handleDraftChange,
    }),
    createElement(
      "button",
      {
        type: "button",
        onClick: newestMessageScroll.scrollToNewest,
      },
      "Scroll to newest",
    ),
    createElement(
      "output",
      { "aria-label": "Scroll to newest visibility" },
      String(newestMessageScroll.showScrollToNewestButton),
    ),
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
      screen.getByRole("status", { name: "Scroll to newest visibility" })
        .textContent,
    ).toBe("true");

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
    fireEvent.click(screen.getByRole("button", { name: "Scroll to newest" }));

    expect(viewport.scrollTop).toBe(920);
  });
});
