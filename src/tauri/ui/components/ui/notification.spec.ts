import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppNotification } from "./notification.tsx";
import {
  resolveAppNotificationDismissMs,
  scheduleAppNotificationDismiss,
  type AppNotificationTone,
} from "./notification-lifecycle";

describe("AppNotification", () => {
  it.each<{
    tone: AppNotificationTone;
    role: string;
    title: string;
    dismissAfterMs: string;
  }>([
    {
      tone: "success",
      role: "status",
      title: "Done",
      dismissAfterMs: "4000",
    },
    {
      tone: "info",
      role: "status",
      title: "Notice",
      dismissAfterMs: "6000",
    },
    {
      tone: "warning",
      role: "status",
      title: "Attention",
      dismissAfterMs: "persistent",
    },
    {
      tone: "error",
      role: "alert",
      title: "Something went wrong",
      dismissAfterMs: "persistent",
    },
  ])(
    "renders the $tone variant with its shared semantics",
    ({ tone, role, title, dismissAfterMs }) => {
      const markup = renderToStaticMarkup(
        createElement(AppNotification, {
          tone,
          onDismiss: () => undefined,
          children: "Representative notification",
        }),
      );

      expect(markup).toContain(`role="${role}"`);
      expect(markup).toContain(`data-tone="${tone}"`);
      expect(markup).toContain(`data-dismiss-after-ms="${dismissAfterMs}"`);
      expect(markup).toContain(title);
      expect(markup).toContain("Representative notification");
    },
  );

  it("schedules and cleans up transient notifications", () => {
    const onDismiss = vi.fn();
    const clearTimer = vi.fn();
    let scheduledCallback = (): void => undefined;

    const cleanup = scheduleAppNotificationDismiss(
      onDismiss,
      resolveAppNotificationDismissMs("success"),
      (callback, timeoutMs) => {
        scheduledCallback = callback;
        expect(timeoutMs).toBe(4_000);
        return 17;
      },
      clearTimer,
    );

    scheduledCallback();
    expect(onDismiss).toHaveBeenCalledOnce();

    cleanup();
    expect(clearTimer).toHaveBeenCalledWith(17);
  });

  it("does not schedule intentionally persistent notifications", () => {
    const onDismiss = vi.fn();
    const setTimer = vi.fn(() => 1);
    const clearTimer = vi.fn();

    const cleanup = scheduleAppNotificationDismiss(
      onDismiss,
      resolveAppNotificationDismissMs("error"),
      setTimer,
      clearTimer,
    );

    expect(setTimer).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();

    cleanup();
    expect(clearTimer).not.toHaveBeenCalled();
  });

  it("allows an existing flow to override the default lifecycle", () => {
    expect(resolveAppNotificationDismissMs("error", 6_000)).toBe(6_000);
    expect(resolveAppNotificationDismissMs("success", null)).toBeNull();
  });
});
