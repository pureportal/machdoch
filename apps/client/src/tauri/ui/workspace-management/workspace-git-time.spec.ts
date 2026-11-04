import { describe, expect, it } from "vitest";
import { formatWorkspaceGitTime } from "./workspace-git-time";

describe("workspace Git time", () => {
  const now = Date.parse("2026-08-10T12:00:00Z");

  it("formats relative times with the largest whole unit", () => {
    const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
    expect(formatWorkspaceGitTime("2026-08-10T11:59:40Z", now)).toBe(
      format.format(0, "minute"),
    );
    expect(formatWorkspaceGitTime("2026-08-10T09:00:00Z", now)).toBe(
      format.format(-3, "hour"),
    );
    expect(formatWorkspaceGitTime("2026-07-27T12:00:00Z", now)).toBe(
      format.format(-2, "week"),
    );
  });

  it("keeps unparseable values unchanged", () => {
    expect(formatWorkspaceGitTime("unknown", now)).toBe("unknown");
  });
});
