import { z } from "zod";
import type { CloudTeam } from "../../../lib/cloud-contract";
import type { CloudLabel } from "../../../lib/cloud-label-contract";
import type { AgentActionField } from "../../../lib/cloud-chat-contract";
import { AgentLookupError } from "./agent-workspace";
import type { CloudAgentSession } from "./agent-tools";

export const reference = z.string().trim().min(1).max(120);
export const issueReference = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .describe("Issue identifier such as ENG-42, or the issue ID.");
export const none = "none";
export const optionalReference = (description: string) =>
  reference.optional().describe(`${description} Use "none" to clear it.`);
export const pendingOutput = {
  proposed: true,
  note: "Recorded as a proposal. The user must confirm it before anything changes.",
};

export function estimateFor(team: CloudTeam, estimate: string): string {
  const card = team.estimateScale.find(
    (entry) => entry.label.toLowerCase() === estimate.toLowerCase(),
  );
  if (!card)
    throw new AgentLookupError(
      `Estimate "${estimate}" is not on the ${team.key} scale: ${team.estimateScale.map((entry) => entry.label).join(", ")}.`,
    );
  return card.label;
}

export async function labelsFor(
  session: CloudAgentSession,
  team: CloudTeam,
  names: string[],
): Promise<CloudLabel[]> {
  const labels = (
    await session.services.labels.list(session.actor, team.id)
  ).filter((label) => !label.archived);
  return names.map((name) => {
    const label = labels.find(
      (entry) => entry.name.toLowerCase() === name.toLowerCase(),
    );
    if (!label)
      throw new AgentLookupError(
        `No label "${name}" in ${team.key}. Labels: ${labels.map((entry) => entry.name).join(", ") || "none"}.`,
      );
    return label;
  });
}

export async function milestoneFor(
  session: CloudAgentSession,
  projectId: string | null,
  name: string,
) {
  if (!projectId)
    throw new AgentLookupError("Choose a project before choosing a milestone.");
  const milestones = await session.services.milestones.list(
    session.actor,
    projectId,
  );
  const milestone = milestones.find(
    (entry) =>
      entry.id === name || entry.name.toLowerCase() === name.toLowerCase(),
  );
  if (!milestone)
    throw new AgentLookupError(
      `No milestone "${name}" in this project. Milestones: ${milestones.map((entry) => entry.name).join(", ") || "none"}.`,
    );
  return milestone;
}

export function field(
  label: string,
  value: string | null | undefined,
): AgentActionField[] {
  return value ? [{ label, value }] : [];
}

export function markdownField(
  label: string,
  value: string | null | undefined,
): AgentActionField[] {
  return value?.trim() ? [{ label, value, markdown: true }] : [];
}
