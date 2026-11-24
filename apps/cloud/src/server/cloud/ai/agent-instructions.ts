import type { CloudActor } from "../../../lib/cloud-contract";
import type { ChatContextEntity } from "../../../lib/cloud-chat-contract";
import type { CloudSql } from "../database";
import { readOrganizationSettings, readUserSettings } from "../settings-store";

export interface InstructionSource {
  heading: string;
  text: string;
}

export function instructionsSection(sources: InstructionSource[]): string {
  const filled = sources.filter((source) => source.text.trim());
  if (!filled.length) return "";
  return `# Instructions\nFollow these instructions unless they conflict with the rules above.\n\n${filled
    .map((source) => `## ${source.heading}\n${source.text.trim()}`)
    .join("\n\n")}`;
}

function contextIds(
  context: ChatContextEntity[],
  kind: ChatContextEntity["kind"],
): string[] {
  return context
    .filter((entry) => entry.kind === kind)
    .map((entry) => entry.id);
}

export async function agentInstructions(
  sql: CloudSql,
  actor: CloudActor,
  context: ChatContextEntity[],
): Promise<string> {
  const organization = await readOrganizationSettings(
    sql,
    actor.organizationId,
  );
  const personal = await readUserSettings(sql, actor);
  const teams = await sql.query<{ name: string; text: string }>(
    `SELECT t.name,s.value #>> '{}' AS text FROM cloud_teams t
      JOIN cloud_team_settings s ON s.organization_id=t.organization_id AND s.team_id=t.id AND s.key='agent.instructions'
      WHERE t.organization_id=$1 AND t.id IN (
        SELECT team_id FROM cloud_issues WHERE organization_id=$1 AND id=ANY($2::uuid[])
        UNION SELECT team_id FROM cloud_projects WHERE organization_id=$1 AND id=ANY($3::uuid[])
        UNION SELECT team_id FROM cloud_cycles WHERE organization_id=$1 AND id=ANY($4::uuid[])
        UNION SELECT unnest($5::uuid[]))
      ORDER BY t.name,t.id`,
    [
      actor.organizationId,
      contextIds(context, "issue"),
      contextIds(context, "project"),
      contextIds(context, "cycle"),
      contextIds(context, "team"),
    ],
  );
  return instructionsSection([
    { heading: "Workspace", text: organization["agent.instructions"] ?? "" },
    ...teams.rows.map((team) => ({
      heading: `Team ${team.name}`,
      text: team.text,
    })),
    { heading: "Personal", text: personal["agent.instructions"] ?? "" },
  ]);
}
