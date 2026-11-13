import { createHash, randomUUID } from "node:crypto";
import type {
  CloudActor,
  CloudActorMember,
  CloudRole,
  CloudTeam,
} from "../../lib/cloud-contract";
import {
  cloudPermissions,
  delegationAllows,
  isCloudPermission,
  type CloudPermission,
  type RoleScope,
} from "../../lib/cloud-permissions";
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

export const teamVisibility =
  "cloud_team_visible(t.organization_id, t.id, t.visibility, m.user_id)";

export function teamVisibilityFor(team: string, membership: string): string {
  return `cloud_team_visible(${team}.organization_id, ${team}.id, ${team}.visibility, ${membership}.user_id)`;
}

export interface CloudAccess {
  role: CloudRole;
  roleName: string;
  owner: boolean;
  scope: RoleScope;
  permissions: ReadonlySet<CloudPermission>;
}

export function accessCan(
  access: CloudAccess,
  permission: CloudPermission,
): boolean {
  return access.owner || access.permissions.has(permission);
}

export function actorMember(
  member: { id: string; name: string },
  access: CloudAccess,
): CloudActorMember {
  return {
    ...member,
    role: access.role,
    roleName: access.roleName,
    owner: access.owner,
    scope: access.scope,
    permissions: cloudPermissions.filter((permission) =>
      accessCan(access, permission),
    ),
  };
}

export async function requireMembership(
  sql: CloudSql,
  actor: CloudActor,
  permission?: CloudPermission,
): Promise<CloudAccess> {
  const result = await sql.query<{
    role: CloudRole;
    name: string;
    scope: RoleScope;
    permissions: string[];
  }>(
    `SELECT m.role, r.name, r.scope, r.permissions FROM cloud_memberships m JOIN cloud_users u ON u.id = m.user_id
     JOIN cloud_roles r ON r.organization_id = m.organization_id AND r.key = m.role
     WHERE m.organization_id = $1 AND m.user_id = $2 AND m.active AND NOT u.disabled FOR SHARE OF m, u`,
    [actor.organizationId, actor.userId],
  );
  const row = result.rows[0];
  if (!row)
    throw new CloudError(
      403,
      "membership_required",
      "Your organization access has ended. Sign in again.",
    );
  const access: CloudAccess = {
    role: row.role,
    roleName: row.name,
    owner: row.role === "owner",
    scope: row.scope,
    permissions: new Set(row.permissions.filter(isCloudPermission)),
  };
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
      !accessCan(access, "apps.connect") ||
      !delegationAllows(permission ?? null, actor.delegation.scope)
    )
      throw new CloudError(
        403,
        "delegation_denied",
        "App access has ended or does not allow this action. Reconnect from the app.",
      );
  }
  if (permission && !accessCan(access, permission))
    throw new CloudError(
      403,
      "permission_denied",
      "Your role does not allow this.",
    );
  return access;
}

export async function roleGrantable(
  sql: CloudSql,
  organizationId: string,
  granter: CloudRole,
  granted: CloudRole,
): Promise<boolean> {
  return (
    await sql.query<{ allowed: boolean }>(
      "SELECT cloud_role_grants($1,$2,$3) AS allowed",
      [organizationId, granter, granted],
    )
  ).rows[0]!.allowed;
}

export async function requireRoleGrant(
  sql: CloudSql,
  organizationId: string,
  granter: CloudRole,
  granted: CloudRole,
): Promise<void> {
  if (!(await roleGrantable(sql, organizationId, granter, granted)))
    throw new CloudError(
      403,
      "owner_required",
      "Your role cannot grant or change this role. Roles that manage people or roles need an owner.",
    );
}

export async function requireRole(
  sql: CloudSql,
  organizationId: string,
  role: CloudRole,
): Promise<void> {
  const found = await sql.query(
    "SELECT 1 FROM cloud_roles WHERE organization_id=$1 AND key=$2",
    [organizationId, role],
  );
  if (!found.rows.length)
    throw new CloudError(422, "role_unavailable", "Choose an existing role.");
}

export async function requireTeam(
  sql: CloudSql,
  actor: CloudActor,
  teamId: string,
  permission?: CloudPermission,
): Promise<CloudTeam> {
  await requireMembership(sql, actor, permission);
  const result = await sql.query<CloudTeam & Record<string, unknown>>(
    `SELECT t.id, t.name, t.key, t.visibility, t.estimate_scale AS "estimateScale", t.scale_revision AS "scaleRevision", t.revision
     FROM cloud_teams t JOIN cloud_memberships m ON m.organization_id = t.organization_id AND m.user_id = $2
     WHERE t.organization_id = $1 AND t.id = $3 AND ${teamVisibility} FOR ${permission ? "UPDATE" : "SHARE"} OF t`,
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
