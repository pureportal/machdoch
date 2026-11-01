import {
  GOAL_REQUIREMENT_STATUSES,
  type GoalRequirement,
  type GoalRequirementStatus,
} from "./goal-store.js";

const MAX_REQUIREMENTS = 100;
const MAX_TEXT_CHARS = 500;
const MAX_EVIDENCE_CHARS = 1_000;
const CHECKLIST_BLOCK = /<goal_checklist>([\s\S]*?)<\/goal_checklist>/u;

export const GOAL_CHECKLIST_INSTRUCTIONS =
  'List every requirement of the goal in a checklist, in the answer before the control record: <goal_checklist>[{"text":"requirement","status":"verified|missing|failed","evidence":"what you checked and saw"}]</goal_checklist>. Use verified only for what you confirmed yourself in this check. Then state in one or two sentences what remains.';

const toRequirement = (value: unknown): GoalRequirement | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const { text, status, evidence } = value as Record<string, unknown>;
  if (
    typeof text !== "string" ||
    !text.trim() ||
    !GOAL_REQUIREMENT_STATUSES.includes(status as GoalRequirementStatus)
  )
    return undefined;
  return {
    text: text.trim().slice(0, MAX_TEXT_CHARS),
    status: status as GoalRequirementStatus,
    evidence:
      typeof evidence === "string"
        ? evidence.trim().slice(0, MAX_EVIDENCE_CHARS)
        : "",
  };
};

/** Splits a check's answer into its checklist and the text around it. */
export const parseGoalChecklist = (
  answer: string,
): { requirements: GoalRequirement[]; summary: string } => {
  const match = CHECKLIST_BLOCK.exec(answer);
  if (!match) return { requirements: [], summary: answer.trim() };
  const summary = answer.replace(match[0], "").trim();
  try {
    const value: unknown = JSON.parse(match[1] ?? "");
    return {
      requirements: Array.isArray(value)
        ? value
            .slice(0, MAX_REQUIREMENTS)
            .flatMap((entry) => toRequirement(entry) ?? [])
        : [],
      summary,
    };
  } catch {
    return { requirements: [], summary };
  }
};

export const countVerifiedRequirements = (
  requirements: readonly GoalRequirement[],
): number =>
  requirements.filter((requirement) => requirement.status === "verified")
    .length;

/** What the next pass needs: the check's summary and each open requirement. */
export const createGoalNextStep = (
  summary: string,
  requirements: readonly GoalRequirement[],
): string =>
  [
    summary,
    ...requirements
      .filter((requirement) => requirement.status !== "verified")
      .map(
        (requirement) =>
          `- ${requirement.status}: ${requirement.text}${requirement.evidence ? ` (${requirement.evidence})` : ""}`,
      ),
  ]
    .filter(Boolean)
    .join("\n");
