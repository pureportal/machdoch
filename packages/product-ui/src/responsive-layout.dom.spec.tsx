import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useProductViewport } from "./responsive-layout";

function Viewport() {
  useProductViewport();
  return null;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("style");
});

function viewportFixture() {
  vi.useFakeTimers();
  const viewport = Object.assign(new EventTarget(), {
    height: 360,
    offsetTop: 40,
    scale: 1,
  });
  vi.stubGlobal("visualViewport", viewport);
  return viewport;
}

describe("visible product viewport", () => {
  it("shares keyboard height and pan with portal dialogs and restores the previous styles", async () => {
    const viewport = viewportFixture();
    const style = document.documentElement.style;
    style.setProperty("--m-viewport-height", "900px");
    const { unmount } = render(<Viewport />);
    await act(async () => vi.advanceTimersByTime(20));
    expect(style.getPropertyValue("--m-viewport-height")).toBe("360px");
    expect(style.getPropertyValue("--m-viewport-offset-top")).toBe("40px");
    viewport.height = 844;
    viewport.offsetTop = 0;
    viewport.dispatchEvent(new Event("resize"));
    await act(async () => vi.advanceTimersByTime(20));
    expect(style.getPropertyValue("--m-viewport-height")).toBe("844px");
    expect(style.getPropertyValue("--m-viewport-offset-top")).toBe("0px");
    unmount();
    expect(style.getPropertyValue("--m-viewport-height")).toBe("900px");
    expect(style.getPropertyValue("--m-viewport-offset-top")).toBe("");
    viewport.height = 300;
    viewport.dispatchEvent(new Event("resize"));
    await act(async () => vi.advanceTimersByTime(20));
    expect(style.getPropertyValue("--m-viewport-height")).toBe("900px");
  });

  it("does not reflow the application when the user pinches to zoom", async () => {
    const viewport = viewportFixture();
    render(<Viewport />);
    await act(async () => vi.advanceTimersByTime(20));
    viewport.scale = 2;
    viewport.height = 180;
    viewport.offsetTop = 70;
    viewport.dispatchEvent(new Event("resize"));
    await act(async () => vi.advanceTimersByTime(20));
    expect(
      document.documentElement.style.getPropertyValue("--m-viewport-height"),
    ).toBe("360px");
    expect(
      document.documentElement.style.getPropertyValue(
        "--m-viewport-offset-top",
      ),
    ).toBe("40px");
  });
});
