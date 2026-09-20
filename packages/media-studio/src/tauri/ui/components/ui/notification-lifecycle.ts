export type AppNotificationTone = "success" | "warning" | "error" | "info";

export const APP_NOTIFICATION_DISMISS_MS: Readonly<
  Record<AppNotificationTone, number | null>
> = {
  success: 4_000,
  info: 6_000,
  warning: null,
  error: null,
};

export const resolveAppNotificationDismissMs = (
  tone: AppNotificationTone,
  dismissAfterMs?: number | null,
): number | null =>
  dismissAfterMs === undefined
    ? APP_NOTIFICATION_DISMISS_MS[tone]
    : dismissAfterMs;

type SetNotificationTimeout = (
  callback: () => void,
  timeoutMs: number,
) => number;

type ClearNotificationTimeout = (timeoutId: number) => void;

export const scheduleAppNotificationDismiss = (
  onDismiss: () => void,
  dismissAfterMs: number | null,
  setTimer: SetNotificationTimeout = (callback, timeoutMs) =>
    window.setTimeout(callback, timeoutMs),
  clearTimer: ClearNotificationTimeout = (timeoutId) =>
    window.clearTimeout(timeoutId),
): (() => void) => {
  if (dismissAfterMs === null) {
    return () => undefined;
  }

  const timeoutId = setTimer(onDismiss, dismissAfterMs);
  return () => clearTimer(timeoutId);
};
