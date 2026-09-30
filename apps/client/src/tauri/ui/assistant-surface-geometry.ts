import type { Monitor } from "@tauri-apps/api/window";

export const QUICK_VOICE_DIMENSIONS = { width: 380, height: 220 } as const;

export interface AssistantSurfaceLayout {
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
  const quickVoiceSize = {
    width: Math.min(px(QUICK_VOICE_DIMENSIONS.width), area.width),
    height: Math.min(px(QUICK_VOICE_DIMENSIONS.height), area.height),
  };
  return {
    quickVoiceSize,
    quickVoicePosition: {
      x: area.x + area.width - quickVoiceSize.width,
      y: area.y + area.height - quickVoiceSize.height,
    },
  };
};
