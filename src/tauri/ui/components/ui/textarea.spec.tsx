import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Textarea } from "./textarea";

class ResizeObserverMock {
  observe(): void {}

  unobserve(): void {}

  disconnect(): void {}
}

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
});

describe("Textarea", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resizes as the user types more content", () => {
    let scrollHeight = 64;

    render(<Textarea aria-label="Composer" defaultValue="" />);

    const textarea = screen.getByRole("textbox", {
      name: "Composer",
    }) as HTMLTextAreaElement;

    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });

    fireEvent.change(textarea, {
      target: { value: "Summarize the latest changes." },
    });
    act(() => vi.runOnlyPendingTimers());

    expect(textarea.style.height).toBe("64px");

    scrollHeight = 128;

    fireEvent.change(textarea, {
      target: {
        value: [
          "Summarize the latest changes.",
          "Then call out anything risky.",
        ].join("\n"),
      },
    });
    act(() => vi.runOnlyPendingTimers());

    expect(textarea.style.height).toBe("128px");
  });

  it("recalculates its height when a controlled value changes", () => {
    let scrollHeight = 56;
    const { rerender } = render(
      <Textarea aria-label="Composer" value="" onChange={() => undefined} />,
    );

    const textarea = screen.getByRole("textbox", {
      name: "Composer",
    }) as HTMLTextAreaElement;

    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });

    scrollHeight = 104;

    rerender(
      <Textarea
        aria-label="Composer"
        value={"Review the current branch and list the key changes."}
        onChange={() => undefined}
      />,
    );
    act(() => vi.runOnlyPendingTimers());

    expect(textarea.style.height).toBe("104px");
  });
});
