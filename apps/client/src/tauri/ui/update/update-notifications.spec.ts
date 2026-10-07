import { describe, expect, it } from "vitest";
import {
  deferUpdateNotification,
  normalizeUpdateNotificationPreference,
  shouldNotifyForUpdate,
} from "./update-notifications";

describe("update notification preferences", () => {
  it.each(["hour", "day", "week"] as const)(
    "silences notifications until the %s reminder expires",
    (duration) => {
      const preference = deferUpdateNotification("2.0.0", duration, 1000);
      expect(
        shouldNotifyForUpdate("2.0.0", preference, preference.remindAfter! - 1),
      ).toBe(false);
      expect(
        shouldNotifyForUpdate("2.0.0", preference, preference.remindAfter!),
      ).toBe(true);
      expect(shouldNotifyForUpdate("3.0.0", preference, 1001)).toBe(false);
    },
  );

  it("suppresses exactly one release, including across restarts", () => {
    const preference = normalizeUpdateNotificationPreference(
      JSON.parse(
        JSON.stringify(deferUpdateNotification("2.0.0", "release", 1000)),
      ),
    );
    expect(shouldNotifyForUpdate("2.0.0", preference, 1_000_000)).toBe(false);
    expect(shouldNotifyForUpdate("2.0.1", preference, 1_000_000)).toBe(true);
  });

  it("does not silence notifications with malformed timestamps", () => {
    for (const value of [
      null,
      {},
      { remindAfter: "never" },
      { remindAfter: Infinity },
      { remindAfter: -1 },
    ]) {
      expect(
        shouldNotifyForUpdate(
          "2.0.0",
          normalizeUpdateNotificationPreference(value),
          1000,
        ),
      ).toBe(true);
    }
  });
});
