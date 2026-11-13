import type { CloudOAuthScope } from "./cloud-oauth-contract";

export type PermissionClass = "read" | "write" | "admin";

interface PermissionDefinition {
  group: string;
  label: string;
  class: PermissionClass;
  scope?: CloudOAuthScope;
}

export const permissionCatalog = {
  "issues.edit": {
    group: "Work",
    label: "Create and edit issues",
    class: "write",
  },
  "comments.write": {
    group: "Work",
    label: "Comment on issues",
    class: "write",
  },
  "planning.edit": {
    group: "Work",
    label: "Manage projects, cycles and initiatives",
    class: "write",
  },
  "members.view": {
    group: "Work",
    label: "See all members",
    class: "read",
  },
  "ai.chat": { group: "AI", label: "Use Agent", class: "write" },
  "ai.tasks": {
    group: "AI",
    label: "Start AI tasks",
    class: "write",
    scope: "cloud:execute",
  },
  "automations.edit": {
    group: "AI",
    label: "Create automations and schedules",
    class: "write",
  },
  "git.view": {
    group: "Code",
    label: "See pull requests and repositories",
    class: "read",
  },
  "git.act": {
    group: "Code",
    label: "Merge, review and comment on pull requests",
    class: "write",
  },
  "releases.view": {
    group: "Releases",
    label: "See products and releases",
    class: "read",
  },
  "releases.edit": {
    group: "Releases",
    label: "Create and edit releases",
    class: "write",
  },
  "apps.connect": {
    group: "Apps",
    label: "Connect apps and MCP clients",
    class: "read",
  },
  "teams.view_all": {
    group: "Administration",
    label: "See private teams",
    class: "admin",
  },
  "teams.manage": {
    group: "Administration",
    label: "Manage teams and workflows",
    class: "admin",
  },
  "members.manage": {
    group: "Administration",
    label: "Invite people and manage their access",
    class: "admin",
  },
  "roles.manage": {
    group: "Administration",
    label: "Manage roles",
    class: "admin",
  },
  "settings.manage": {
    group: "Administration",
    label: "Manage organization, sign-in and email settings",
    class: "admin",
  },
  "ai.manage": {
    group: "Administration",
    label: "Manage AI providers and execution profiles",
    class: "admin",
  },
  "git.manage": {
    group: "Administration",
    label: "Manage Git connections",
    class: "admin",
  },
  "releases.manage": {
    group: "Administration",
    label: "Manage products and publishing channels",
    class: "admin",
  },
  "clients.manage": {
    group: "Administration",
    label: "Manage connected clients and devices",
    class: "admin",
  },
  "activity.view_all": {
    group: "Administration",
    label: "See everyone's AI activity",
    class: "admin",
  },
} as const satisfies Record<string, PermissionDefinition>;

export type CloudPermission = keyof typeof permissionCatalog;
export const cloudPermissions = Object.keys(
  permissionCatalog,
) as CloudPermission[];

export const roleScopes = ["organization", "assigned"] as const;
export type RoleScope = (typeof roleScopes)[number];

export const builtinRoleKeys = [
  "owner",
  "admin",
  "member",
  "viewer",
  "guest",
] as const;
export type BuiltinRoleKey = (typeof builtinRoleKeys)[number];

function permissionsOf(...classes: PermissionClass[]): CloudPermission[] {
  return cloudPermissions.filter((permission) =>
    (classes as string[]).includes(permissionCatalog[permission].class),
  );
}

export const builtinRoles: Record<
  BuiltinRoleKey,
  { name: string; scope: RoleScope; permissions: CloudPermission[] }
> = {
  owner: {
    name: "Owner",
    scope: "organization",
    permissions: [...cloudPermissions],
  },
  admin: {
    name: "Administrator",
    scope: "organization",
    permissions: [...cloudPermissions],
  },
  member: {
    name: "Member",
    scope: "organization",
    permissions: permissionsOf("read", "write"),
  },
  viewer: {
    name: "Viewer",
    scope: "organization",
    permissions: permissionsOf("read"),
  },
  guest: {
    name: "Guest",
    scope: "assigned",
    permissions: ["issues.edit", "comments.write"],
  },
};

export interface PermissionHolder {
  owner: boolean;
  permissions: readonly CloudPermission[];
}

export function holderCan(
  holder: PermissionHolder,
  permission: CloudPermission,
): boolean {
  return holder.owner || holder.permissions.includes(permission);
}

export const ownerGrantedPermissions: readonly CloudPermission[] = [
  "members.manage",
  "roles.manage",
];

export function canGrantPermissions(
  holder: PermissionHolder,
  permissions: readonly CloudPermission[],
): boolean {
  return (
    holder.owner ||
    permissions.every(
      (permission) =>
        !ownerGrantedPermissions.includes(permission) &&
        holder.permissions.includes(permission),
    )
  );
}

export function canGrantRole(
  holder: PermissionHolder,
  role: { key: string; permissions: readonly CloudPermission[] },
): boolean {
  if (holder.owner) return true;
  return (
    role.key !== "owner" &&
    holderCan(holder, "members.manage") &&
    canGrantPermissions(holder, role.permissions)
  );
}

export function canEditRole(
  holder: PermissionHolder,
  role: { key: string; permissions: readonly CloudPermission[] },
): boolean {
  return (
    role.key !== "owner" &&
    holderCan(holder, "roles.manage") &&
    canGrantPermissions(holder, role.permissions)
  );
}

export function isCloudPermission(value: string): value is CloudPermission {
  return Object.hasOwn(permissionCatalog, value);
}

export function permissionScope(permission: CloudPermission): CloudOAuthScope {
  const definition: PermissionDefinition = permissionCatalog[permission];
  return (
    definition.scope ??
    (definition.class === "read" ? "cloud:read" : "cloud:write")
  );
}

export function grantableScopes(
  permissions: readonly CloudPermission[],
): CloudOAuthScope[] {
  if (!permissions.includes("apps.connect")) return [];
  return [
    "cloud:read",
    ...(permissions.some(
      (permission) =>
        permissionCatalog[permission].class === "write" &&
        permissionScope(permission) === "cloud:write",
    )
      ? (["cloud:write"] as const)
      : []),
    ...(permissions.includes("ai.tasks") ? (["cloud:execute"] as const) : []),
  ];
}

export function delegationAllows(
  permission: CloudPermission | null,
  granted: CloudOAuthScope,
): boolean {
  if (!permission) return true;
  if (permissionCatalog[permission].class === "admin") return false;
  const required = permissionScope(permission);
  if (required === "cloud:read") return true;
  if (required === "cloud:write")
    return granted === "cloud:write" || granted === "cloud:execute";
  return granted === "cloud:execute";
}
