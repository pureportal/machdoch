import { expect, it } from "vitest";
import { selectFleetSessionWindow } from "./fleet-session-window";

it("includes the active historical session within the bounded published window", () => {
  const sessions = Array.from({ length: 100 }, (_, index) => ({ id: `session-${index}` }));
  const selected = selectFleetSessionWindow(sessions, "session-99", 80);
  expect(selected).toHaveLength(80);
  expect(selected[0]).toBe(sessions[0]);
  expect(selected[79]).toBe(sessions[99]);
  expect(sessions).toHaveLength(100);
  expect(sessions[79]!.id).toBe("session-79");
});

it("preserves attention order when the active session is already in the window", () => {
  const sessions = [{ id: "quick" }, { id: "active" }, { id: "other" }];
  expect(selectFleetSessionWindow(sessions, "active", 2)).toEqual(sessions.slice(0, 2));
});
