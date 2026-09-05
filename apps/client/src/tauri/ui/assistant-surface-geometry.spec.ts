import { describe, expect, it } from "vitest";
import {
  PhysicalPosition,
  PhysicalSize,
  type Monitor,
} from "@tauri-apps/api/window";
import {
  clampSurfacePosition,
  computeAssistantSurfaceLayout,
} from "./assistant-surface-geometry";

const monitor = (
  width: number,
  height: number,
  scaleFactor: number,
  x = 0,
  y = 0,
): Monitor => ({
  name: "test",
  position: new PhysicalPosition(x, y),
  size: new PhysicalSize(width, height),
  scaleFactor,
  workArea: {
    position: new PhysicalPosition(x, y + 40),
    size: new PhysicalSize(width, Math.max(1, height - 40)),
  },
});

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
    "contains every surface on %s × %s at scale %s",
    (width, height, scale) => {
      const screen = monitor(width, height, scale, -1920, -1000);
      const layout = computeAssistantSurfaceLayout(screen)!;
      for (const [position, size] of [
        [layout.bubblePosition, layout.bubbleSize],
        [layout.popupPosition, layout.popupSize],
        [layout.quickVoicePosition, layout.quickVoiceSize],
      ] as const) {
        expect(size.width).toBeGreaterThan(0);
        expect(size.height).toBeGreaterThan(0);
        expect(position.x).toBeGreaterThanOrEqual(layout.workArea.x);
        expect(position.y).toBeGreaterThanOrEqual(layout.workArea.y);
        expect(position.x + size.width).toBeLessThanOrEqual(
          layout.workArea.x + layout.workArea.width,
        );
        expect(position.y + size.height).toBeLessThanOrEqual(
          layout.workArea.y + layout.workArea.height,
        );
      }
    },
  );

  it("uses the full available height when the preferred minimum cannot fit above the bubble", () => {
    const layout = computeAssistantSurfaceLayout(monitor(800, 600, 2))!;
    expect(layout.popupSize).toEqual({ width: 704, height: 464 });
    expect(layout.popupPosition).toEqual({ x: 48, y: 88 });
  });

  it("retains preferred physical dimensions and the bubble gap when there is room", () => {
    const layout = computeAssistantSurfaceLayout(monitor(3840, 2160, 1.5))!;
    expect(layout.popupSize).toEqual({ width: 672, height: 1080 });
    expect(layout.popupPosition.y + layout.popupSize.height + 24).toBe(
      layout.bubblePosition.y,
    );
    expect(layout.quickVoiceSize).toEqual({ width: 570, height: 330 });
  });

  it("rejects empty displays and handles invalid work areas and DPI during reconfiguration", () => {
    expect(computeAssistantSurfaceLayout(monitor(0, 1080, 1))).toBeNull();
    const screen = monitor(1920, 1080, Number.NaN);
    screen.workArea.size = new PhysicalSize(0, 0);
    const layout = computeAssistantSurfaceLayout(screen)!;
    expect(layout.workArea).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(layout.bubbleSize).toEqual({ width: 128, height: 104 });
    expect(
      computeAssistantSurfaceLayout({ ...screen, scaleFactor: -1 }),
    ).toEqual(layout);
  });

  it("clamps stale explicit positions without treating negative desktop coordinates as invalid", () => {
    const area = { x: -1920, y: -100, width: 1920, height: 1080 };
    expect(
      clampSurfacePosition(
        { x: 5000, y: -2000 },
        { width: 448, height: 720 },
        area,
      ),
    ).toEqual({ x: -448, y: -100 });
    expect(
      clampSurfacePosition(
        { x: -1600, y: 20 },
        { width: 448, height: 720 },
        area,
      ),
    ).toEqual({ x: -1600, y: 20 });
  });
});
