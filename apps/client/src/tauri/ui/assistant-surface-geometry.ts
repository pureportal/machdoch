import type { Monitor } from "@tauri-apps/api/window";
import type { MonitorBoundsInput } from "./runtime";

export const ASSISTANT_BUBBLE_DIMENSIONS = { width: 128, height: 104 } as const;
export const ASSISTANT_POPUP_DIMENSIONS = {
  width: 448,
  height: 720,
  minHeight: 420,
} as const;
export const QUICK_VOICE_DIMENSIONS = { width: 380, height: 220 } as const;

export interface AssistantSurfaceLayout {
  monitorBounds: MonitorBoundsInput;
  workArea: MonitorBoundsInput;
  bubbleSize: { width: number; height: number };
  bubblePosition: { x: number; y: number };
  popupSize: { width: number; height: number };
  popupPosition: { x: number; y: number };
  quickVoiceSize: { width: number; height: number };
  quickVoicePosition: { x: number; y: number };
}

const validRect = (
  position: { x: number; y: number },
  size: { width: number; height: number },
): boolean =>
  [position.x, position.y, size.width, size.height].every(Number.isFinite) &&
  size.width >= 1 &&
  size.height >= 1;

export const clampSurfacePosition = (
  position: { x: number; y: number },
  size: { width: number; height: number },
  area: MonitorBoundsInput,
): { x: number; y: number } => ({
  x: Math.round(
    Math.max(
      area.x,
      Math.min(
        Number.isFinite(position.x) ? position.x : area.x,
        area.x + area.width - size.width,
      ),
    ),
  ),
  y: Math.round(
    Math.max(
      area.y,
      Math.min(
        Number.isFinite(position.y) ? position.y : area.y,
        area.y + area.height - size.height,
      ),
    ),
  ),
});

export const computeAssistantSurfaceLayout = (
  monitor: Monitor,
): AssistantSurfaceLayout | null => {
  if (!validRect(monitor.position, monitor.size)) return null;
  let work: {
    position: { x: number; y: number };
    size: { width: number; height: number };
  } = monitor;
  if (validRect(monitor.workArea.position, monitor.workArea.size)) {
    const x = Math.max(monitor.position.x, monitor.workArea.position.x);
    const y = Math.max(monitor.position.y, monitor.workArea.position.y);
    const width =
      Math.min(
        monitor.position.x + monitor.size.width,
        monitor.workArea.position.x + monitor.workArea.size.width,
      ) - x;
    const height =
      Math.min(
        monitor.position.y + monitor.size.height,
        monitor.workArea.position.y + monitor.workArea.size.height,
      ) - y;
    if (width >= 1 && height >= 1)
      work = { position: { x, y }, size: { width, height } };
  }
  const scale =
    Number.isFinite(monitor.scaleFactor) && monitor.scaleFactor > 0
      ? monitor.scaleFactor
      : 1;
  const px = (value: number): number => Math.max(1, Math.round(value * scale));
  const margin = Math.max(
    0,
    Math.min(
      px(24),
      Math.floor((Math.min(work.size.width, work.size.height) - 1) / 2),
    ),
  );
  const area = {
    x: work.position.x + margin,
    y: work.position.y + margin,
    width: Math.floor(work.size.width - margin * 2),
    height: Math.floor(work.size.height - margin * 2),
  };
  const fit = (size: { width: number; height: number }) => ({
    width: Math.min(px(size.width), area.width),
    height: Math.min(px(size.height), area.height),
  });
  const bottomRight = (size: { width: number; height: number }) => ({
    x: area.x + area.width - size.width,
    y: area.y + area.height - size.height,
  });
  const bubbleSize = fit(ASSISTANT_BUBBLE_DIMENSIONS);
  const bubblePosition = bottomRight(bubbleSize);
  const popupSize = fit(ASSISTANT_POPUP_DIMENSIONS);
  const heightAbove = bubblePosition.y - area.y - px(16);
  // Prefer space above the bubble, but use the full work area on compact displays.
  // A preferred minimum can never override the physical space that actually exists.
  if (heightAbove >= px(ASSISTANT_POPUP_DIMENSIONS.minHeight))
    popupSize.height = Math.min(popupSize.height, heightAbove);
  const popupPosition = clampSurfacePosition(
    {
      x: area.x + area.width - popupSize.width,
      y: bubblePosition.y - px(16) - popupSize.height,
    },
    popupSize,
    area,
  );
  const quickVoiceSize = fit(QUICK_VOICE_DIMENSIONS);
  return {
    monitorBounds: {
      x: monitor.position.x,
      y: monitor.position.y,
      width: monitor.size.width,
      height: monitor.size.height,
    },
    workArea: {
      x: work.position.x,
      y: work.position.y,
      width: work.size.width,
      height: work.size.height,
    },
    bubbleSize,
    bubblePosition,
    popupSize,
    popupPosition,
    quickVoiceSize,
    quickVoicePosition: bottomRight(quickVoiceSize),
  };
};
