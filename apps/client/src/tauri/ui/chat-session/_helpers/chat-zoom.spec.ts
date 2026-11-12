import { describe, expect, it } from "vitest";
import {
  accumulateChatZoomWheel,
  getZoomAnchoredScrollTop,
  stepChatZoomPercent,
} from "./chat-zoom";

describe("Chat zoom", () => {
  it("steps in ten percent increments within the supported range", () => {
    expect(stepChatZoomPercent(100, 1)).toBe(110);
    expect(stepChatZoomPercent(100, -1)).toBe(90);
    expect(stepChatZoomPercent(200, 1)).toBe(200);
    expect(stepChatZoomPercent(50, -1)).toBe(50);
  });

  it("zooms in on upward wheel movement and out on downward movement", () => {
    expect(accumulateChatZoomWheel(0, { deltaY: -100, deltaMode: 0 })).toEqual({
      distance: 0,
      direction: 1,
    });
    expect(accumulateChatZoomWheel(0, { deltaY: 100, deltaMode: 0 })).toEqual({
      distance: 0,
      direction: -1,
    });
  });

  it("applies one step per wheel notch regardless of its size", () => {
    expect(
      accumulateChatZoomWheel(0, { deltaY: -480, deltaMode: 0 }).direction,
    ).toBe(1);
    expect(accumulateChatZoomWheel(0, { deltaY: 3, deltaMode: 1 })).toEqual({
      distance: 0,
      direction: -1,
    });
  });

  it("accumulates small wheel deltas until they reach one step", () => {
    const first = accumulateChatZoomWheel(0, { deltaY: -15, deltaMode: 0 });
    expect(first).toEqual({ distance: -15, direction: null });
    const second = accumulateChatZoomWheel(first.distance, {
      deltaY: -15,
      deltaMode: 0,
    });
    expect(second).toEqual({ distance: -30, direction: null });
    expect(
      accumulateChatZoomWheel(second.distance, { deltaY: -15, deltaMode: 0 }),
    ).toEqual({ distance: 0, direction: 1 });
  });

  it("restarts accumulation when the wheel direction reverses", () => {
    expect(accumulateChatZoomWheel(-30, { deltaY: 20, deltaMode: 0 })).toEqual({
      distance: 20,
      direction: null,
    });
    expect(accumulateChatZoomWheel(-30, { deltaY: 0, deltaMode: 0 })).toEqual({
      distance: -30,
      direction: null,
    });
  });

  it("keeps the newest message visible when the chat was scrolled to the bottom", () => {
    expect(
      getZoomAnchoredScrollTop(
        { scrollTop: 600, scrollHeight: 1_000, clientHeight: 400 },
        1_500,
        120,
      ),
    ).toBe(1_100);
  });

  it("keeps the content under the anchor in place while zooming", () => {
    expect(
      getZoomAnchoredScrollTop(
        { scrollTop: 200, scrollHeight: 1_000, clientHeight: 400 },
        2_000,
        100,
      ),
    ).toBe(500);
    expect(
      getZoomAnchoredScrollTop(
        { scrollTop: 400, scrollHeight: 2_000, clientHeight: 400 },
        1_000,
        0,
      ),
    ).toBe(200);
  });

  it("clamps anchored positions to the scrollable range", () => {
    expect(
      getZoomAnchoredScrollTop(
        { scrollTop: 0, scrollHeight: 1_000, clientHeight: 400 },
        500,
        300,
      ),
    ).toBe(0);
    expect(
      getZoomAnchoredScrollTop(
        { scrollTop: 500, scrollHeight: 1_000, clientHeight: 400 },
        600,
        0,
      ),
    ).toBe(200);
  });
});
