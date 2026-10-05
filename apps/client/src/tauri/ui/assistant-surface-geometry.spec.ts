import { describe, expect, it } from "vitest";
import {
  PhysicalPosition,
  PhysicalSize,
  type Monitor,
} from "@tauri-apps/api/window";
import { computeAssistantSurfaceLayout } from "./assistant-surface-geometry";

const monitor = (
  width: number,
  height: number,
  scaleFactor: number,
  x = 0,
  y = 0,
): Monitor => {
  const topInset = Math.min(40, Math.max(0, height - 1));
  return {
    name: "test",
    position: new PhysicalPosition(x, y),
    size: new PhysicalSize(width, height),
    scaleFactor,
    workArea: {
      position: new PhysicalPosition(x, y + topInset),
      size: new PhysicalSize(width, height - topInset),
    },
  };
};

describe("assistant surface geometry", () => {
  it.each([
    [1920, 1080, 1],
    [1920, 1080, 2],
    [1280, 720, 1.5],
    [800, 600, 2],
    [320, 200, 1],
    [1080, 1920, 1.25],
    [1, 1, 1],
  ])(
    "contains Quick Voice on %s × %s at scale %s",
    (width, height, scale) => {
      const screen = monitor(width, height, scale, -1920, -1000);
      const layout = computeAssistantSurfaceLayout(screen)!;
      const position = layout.quickVoicePosition;
      const size = layout.quickVoiceSize;
      const area = screen.workArea;

      expect(size.width).toBeGreaterThan(0);
      expect(size.height).toBeGreaterThan(0);
      expect(position.x).toBeGreaterThanOrEqual(area.position.x);
      expect(position.y).toBeGreaterThanOrEqual(area.position.y);
      expect(position.x + size.width).toBeLessThanOrEqual(
        area.position.x + area.size.width,
      );
      expect(position.y + size.height).toBeLessThanOrEqual(
        area.position.y + area.size.height,
      );
    },
  );

  it("fits Quick Voice within a small work area at high DPI", () => {
    expect(computeAssistantSurfaceLayout(monitor(800, 600, 2))).toEqual({
      quickVoiceSize: { width: 704, height: 440 },
      quickVoicePosition: { x: 48, y: 112 },
    });
  });

  it("retains preferred physical dimensions and the bottom-right margin when there is room", () => {
    expect(computeAssistantSurfaceLayout(monitor(3840, 2160, 1.5))).toEqual({
      quickVoiceSize: { width: 570, height: 330 },
      quickVoicePosition: { x: 3234, y: 1794 },
    });
  });

  it.each([
    monitor(0, 1080, 1),
    monitor(1920, -1, 1),
    monitor(Number.NaN, 1080, 1),
    monitor(1920, 1080, 1, Number.POSITIVE_INFINITY),
  ])("rejects invalid monitor bounds", (screen) => {
    expect(computeAssistantSurfaceLayout(screen)).toBeNull();
  });

  it("uses monitor bounds when the work area is invalid and default dimensions when DPI is invalid", () => {
    const screen = monitor(1920, 1080, Number.NaN);
    screen.workArea.size = new PhysicalSize(0, 0);
    const layout = computeAssistantSurfaceLayout(screen);

    expect(layout).toEqual({
      quickVoiceSize: { width: 380, height: 220 },
      quickVoicePosition: { x: 1516, y: 836 },
    });
    expect(
      computeAssistantSurfaceLayout({ ...screen, scaleFactor: -1 }),
    ).toEqual(layout);
  });

  it("clips work areas that extend beyond their monitor", () => {
    const screen = monitor(1920, 1080, 1);
    screen.workArea = {
      position: new PhysicalPosition(-100, -50),
      size: new PhysicalSize(1000, 800),
    };

    expect(computeAssistantSurfaceLayout(screen)).toEqual({
      quickVoiceSize: { width: 380, height: 220 },
      quickVoicePosition: { x: 496, y: 506 },
    });
  });

  it("uses monitor bounds when the work area no longer intersects its monitor", () => {
    const screen = monitor(1920, 1080, 1, -1920, -100);
    screen.workArea.position = new PhysicalPosition(5000, 5000);

    expect(computeAssistantSurfaceLayout(screen)).toEqual({
      quickVoiceSize: { width: 380, height: 220 },
      quickVoicePosition: { x: -404, y: 736 },
    });
  });
});
