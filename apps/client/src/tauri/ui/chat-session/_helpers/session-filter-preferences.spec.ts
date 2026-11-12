import { describe, expect, it } from "vitest";
import {
  DEFAULT_SESSION_FILTER_PREFERENCES,
  parseSessionFilterPreferences,
} from "./session-filter-preferences";

describe("session filter preferences", () => {
  it("restores stored filters", () => {
    const preferences = {
      scope: "archived",
      status: ["unread", "failed"],
      projectFilter: { mode: "exclude", projectIds: ["alpha", "beta"] },
      tags: ["release", "bug"],
    };

    expect(parseSessionFilterPreferences(JSON.stringify(preferences))).toEqual(
      preferences,
    );
  });

  it("uses defaults for missing or malformed data", () => {
    expect(parseSessionFilterPreferences(null)).toEqual(
      DEFAULT_SESSION_FILTER_PREFERENCES,
    );
    expect(parseSessionFilterPreferences("{")).toEqual(
      DEFAULT_SESSION_FILTER_PREFERENCES,
    );
    expect(parseSessionFilterPreferences("[]")).toEqual(
      DEFAULT_SESSION_FILTER_PREFERENCES,
    );
  });

  it("drops unknown values", () => {
    expect(
      parseSessionFilterPreferences(
        JSON.stringify({
          scope: "deleted",
          status: ["unread", "unknown", "unread", 4],
          projectFilter: { mode: "maybe", projectIds: ["alpha", "", null] },
          tags: "release",
        }),
      ),
    ).toEqual({
      scope: "open",
      status: ["unread"],
      projectFilter: { mode: "include", projectIds: ["alpha"] },
      tags: [],
    });
  });

  it("falls back to any status when no known status remains", () => {
    expect(
      parseSessionFilterPreferences(JSON.stringify({ status: ["unknown"] }))
        .status,
    ).toEqual(["any"]);
  });
});
