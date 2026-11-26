import { describe, expect, it } from "vitest";
import { inboxKinds } from "./cloud-inbox-contract";
import {
  chatWebhookAllowed,
  deliveryHold,
  localMinutes,
  notificationEventGroups,
  notificationPreferenceMatrix,
  notificationScheduleSchema,
  pushEndpointAllowed,
} from "./notification-preferences";

describe("notification preferences", () => {
  it("groups every notification event exactly once", () => {
    const grouped = notificationEventGroups.flatMap((group) => group.kinds);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual([...inboxKinds].sort());
  });

  it("applies overrides on top of per-event channel defaults", () => {
    const matrix = notificationPreferenceMatrix([
      { kind: "commented", channel: "email", enabled: true },
      { kind: "assigned", channel: "in_app", enabled: false },
    ]);
    expect(matrix.assigned).toEqual({
      in_app: false,
      email: true,
      chat: false,
      mobile: true,
    });
    expect(matrix.commented).toEqual({
      in_app: true,
      email: true,
      chat: false,
      mobile: false,
    });
    expect(matrix.status_changed.email).toBe(false);
  });

  it("reads local time in the recipient's time zone", () => {
    const at = new Date("2026-01-15T22:30:00Z");
    expect(localMinutes(at, "UTC")).toBe(22 * 60 + 30);
    expect(localMinutes(at, "Europe/Berlin")).toBe(23 * 60 + 30);
    expect(localMinutes(at, "America/New_York")).toBe(17 * 60 + 30);
  });

  it("holds deliveries during overnight quiet hours until they end", () => {
    const schedule = {
      snoozedUntil: null,
      quietHours: { start: 22 * 60, end: 7 * 60 },
      timeZone: "Europe/Berlin",
    };
    expect(
      deliveryHold(new Date("2026-01-15T22:30:00Z"), schedule)?.toISOString(),
    ).toBe("2026-01-16T06:00:00.000Z");
    expect(
      deliveryHold(new Date("2026-01-16T05:15:20Z"), schedule)?.toISOString(),
    ).toBe("2026-01-16T06:00:00.000Z");
    expect(deliveryHold(new Date("2026-01-16T12:00:00Z"), schedule)).toBeNull();
  });

  it("holds deliveries while snoozed and then respects quiet hours", () => {
    const at = new Date("2026-01-15T12:00:00Z");
    expect(
      deliveryHold(at, {
        snoozedUntil: "2026-01-15T14:00:00Z",
        quietHours: null,
        timeZone: "UTC",
      })?.toISOString(),
    ).toBe("2026-01-15T14:00:00.000Z");
    expect(
      deliveryHold(at, {
        snoozedUntil: "2026-01-15T23:00:00Z",
        quietHours: { start: 22 * 60, end: 6 * 60 },
        timeZone: "UTC",
      })?.toISOString(),
    ).toBe("2026-01-16T06:00:00.000Z");
    expect(
      deliveryHold(at, {
        snoozedUntil: "2026-01-15T11:00:00Z",
        quietHours: null,
        timeZone: "UTC",
      }),
    ).toBeNull();
  });

  it("validates schedules and restricts outbound targets to known services", () => {
    expect(
      notificationScheduleSchema.safeParse({
        snoozedUntil: null,
        quietHours: { start: 60, end: 60 },
        timeZone: "UTC",
      }).success,
    ).toBe(false);
    expect(
      notificationScheduleSchema.safeParse({
        snoozedUntil: null,
        quietHours: null,
        timeZone: "Mars/Olympus",
      }).success,
    ).toBe(false);
    expect(chatWebhookAllowed("https://hooks.slack.com/services/T/B/x")).toBe(
      true,
    );
    expect(
      chatWebhookAllowed("https://acme.webhook.office.com/webhookb2/x"),
    ).toBe(true);
    expect(chatWebhookAllowed("http://hooks.slack.com/services/x")).toBe(false);
    expect(chatWebhookAllowed("https://169.254.169.254/latest")).toBe(false);
    expect(pushEndpointAllowed("https://fcm.googleapis.com/fcm/send/x")).toBe(
      true,
    );
    expect(pushEndpointAllowed("https://internal.example/push")).toBe(false);
  });
});
