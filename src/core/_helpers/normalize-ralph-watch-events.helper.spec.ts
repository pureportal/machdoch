import { normalizeRalphWatchEvents } from "./normalize-ralph-watch-events.helper.ts";
import type { RalphWatchEventType } from "../ralph-watches.ts";

describe("normalizeRalphWatchEvents", () => {
  it("defaults to created and changed when events are omitted or empty", () => {
    expect(normalizeRalphWatchEvents(undefined)).toEqual(["created", "changed"]);
    expect(normalizeRalphWatchEvents([])).toEqual(["created", "changed"]);
  });

  it("deduplicates valid event types while preserving order", () => {
    expect(
      normalizeRalphWatchEvents(["deleted", "changed", "deleted", "renamed"]),
    ).toEqual(["deleted", "changed", "renamed"]);
  });

  it("rejects event lists without a supported event type", () => {
    expect(() =>
      normalizeRalphWatchEvents(["invalid"] as RalphWatchEventType[]),
    ).toThrow("Expected Ralph watch to include at least one event type.");
  });
});
