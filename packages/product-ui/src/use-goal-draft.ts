import type { ProductGoal } from "@machdoch/fleet-protocol";
import { useEffect, useState } from "react";

export function useGoalDraft(
  sessionId: string,
  goal: ProductGoal | null | undefined,
  enabled: boolean,
  running: boolean,
) {
  const [objective, setObjective] = useState(goal?.objective ?? "");

  useEffect(() => {
    setObjective(goal?.objective ?? "");
  }, [sessionId, goal?.id, goal?.objective]);

  const normalizedObjective = objective.trim();
  const terminal =
    normalizedObjective === goal?.objective &&
    (goal.status === "complete" || goal.status === "budget-limited");

  return {
    objective,
    setObjective,
    submissionObjective:
      enabled && !running && !terminal && normalizedObjective
        ? normalizedObjective
        : undefined,
  };
}
