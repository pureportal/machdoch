import type { CloudActor } from "../../lib/cloud-contract";
import type {
  CloudAdministration,
  CloudInvitation,
  CloudOrganization,
  ManagedMember,
  MemberUpdate,
  OrganizationUpdate,
  TeamUpdate,
} from "../../lib/cloud-administration-contract";
import type { CloudPermission } from "../../lib/cloud-permissions";
import {
  accessCan,
  checkRevision,
  CloudError,
  command,
  recordEvent,
  requireMembership,
  requireRole,
  requireRoleGrant,
  requireTeam,
} from "./access";
import { readRoles } from "./roles";
import { settingsPermissions } from "../../lib/cloud-sidebar-contract";
import { organizationColumns } from "./branding";
import type { CloudDatabase, CloudSql } from "./database";
import { lockUserSessions } from "./session-issuance";

export async function lockAdministration(
  sql: CloudSql,
  actor: CloudActor,
  permission: CloudPermission,
) {
  await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `administration:${actor.organizationId}`,
  ]);
  return requireMembership(sql, actor, permission);
}

export class CloudAdministrationService {
  constructor(private readonly database: CloudDatabase) {}

  get(actor: CloudActor): Promise<CloudAdministration> {
    return this.database.transaction(async (sql) => {
      const access = await requireMembership(sql, actor);
      const manageMembers = accessCan(access, "members.manage");
      await requireMembership(
        sql,
        actor,
        settingsPermissions.find((permission) =>
          accessCan(access, permission),
        ) ?? "members.manage",
      );
      const organization = (
        await sql.query<CloudOrganization & Record<string, unknown>>(
          `SELECT ${organizationColumns} FROM cloud_organizations WHERE id=$1`,
          [actor.organizationId],
        )
      ).rows[0]!;
      const members = manageMembers
        ? (
            await sql.query<ManagedMember & Record<string, unknown>>(
              `SELECT u.id,u.name,u.email,m.role,r.name AS "roleName",m.active,m.revision,EXISTS(SELECT 1 FROM cloud_authenticators a WHERE a.user_id=u.id) AS "twoFactor",
              COALESCE((SELECT array_agg(tm.team_id ORDER BY tm.team_id) FROM cloud_team_memberships tm WHERE tm.organization_id=m.organization_id AND tm.user_id=m.user_id),'{}') AS "teamIds"
              FROM cloud_memberships m JOIN cloud_users u ON u.id=m.user_id JOIN cloud_roles r ON r.organization_id=m.organization_id AND r.key=m.role
              WHERE m.organization_id=$1 ORDER BY m.active DESC,u.name,u.id`,
              [actor.organizationId],
            )
          ).rows
        : [];
      const invitations = manageMembers
        ? (
            await sql.query<CloudInvitation & Record<string, unknown>>(
              `SELECT i.id,i.email,i.role,r.name AS "roleName",i.team_ids AS "teamIds",
              to_char(i.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "expiresAt"
              FROM cloud_invitations i JOIN cloud_roles r ON r.organization_id=i.organization_id AND r.key=i.role
              WHERE i.organization_id=$1 AND cloud_invitation_pending(i) ORDER BY i.email,i.id`,
              [actor.organizationId],
            )
          ).rows
        : [];
      const roles =
        manageMembers || accessCan(access, "roles.manage")
          ? await readRoles(sql, actor.organizationId)
          : [];
      const teams = manageMembers
        ? (
            await sql.query<{ id: string; key: string; name: string }>(
              "SELECT id,key,name FROM cloud_teams WHERE organization_id=$1 ORDER BY name,id",
              [actor.organizationId],
            )
          ).rows
        : [];
      return { organization, members, invitations, roles, teams };
    });
  }

  updateOrganization(
    actor: CloudActor,
    key: string,
    input: OrganizationUpdate,
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      await lockAdministration(sql, actor, "settings.manage");
      return command(
        sql,
        actor,
        key,
        { kind: "organization.update", input },
        async () => {
          const current = (
            await sql.query<{ revision: number }>(
              "SELECT revision FROM cloud_organizations WHERE id=$1 FOR UPDATE",
              [actor.organizationId],
            )
          ).rows[0]!;
          checkRevision(current.revision, input.revision);
          await sql.query(
            "UPDATE cloud_organizations SET name=$2,brand=$3,logo_dark=$4,logo_light=$5,revision=revision+1 WHERE id=$1",
            [
              actor.organizationId,
              input.name,
              JSON.stringify(input.brand),
              input.logoDark,
              input.logoLight,
            ],
          );
          await recordEvent(
            sql,
            actor,
            "organization.changed",
            actor.organizationId,
            input.revision + 1,
            {},
          );
          return { id: actor.organizationId };
        },
      );
    });
  }

  updateMember(
    actor: CloudActor,
    key: string,
    userId: string,
    input: MemberUpdate,
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      const access = await lockAdministration(sql, actor, "members.manage");
      return command(
        sql,
        actor,
        key,
        { kind: "member.update", userId, input },
        async () => {
          const target = (
            await sql.query<{
              role: string;
              active: boolean;
              revision: number;
            }>(
              "SELECT role,active,revision FROM cloud_memberships WHERE organization_id=$1 AND user_id=$2 FOR UPDATE",
              [actor.organizationId, userId],
            )
          ).rows[0];
          if (!target)
            throw new CloudError(404, "not_found", "Member is unavailable.");
          checkRevision(target.revision, input.revision);
          await requireRole(sql, actor.organizationId, input.role);
          await requireRoleGrant(
            sql,
            actor.organizationId,
            access.role,
            target.role,
          );
          await requireRoleGrant(
            sql,
            actor.organizationId,
            access.role,
            input.role,
          );
          if (input.teamIds) {
            const teams = await sql.query(
              "SELECT id FROM cloud_teams WHERE organization_id=$1 AND id=ANY($2::uuid[])",
              [actor.organizationId, input.teamIds],
            );
            if (teams.rows.length !== input.teamIds.length)
              throw new CloudError(
                422,
                "team_unavailable",
                "Choose existing teams.",
              );
            await sql.query(
              "DELETE FROM cloud_team_memberships WHERE organization_id=$1 AND user_id=$2 AND NOT team_id=ANY($3::uuid[])",
              [actor.organizationId, userId, input.teamIds],
            );
            await sql.query(
              "INSERT INTO cloud_team_memberships (organization_id,team_id,user_id) SELECT $1,unnest($3::uuid[]),$2 ON CONFLICT DO NOTHING",
              [actor.organizationId, userId, input.teamIds],
            );
          }
          if (
            target.role === "owner" &&
            target.active &&
            (input.role !== "owner" || !input.active)
          ) {
            const owners = await sql.query(
              "SELECT user_id FROM cloud_memberships WHERE organization_id=$1 AND role='owner' AND active AND user_id<>$2",
              [actor.organizationId, userId],
            );
            if (!owners.rows.length)
              throw new CloudError(
                409,
                "last_owner",
                "Assign another owner before changing your access.",
              );
            const requiredSso = (
              await sql.query(
                "SELECT 1 FROM cloud_signin_policies WHERE organization_id=$1 AND required_sso",
                [actor.organizationId],
              )
            ).rows.length;
            if (
              requiredSso &&
              !(
                await sql.query(
                  `SELECT 1 FROM cloud_sso_mappings i JOIN cloud_memberships m ON m.organization_id=i.organization_id AND m.user_id=i.user_id JOIN cloud_users u ON u.id=m.user_id JOIN cloud_sso_providers p ON p.id=i.provider_id
              WHERE i.organization_id=$1 AND i.user_id<>$2 AND m.role='owner' AND m.active AND NOT u.disabled AND p.enabled AND p.verified_revision=p.revision LIMIT 1`,
                  [actor.organizationId, userId],
                )
              ).rows.length
            )
              throw new CloudError(
                409,
                "sso_last_owner",
                "Link another owner to SSO before changing this owner's access.",
              );
          }
          await sql.query(
            "UPDATE cloud_memberships SET role=$3,active=$4,revision=revision+1 WHERE organization_id=$1 AND user_id=$2",
            [actor.organizationId, userId, input.role, input.active],
          );
          await lockUserSessions(sql, [userId]);
          await sql.query(
            "DELETE FROM cloud_sessions WHERE organization_id=$1 AND user_id=$2",
            [actor.organizationId, userId],
          );
          if (!input.active || input.role !== target.role) {
            await sql.query(
              "UPDATE cloud_oauth_grants SET revoked_at=now() WHERE organization_id=$1 AND user_id=$2 AND revoked_at IS NULL",
              [actor.organizationId, userId],
            );
            await sql.query(
              "UPDATE cloud_invitations SET revoked_at=now() WHERE organization_id=$1 AND invited_by=$2 AND accepted_at IS NULL AND revoked_at IS NULL",
              [actor.organizationId, userId],
            );
          }
          await recordEvent(
            sql,
            actor,
            "member.changed",
            userId,
            input.revision + 1,
            {
              role: input.role,
              active: input.active,
              ...(input.teamIds ? { teamIds: input.teamIds } : {}),
            },
          );
          return { id: userId };
        },
      );
    });
  }

  revokeInvitation(
    actor: CloudActor,
    key: string,
    id: string,
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      const access = await lockAdministration(sql, actor, "members.manage");
      return command(
        sql,
        actor,
        key,
        { kind: "invitation.revoke", id },
        async () => {
          const invitation = (
            await sql.query<{
              role: string;
              accepted_at: Date | null;
              revoked_at: Date | null;
            }>(
              "SELECT role,accepted_at,revoked_at FROM cloud_invitations WHERE organization_id=$1 AND id=$2 FOR UPDATE",
              [actor.organizationId, id],
            )
          ).rows[0];
          if (!invitation)
            throw new CloudError(
              404,
              "not_found",
              "Invitation is unavailable.",
            );
          await requireRoleGrant(
            sql,
            actor.organizationId,
            access.role,
            invitation.role,
          );
          if (invitation.accepted_at)
            throw new CloudError(
              409,
              "invitation_accepted",
              "This invitation was already accepted. Manage the member's access instead.",
            );
          if (invitation.revoked_at) return { id };
          await sql.query(
            "UPDATE cloud_invitations SET revoked_at=COALESCE(revoked_at,now()) WHERE organization_id=$1 AND id=$2 AND accepted_at IS NULL",
            [actor.organizationId, id],
          );
          await recordEvent(sql, actor, "invitation.revoked", id, 1, {});
          return { id };
        },
      );
    });
  }

  teamMembers(actor: CloudActor, teamId: string): Promise<string[]> {
    return this.database.transaction(async (sql) => {
      await requireTeam(sql, actor, teamId, "teams.manage");
      return (
        await sql.query<{ user_id: string }>(
          `SELECT tm.user_id FROM cloud_team_memberships tm JOIN cloud_memberships m ON m.organization_id=tm.organization_id AND m.user_id=tm.user_id
        WHERE tm.organization_id=$1 AND tm.team_id=$2 AND m.active ORDER BY tm.user_id`,
          [actor.organizationId, teamId],
        )
      ).rows.map((row) => row.user_id);
    });
  }

  updateTeam(
    actor: CloudActor,
    key: string,
    id: string,
    input: TeamUpdate,
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      await lockAdministration(sql, actor, "teams.manage");
      const team = await requireTeam(sql, actor, id, "teams.manage");
      return command(
        sql,
        actor,
        key,
        { kind: "team.update", id, input },
        async () => {
          checkRevision(team.revision, input.revision);
          const members = await sql.query(
            "SELECT m.user_id FROM cloud_memberships m JOIN cloud_users u ON u.id=m.user_id WHERE m.organization_id=$1 AND m.user_id=ANY($2::uuid[]) AND m.active AND NOT u.disabled",
            [actor.organizationId, input.memberIds],
          );
          if (members.rows.length !== input.memberIds.length)
            throw new CloudError(
              422,
              "invalid_member",
              "Choose active members of this organization.",
            );
          await sql.query(
            "DELETE FROM cloud_team_memberships WHERE organization_id=$1 AND team_id=$2 AND NOT user_id=ANY($3::uuid[])",
            [actor.organizationId, id, input.memberIds],
          );
          await sql.query(
            "INSERT INTO cloud_team_memberships (organization_id,team_id,user_id) SELECT $1,$2,unnest($3::uuid[]) ON CONFLICT DO NOTHING",
            [actor.organizationId, id, input.memberIds],
          );
          await sql.query(
            "UPDATE cloud_teams SET name=$3,visibility=$4,revision=revision+1 WHERE organization_id=$1 AND id=$2",
            [actor.organizationId, id, input.name, input.visibility],
          );
          await recordEvent(
            sql,
            actor,
            "team.changed",
            id,
            input.revision + 1,
            { visibility: input.visibility },
          );
          return { id };
        },
      );
    });
  }
}
