import type { ProductGoal } from "@machdoch/fleet-protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGoalDraft } from "./use-goal-draft";

const savedGoal: ProductGoal = {
  id: "saved-goal",
  objective: "Fix auth",
  mode: "machdoch",
  status: "paused",
  turns: 1,
  tokensUsed: 10,
  elapsedMs: 1,
  reason: "",
  createdAt: 1,
  updatedAt: 1,
};

function renderDraft(sessionId = "first", goal: ProductGoal | null = null) {
  return renderHook(
    ({ sessionId, goal, enabled, running }) =>
      useGoalDraft(sessionId, goal, enabled, running),
    { initialProps: { sessionId, goal, enabled: false, running: false } },
  );
}

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("goal draft persistence", () => {
  it("debounces typing and restores the exact draft without enabling it", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const view = renderDraft();
    act(() => view.result.current.setObjective("Fix auth"));
    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(setItem).not.toHaveBeenCalled();

    const objective = "  Fix auth\nVerify sign-in  ";
    act(() => view.result.current.setObjective(objective));
    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(setItem).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(setItem).toHaveBeenCalledOnce();
    const persisted = localStorage.getItem("machdoch.goal-draft.first");
    expect(JSON.parse(persisted!).objective).toBe(objective);

    view.unmount();
    expect(setItem).toHaveBeenCalledOnce();
    const restored = renderDraft();
    expect(restored.result.current.objective).toBe(objective);
    expect(restored.result.current.submissionObjective).toBeUndefined();
    restored.rerender({
      sessionId: "first",
      goal: null,
      enabled: true,
      running: false,
    });
    expect(restored.result.current.submissionObjective).toBe(objective.trim());
  });

  it("flushes the previous chat before switching and keeps each draft separate", () => {
    const view = renderDraft();
    act(() => view.result.current.setObjective("First chat goal"));
    view.rerender({
      sessionId: "second",
      goal: null,
      enabled: false,
      running: false,
    });
    expect(view.result.current.objective).toBe("");
    expect(
      JSON.parse(localStorage.getItem("machdoch.goal-draft.first")!).objective,
    ).toBe("First chat goal");
    act(() => view.result.current.setObjective("Second chat goal"));
    view.rerender({
      sessionId: "first",
      goal: null,
      enabled: false,
      running: false,
    });
    expect(view.result.current.objective).toBe("First chat goal");
    view.unmount();
    expect(renderDraft("second").result.current.objective).toBe(
      "Second chat goal",
    );
  });

  it.each(["unmount", "pagehide", "hidden"])(
    "flushes pending typing on %s",
    (event) => {
      const view = renderDraft();
      act(() => view.result.current.setObjective("Unfinished goal"));
      expect(localStorage.getItem("machdoch.goal-draft.first")).toBeNull();

      if (event === "unmount") view.unmount();
      else if (event === "pagehide")
        act(() => {
          window.dispatchEvent(new Event("pagehide"));
        });
      else {
        vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
        act(() => {
          document.dispatchEvent(new Event("visibilitychange"));
        });
      }

      expect(
        JSON.parse(localStorage.getItem("machdoch.goal-draft.first")!)
          .objective,
      ).toBe("Unfinished goal");
      const setItem = vi.spyOn(Storage.prototype, "setItem");
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(setItem).not.toHaveBeenCalled();
    },
  );

  it("retains edits when only the saved goal status changes", () => {
    const view = renderDraft("first", savedGoal);
    act(() => view.result.current.setObjective("Fix auth and sign-out"));
    view.rerender({
      sessionId: "first",
      goal: { ...savedGoal, status: "blocked", updatedAt: 2 },
      enabled: false,
      running: false,
    });
    expect(view.result.current.objective).toBe("Fix auth and sign-out");
    act(() => {
      vi.advanceTimersByTime(500);
    });
    view.unmount();
    expect(renderDraft("first", savedGoal).result.current.objective).toBe(
      "Fix auth and sign-out",
    );
  });

  it.each(["replace", "clear", "change-objective"])(
    "discards obsolete edits when the saved goal changes: %s",
    (change) => {
      const view = renderDraft("first", savedGoal);
      act(() => view.result.current.setObjective("Old unsaved edit"));
      const goal =
        change === "clear"
          ? null
          : change === "replace"
            ? { ...savedGoal, id: "new-goal" }
            : { ...savedGoal, objective: "Verify auth" };
      view.rerender({
        sessionId: "first",
        goal,
        enabled: false,
        running: false,
      });
      expect(view.result.current.objective).toBe(goal?.objective ?? "");
      expect(localStorage.getItem("machdoch.goal-draft.first")).toBeNull();
      act(() => {
        vi.advanceTimersByTime(500);
      });
      view.unmount();
      expect(renderDraft("first", goal).result.current.objective).toBe(
        goal?.objective ?? "",
      );
    },
  );

  it("keeps an intentionally emptied draft instead of restoring the saved goal", () => {
    const view = renderDraft("first", savedGoal);
    act(() => view.result.current.setObjective(""));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    view.unmount();
    const restored = renderDraft("first", savedGoal);
    expect(restored.result.current.objective).toBe("");
    act(() => restored.result.current.setObjective(savedGoal.objective));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(localStorage.getItem("machdoch.goal-draft.first")).toBeNull();
  });

  it("removes an emptied draft for an unstarted goal", () => {
    const view = renderDraft();
    act(() => view.result.current.setObjective("Fix auth"));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    act(() => view.result.current.setObjective(""));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(localStorage.getItem("machdoch.goal-draft.first")).toBeNull();
    view.unmount();
    expect(renderDraft().result.current.objective).toBe("");
  });

  it("reports failed saves and retries when the goal is edited again", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("Storage full", "QuotaExceededError");
      });
    const view = renderDraft();
    act(() => view.result.current.setObjective("Fix auth"));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(view.result.current.objective).toBe("Fix auth");
    expect(view.result.current.error).toBe(
      "Could not save the goal draft; edit it to retry.",
    );
    expect(consoleError).toHaveBeenCalledOnce();
    setItem.mockRestore();
    act(() => view.result.current.setObjective("Fix auth and verify it"));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(view.result.current.error).toBeNull();
    view.unmount();
    expect(renderDraft().result.current.objective).toBe(
      "Fix auth and verify it",
    );
  });

  it.each([
    "invalid JSON",
    "null",
    JSON.stringify({ goalId: null, goalObjective: "", objective: 10 }),
    JSON.stringify({
      goalId: null,
      goalObjective: "",
      objective: "x".repeat(4_001),
    }),
  ])("reports invalid stored drafts", (raw) => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    localStorage.setItem("machdoch.goal-draft.first", raw);
    const view = renderDraft();
    expect(view.result.current.objective).toBe("");
    expect(view.result.current.error).toBe(
      "Could not restore the goal draft; enter it again.",
    );
    expect(consoleError).toHaveBeenCalledOnce();
    act(() => view.result.current.setObjective("Replacement goal"));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(view.result.current.error).toBeNull();
    view.unmount();
    expect(renderDraft().result.current.objective).toBe("Replacement goal");
  });
});
