export interface UpdateNotificationPreference {
  skippedVersion?: string;
  remindAfter?: number;
}

export function normalizeUpdateNotificationPreference(
  value: unknown,
): UpdateNotificationPreference {
  if (!value || typeof value !== "object") return {};
  const preference = value as Record<string, unknown>;
  return {
    ...(typeof preference.skippedVersion === "string"
      ? { skippedVersion: preference.skippedVersion }
      : {}),
    ...(typeof preference.remindAfter === "number" &&
    Number.isSafeInteger(preference.remindAfter) &&
    preference.remindAfter > 0
      ? { remindAfter: preference.remindAfter }
      : {}),
  };
}

export function shouldNotifyForUpdate(
  version: string,
  preference: UpdateNotificationPreference,
  now: number,
): boolean {
  return (
    preference.skippedVersion !== version &&
    (!preference.remindAfter || preference.remindAfter <= now)
  );
}

export function deferUpdateNotification(
  version: string,
  duration: "hour" | "day" | "week" | "release",
  now: number,
): UpdateNotificationPreference {
  if (duration === "release") return { skippedVersion: version };
  const hours = { hour: 1, day: 24, week: 168 }[duration];
  return { remindAfter: now + hours * 60 * 60_000 };
}
