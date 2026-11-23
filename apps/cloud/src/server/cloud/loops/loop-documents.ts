import { randomUUID } from "node:crypto";
import type { CloudActor } from "../../../lib/cloud-contract";
import type {
  CloudDocument,
  CloudDocumentSection,
  CloudDocumentSummary,
} from "../../../lib/cloud-loop-contract";
import {
  CloudError,
  requireMembership,
  requireTeam,
  teamVisibility,
} from "../access";
import type { CloudSql } from "../database";

const documentFrom = `cloud_documents d JOIN cloud_teams t ON t.organization_id=d.organization_id AND t.id=d.team_id
  JOIN cloud_memberships m ON m.organization_id=d.organization_id AND m.user_id=$2`;

export async function readDocuments(
  sql: CloudSql,
  actor: CloudActor,
  teamId: string | null,
): Promise<CloudDocumentSummary[]> {
  await requireMembership(sql, actor);
  return (
    await sql.query<CloudDocumentSummary & Record<string, unknown>>(
      `SELECT d.id,d.title,d.team_id AS "teamId" FROM ${documentFrom}
      WHERE d.organization_id=$1 AND ${teamVisibility} AND ($3::uuid IS NULL OR d.team_id=$3)
      ORDER BY d.title,d.id LIMIT 500`,
      [actor.organizationId, actor.userId, teamId],
    )
  ).rows;
}

export async function insertDocument(
  sql: CloudSql,
  actor: CloudActor,
  input: { teamId: string; title: string },
): Promise<CloudDocumentSummary> {
  await requireTeam(sql, actor, input.teamId, "automations.edit");
  const id = randomUUID();
  await sql.query(
    "INSERT INTO cloud_documents (organization_id,id,team_id,title) VALUES ($1,$2,$3,$4)",
    [actor.organizationId, id, input.teamId, input.title],
  );
  return { id, title: input.title, teamId: input.teamId };
}

export async function readDocument(
  sql: CloudSql,
  actor: CloudActor,
  id: string,
): Promise<CloudDocument> {
  await requireMembership(sql, actor);
  const document = (
    await sql.query<CloudDocumentSummary & Record<string, unknown>>(
      `SELECT d.id,d.title,d.team_id AS "teamId" FROM ${documentFrom} WHERE d.organization_id=$1 AND d.id=$3 AND ${teamVisibility}`,
      [actor.organizationId, actor.userId, id],
    )
  ).rows[0];
  if (!document)
    throw new CloudError(404, "not_found", "Document is unavailable.");
  const sections = (
    await sql.query<CloudDocumentSection & Record<string, unknown>>(
      `SELECT id,position,heading,body,automation_run_id AS "automationRunId",
        to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"
      FROM cloud_document_sections WHERE organization_id=$1 AND document_id=$2 ORDER BY position`,
      [actor.organizationId, id],
    )
  ).rows;
  return { ...document, sections };
}
