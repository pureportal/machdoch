import { randomUUID } from "node:crypto";
import type { CloudActor } from "../../lib/cloud-contract";
import type {
  CloudRoleRecord,
  RoleInput,
  RoleUpdate,
} from "../../lib/cloud-administration-contract";
import {
  cloudPermissions,
  ownerGrantedPermissions,
  permissionCatalog,
  type CloudPermission,
} from "../../lib/cloud-permissions";
import {
  accessCan,
  actorMember,
  checkRevision,
  CloudError,
  command,
  recordEvent,
  requireMembership,
  teamVisibility,
  type CloudAccess,
} from "./access";
import type { CloudDatabase, CloudSql } from "./database";

export interface CloudAccessSummary {
  role: string;
  roleName: string;
  owner: boolean;
  scope: CloudAccess["scope"];
  permissions: { key: CloudPermission; label: string; group: string }[];
  teams: { id: string; key: string; name: string }[];
}

const roleColumns = `r.key,r.name,r.description,r.scope,r.permissions,r.builtin,r.revision,
  (SELECT count(*)::integer FROM cloud_memberships m WHERE m.organization_id=r.organization_id AND m.role=r.key AND m.active) AS "memberCount"`;

export async function readRoles(
  sql: CloudSql,
  organizationId: string,
): Promise<CloudRoleRecord[]> {
  return (
    await sql.query<CloudRoleRecord & Record<string, unknown>>(
      `SELECT ${roleColumns} FROM cloud_roles r WHERE r.organization_id=$1
      ORDER BY r.builtin DESC,array_position(ARRAY['owner','admin','member','viewer','guest'],r.key),lower(r.name)`,
      [organizationId],
    )
  ).rows;
}

function requireGrantable(
  access: CloudAccess,
  permissions: readonly CloudPermission[],
): void {
  if (access.owner) return;
  if (
    permissions.some((permission) =>
      ownerGrantedPermissions.includes(permission),
    )
  )
    throw new CloudError(
      403,
      "owner_required",
      "Only an owner can grant permissions to manage people or roles.",
    );
  const missing = permissions.filter(
    (permission) => !accessCan(access, permission),
  );
  if (missing.length)
    throw new CloudError(
      403,
      "role_not_grantable",
      `You cannot grant permissions you do not have: ${missing
        .map((permission) => permissionCatalog[permission].label)
        .join(", ")}.`,
    );
}

async function lockedRole(
  sql: CloudSql,
  organizationId: string,
  key: string,
): Promise<CloudRoleRecord> {
  const role = (
    await sql.query<CloudRoleRecord & Record<string, unknown>>(
      `SELECT ${roleColumns} FROM cloud_roles r WHERE r.organization_id=$1 AND r.key=$2 FOR UPDATE`,
      [organizationId, key],
    )
  ).rows[0];
  if (!role) throw new CloudError(404, "not_found", "Role is unavailable.");
  return role;
}

function requireEditable(access: CloudAccess, role: CloudRoleRecord): void {
  if (role.key === "owner")
    throw new CloudError(
      409,
      "role_locked",
      "The owner role always has every permission.",
    );
  requireGrantable(access, role.permissions);
}

function normalized(input: RoleInput): RoleInput {
  return {
    ...input,
    permissions: cloudPermissions.filter((permission) =>
      input.permissions.includes(permission),
    ),
  };
}

export class CloudRoles {
  constructor(private readonly database: CloudDatabase) {}

  list(actor: CloudActor): Promise<CloudRoleRecord[]> {
    return this.database.transaction(async (sql) => {
      const access = await requireMembership(sql, actor);
      await requireMembership(
        sql,
        actor,
        accessCan(access, "roles.manage") ? "roles.manage" : "members.manage",
      );
      return readRoles(sql, actor.organizationId);
    });
  }

  mine(actor: CloudActor): Promise<CloudAccessSummary> {
    return this.database.transaction(async (sql) => {
      const access = await requireMembership(sql, actor);
      const member = actorMember({ id: actor.userId, name: "" }, access);
      const teams = (
        await sql.query<{ id: string; key: string; name: string }>(
          `SELECT t.id,t.key,t.name FROM cloud_teams t JOIN cloud_memberships m ON m.organization_id=t.organization_id AND m.user_id=$2
          WHERE t.organization_id=$1 AND ${teamVisibility} ORDER BY t.name,t.id`,
          [actor.organizationId, actor.userId],
        )
      ).rows;
      return {
        role: member.role,
        roleName: member.roleName,
        owner: member.owner,
        scope: member.scope,
        permissions: member.permissions.map((key) => ({
          key,
          label: permissionCatalog[key].label,
          group: permissionCatalog[key].group,
        })),
        teams,
      };
    });
  }

  create(
    actor: CloudActor,
    commandId: string,
    input: RoleInput,
  ): Promise<{ key: string }> {
    return this.database.transaction(async (sql) => {
      const access = await requireMembership(sql, actor, "roles.manage");
      const role = normalized(input);
      return command(
        sql,
        actor,
        commandId,
        { kind: "role.create", input: role },
        async () => {
          requireGrantable(access, role.permissions);
          const key = `role-${randomUUID()}`;
          await this.write(sql, actor, key, role, null);
          await recordEvent(
            sql,
            actor,
            "role.created",
            actor.organizationId,
            1,
            {
              key,
              permissions: role.permissions,
              scope: role.scope,
            },
          );
          return { key };
        },
      );
    });
  }

  update(
    actor: CloudActor,
    commandId: string,
    key: string,
    input: RoleUpdate,
  ): Promise<{ key: string }> {
    return this.database.transaction(async (sql) => {
      const access = await requireMembership(sql, actor, "roles.manage");
      const { revision, ...rest } = input;
      const role = normalized(rest);
      return command(
        sql,
        actor,
        commandId,
        { kind: "role.update", key, input: { ...role, revision } },
        async () => {
          const current = await lockedRole(sql, actor.organizationId, key);
          checkRevision(current.revision, revision);
          requireEditable(access, current);
          requireGrantable(access, role.permissions);
          await this.write(sql, actor, key, role, current.revision);
          await recordEvent(
            sql,
            actor,
            "role.changed",
            actor.organizationId,
            revision + 1,
            {
              key,
              permissions: role.permissions,
              scope: role.scope,
            },
          );
          return { key };
        },
      );
    });
  }

  remove(actor: CloudActor, key: string, revision: number): Promise<void> {
    return this.database.transaction(async (sql) => {
      const access = await requireMembership(sql, actor, "roles.manage");
      const current = await lockedRole(sql, actor.organizationId, key);
      checkRevision(current.revision, revision);
      if (current.builtin)
        throw new CloudError(
          409,
          "role_builtin",
          "Built-in roles can be changed but not deleted.",
        );
      requireEditable(access, current);
      const used = await sql.query(
        `SELECT 1 FROM cloud_memberships WHERE organization_id=$1 AND role=$2
        UNION ALL SELECT 1 FROM cloud_invitations i WHERE i.organization_id=$1 AND i.role=$2 AND cloud_invitation_pending(i) LIMIT 1`,
        [actor.organizationId, key],
      );
      if (used.rows.length)
        throw new CloudError(
          409,
          "role_in_use",
          "Move everyone with this role, including pending invitations, to another role first.",
        );
      await sql.query(
        "DELETE FROM cloud_roles WHERE organization_id=$1 AND key=$2",
        [actor.organizationId, key],
      );
      await recordEvent(
        sql,
        actor,
        "role.deleted",
        actor.organizationId,
        revision,
        {
          key,
        },
      );
    });
  }

  private async write(
    sql: CloudSql,
    actor: CloudActor,
    key: string,
    role: RoleInput,
    revision: number | null,
  ): Promise<void> {
    const taken = await sql.query(
      "SELECT 1 FROM cloud_roles WHERE organization_id=$1 AND lower(name)=lower($2) AND key<>$3",
      [actor.organizationId, role.name, key],
    );
    if (taken.rows.length)
      throw new CloudError(
        409,
        "role_name_taken",
        "Another role already has this name.",
      );
    if (revision === null)
      await sql.query(
        "INSERT INTO cloud_roles (organization_id,key,name,description,scope,permissions) VALUES ($1,$2,$3,$4,$5,$6)",
        [
          actor.organizationId,
          key,
          role.name,
          role.description,
          role.scope,
          role.permissions,
        ],
      );
    else
      await sql.query(
        "UPDATE cloud_roles SET name=$3,description=$4,scope=$5,permissions=$6,revision=revision+1 WHERE organization_id=$1 AND key=$2",
        [
          actor.organizationId,
          key,
          role.name,
          role.description,
          role.scope,
          role.permissions,
        ],
      );
  }
}
