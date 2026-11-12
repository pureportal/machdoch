import {
  CHAT_ZOOM_STEP_PERCENT,
  normalizeChatZoomPercent,
} from "../../lib/_helpers/shell-store-normalizers.helper";

export type ChatZoomDirection = 1 | -1;

export interface ChatZoomWheelInput {
  deltaY: number;
  deltaMode: number;
}

export interface ChatZoomWheelResult {
  distance: number;
  direction: ChatZoomDirection | null;
}

export interface ChatZoomScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

const WHEEL_DELTA_MODE_LINE = 1;
const WHEEL_DELTA_MODE_PAGE = 2;
const WHEEL_STEP_DISTANCE_PX = 40;
const WHEEL_LINE_HEIGHT_PX = 16;
const WHEEL_PAGE_HEIGHT_PX = 800;
const SCROLL_BOTTOM_THRESHOLD_PX = 8;

export const stepChatZoomPercent = (
  zoomPercent: number,
  direction: ChatZoomDirection,
): number =>
  normalizeChatZoomPercent(zoomPercent + direction * CHAT_ZOOM_STEP_PERCENT);

const getWheelDistancePx = ({ deltaY, deltaMode }: ChatZoomWheelInput) =>
  deltaMode === WHEEL_DELTA_MODE_LINE
    ? deltaY * WHEEL_LINE_HEIGHT_PX
    : deltaMode === WHEEL_DELTA_MODE_PAGE
      ? deltaY * WHEEL_PAGE_HEIGHT_PX
      : deltaY;

export const accumulateChatZoomWheel = (
  accumulatedDistance: number,
  wheel: ChatZoomWheelInput,
): ChatZoomWheelResult => {
  const delta = getWheelDistancePx(wheel);

  if (delta === 0) {
    return { distance: accumulatedDistance, direction: null };
  }

  const distance =
    Math.sign(delta) === Math.sign(accumulatedDistance)
      ? accumulatedDistance + delta
      : delta;

  if (Math.abs(distance) < WHEEL_STEP_DISTANCE_PX) {
    return { distance, direction: null };
  }

  return { distance: 0, direction: distance < 0 ? 1 : -1 };
};

export const getZoomAnchoredScrollTop = (
  previous: ChatZoomScrollMetrics,
  nextScrollHeight: number,
  anchorOffset: number,
): number => {
  const maxScrollTop = Math.max(0, nextScrollHeight - previous.clientHeight);
  const previousDistanceToBottom =
    previous.scrollHeight - previous.scrollTop - previous.clientHeight;

  if (previousDistanceToBottom <= SCROLL_BOTTOM_THRESHOLD_PX) {
    return maxScrollTop;
  }

  const scale =
    previous.scrollHeight > 0 ? nextScrollHeight / previous.scrollHeight : 1;
  const anchoredScrollTop =
    (previous.scrollTop + anchorOffset) * scale - anchorOffset;

  return Math.min(maxScrollTop, Math.max(0, anchoredScrollTop));
};
