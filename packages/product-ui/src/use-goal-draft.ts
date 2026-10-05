import type { ProductGoal } from "@machdoch/fleet-protocol";
import { useCallback, useEffect, useRef, useState } from "react";

interface SavedGoalDraft {
  goalId: string | null;
  goalObjective: string;
  objective: string;
}

function parseGoalDraft(raw: string): SavedGoalDraft {
  const draft: unknown = JSON.parse(raw);
  if (
    !draft ||
    typeof draft !== "object" ||
    !("goalId" in draft) ||
    !(draft.goalId === null || typeof draft.goalId === "string") ||
    !("goalObjective" in draft) ||
    typeof draft.goalObjective !== "string" ||
    !("objective" in draft) ||
    typeof draft.objective !== "string" ||
    draft.objective.length > 4_000
  ) {
    throw new Error("Invalid saved goal draft");
  }
  return {
    goalId: draft.goalId,
    goalObjective: draft.goalObjective,
    objective: draft.objective,
  };
}

export function useGoalDraft(
  sessionId: string,
  goal: ProductGoal | null | undefined,
  enabled: boolean,
  running: boolean,
) {
  const goalId = goal?.id ?? null;
  const goalObjective = goal?.objective ?? "";
  const storageKey = `machdoch.goal-draft.${sessionId}`;
  const [objective, setObjectiveState] = useState(goalObjective);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = useRef<{
    storageKey: string;
    draft: SavedGoalDraft;
  } | null>(null);

  const flush = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    const pending = pendingSaveRef.current;
    if (!pending) return;
    pendingSaveRef.current = null;

    try {
      if (pending.draft.objective === pending.draft.goalObjective) {
        window.localStorage.removeItem(pending.storageKey);
      } else {
        window.localStorage.setItem(
          pending.storageKey,
          JSON.stringify(pending.draft),
        );
      }
      setError(null);
    } catch (reason) {
      console.error("Failed to save goal draft", reason);
      setError("Could not save the goal draft; edit it to retry.");
    }
  }, []);

  useEffect(() => {
    setObjectiveState(goalObjective);
    setError(null);
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw !== null) {
        const draft = parseGoalDraft(raw);
        if (draft.goalId === goalId && draft.goalObjective === goalObjective) {
          setObjectiveState(draft.objective);
        } else {
          window.localStorage.removeItem(storageKey);
        }
      }
    } catch (reason) {
      console.error("Failed to load goal draft", reason);
      setError("Could not restore the goal draft; enter it again.");
    }
    return flush;
  }, [storageKey, goalId, goalObjective, flush]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [flush]);

  const setObjective = (value: string) => {
    setObjectiveState(value);
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    pendingSaveRef.current = {
      storageKey,
      draft: { goalId, goalObjective, objective: value },
    };
    timerRef.current = setTimeout(flush, 500);
  };

  const normalizedObjective = objective.trim();
  const terminal =
    normalizedObjective === goal?.objective &&
    (goal.status === "complete" || goal.status === "budget-limited");

  return {
    objective,
    setObjective,
    error,
    submissionObjective:
      enabled && !running && !terminal && normalizedObjective
        ? normalizedObjective
        : undefined,
  };
}
