import { createHash, randomUUID } from "node:crypto";
import type {
  CloudActor,
  CloudRole,
  CloudTeam,
} from "../../lib/cloud-contract";
import type { CloudSql } from "./database";

export class CloudError extends Error {
  readonly kind = "machdoch.cloud.error";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function isCloudError(error: unknown): error is CloudError {
  return (
    error instanceof Error &&
    "kind" in error &&
    error.kind === "machdoch.cloud.error"
  );
}

export const teamVisibility = `(t.visibility = 'organization' OR m.role IN ('owner', 'admin') OR EXISTS (
  SELECT 1 FROM cloud_team_memberships tm WHERE tm.organization_id = t.organization_id AND tm.team_id = t.id AND tm.user_id = $2
))`;

export async function requireMembership(
  sql: CloudSql,
  actor: CloudActor,
  permission: "read" | "write" | "admin" = "read",
): Promise<CloudRole> {
  const result = await sql.query<{ role: CloudRole }>(
    `SELECT m.role FROM cloud_memberships m JOIN cloud_users u ON u.id = m.user_id
     WHERE m.organization_id = $1 AND m.user_id = $2 AND m.active AND NOT u.disabled FOR SHARE OF m, u`,
    [actor.organizationId, actor.userId],
  );
  const role = result.rows[0]?.role;
  if (!role)
    throw new CloudError(
      403,
      "membership_required",
      "Your organization access has ended. Sign in again.",
    );
  if (actor.delegation) {
    const grant = await sql.query(
      `SELECT g.id FROM cloud_oauth_tokens t JOIN cloud_oauth_grants g ON g.id=t.grant_id
       WHERE t.hash=$1 AND t.kind='access' AND t.expires_at>clock_timestamp() AND g.expires_at>clock_timestamp()
       AND g.revoked_at IS NULL AND g.organization_id=$2 AND g.user_id=$3 AND $4=ANY(g.scopes)
       AND g.authentication_epoch=(SELECT authentication_epoch FROM cloud_users WHERE id=$3)
       AND g.membership_epoch=(SELECT authentication_epoch FROM cloud_memberships WHERE organization_id=$2 AND user_id=$3)
       AND cloud_login_authority_valid(g.organization_id,g.authentication_method,g.policy_epoch,g.provider_id,g.provider_epoch) FOR SHARE OF g`,
      [
        actor.delegation.tokenHash,
        actor.organizationId,
        actor.userId,
        actor.delegation.scope,
      ],
    );
    if (
      !grant.rows.length ||
      permission === "admin" ||
      (permission === "write" && actor.delegation.scope === "cloud:read")
    )
      throw new CloudError(
        403,
        "delegation_denied",
        "App access has ended or does not allow this action. Reconnect from the app.",
      );
  }
  if (
    (permission === "write" && role === "viewer") ||
    (permission === "admin" && role !== "owner" && role !== "admin")
  )
    throw new CloudError(
      403,
      "permission_denied",
      "Your role does not allow this change.",
    );
  return role;
}

export async function requireTeam(
  sql: CloudSql,
  actor: CloudActor,
  teamId: string,
  write = false,
): Promise<CloudTeam> {
  await requireMembership(sql, actor, write ? "write" : "read");
  const result = await sql.query<CloudTeam & Record<string, unknown>>(
    `SELECT t.id, t.name, t.key, t.visibility, t.estimate_scale AS "estimateScale", t.scale_revision AS "scaleRevision", t.revision
     FROM cloud_teams t JOIN cloud_memberships m ON m.organization_id = t.organization_id AND m.user_id = $2
     WHERE t.organization_id = $1 AND t.id = $3 AND ${teamVisibility} FOR ${write ? "UPDATE" : "SHARE"} OF t`,
    [actor.organizationId, actor.userId, teamId],
  );
  const team = result.rows[0];
  if (!team) throw new CloudError(404, "not_found", "Team is unavailable.");
  return team;
}

export function checkRevision(actual: number, expected: number): void {
  if (actual !== expected)
    throw new CloudError(
      409,
      "revision_conflict",
      "This item changed. Reload it before saving your changes.",
    );
}

export async function recordEvent(
  sql: CloudSql,
  actor: CloudActor,
  kind: string,
  id: string,
  revision: number,
  payload: unknown,
): Promise<void> {
  await sql.query(
    `INSERT INTO cloud_outbox (id, organization_id, actor_id, kind, subject_id, revision, payload) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      randomUUID(),
      actor.organizationId,
      actor.userId,
      kind,
      id,
      revision,
      JSON.stringify(payload),
    ],
  );
}

export async function command<T extends Record<string, unknown>>(
  sql: CloudSql,
  actor: CloudActor,
  commandId: string,
  input: unknown,
  perform: () => Promise<T>,
): Promise<T> {
  const digest = createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
  await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `${actor.organizationId}/${actor.userId}/${commandId}`,
  ]);
  const previous = await sql.query<{ digest: string; result: T }>(
    "SELECT digest, result FROM cloud_command_receipts WHERE organization_id=$1 AND actor_id=$2 AND command_id=$3",
    [actor.organizationId, actor.userId, commandId],
  );
  if (previous.rows[0]) {
    if (previous.rows[0].digest !== digest)
      throw new CloudError(
        409,
        "command_conflict",
        "This request key was already used for a different change.",
      );
    return previous.rows[0].result;
  }
  const result = await perform();
  await sql.query(
    "INSERT INTO cloud_command_receipts (organization_id, actor_id, command_id, digest, result) VALUES ($1,$2,$3,$4,$5)",
    [
      actor.organizationId,
      actor.userId,
      commandId,
      digest,
      JSON.stringify(result),
    ],
  );
  return result;
}
