import {
  holderCan,
  type CloudPermission,
  type PermissionHolder,
} from "./cloud-permissions";

export const settingsGroups = [
  { id: "personal", label: "Personal" },
  { id: "issues", label: "Issues" },
  { id: "projects", label: "Projects" },
  { id: "features", label: "Features" },
  { id: "administration", label: "Administration" },
] as const;
export type SettingsGroupId = (typeof settingsGroups)[number]["id"];

interface SettingsSectionDefinition {
  group: SettingsGroupId;
  label: string;
  keywords: readonly string[];
  view: readonly CloudPermission[] | null;
  manage: CloudPermission | null;
}

export const settingsSections = {
  preferences: {
    group: "personal",
    label: "Preferences",
    keywords: ["appearance", "theme", "dark mode", "privacy", "analytics"],
    view: null,
    manage: null,
  },
  profile: {
    group: "personal",
    label: "Profile",
    keywords: ["name", "email", "avatar"],
    view: null,
    manage: null,
  },
  notifications: {
    group: "personal",
    label: "Notifications",
    keywords: [
      "inbox",
      "email",
      "slack",
      "teams",
      "mobile",
      "snooze",
      "quiet hours",
    ],
    view: null,
    manage: null,
  },
  "code-reviews": {
    group: "personal",
    label: "Code & reviews",
    keywords: ["pull request", "review", "diff", "commits"],
    view: null,
    manage: null,
  },
  security: {
    group: "personal",
    label: "Security & access",
    keywords: [
      "2fa",
      "two-factor",
      "password",
      "passkey",
      "sessions",
      "sign-in",
      "connected apps",
      "oauth",
      "mcp clients",
    ],
    view: null,
    manage: null,
  },
  "connected-accounts": {
    group: "personal",
    label: "Connected accounts",
    keywords: ["github", "gitlab", "mcp connectors"],
    view: null,
    manage: null,
  },
  "agent-personalization": {
    group: "personal",
    label: "Agent personalization",
    keywords: ["instructions", "harness", "model", "placement", "repositories"],
    view: null,
    manage: null,
  },
  "issue-labels": {
    group: "issues",
    label: "Labels",
    keywords: ["issue labels", "tags"],
    view: null,
    manage: "planning.edit",
  },
  "workflow-states": {
    group: "issues",
    label: "Workflow states",
    keywords: ["status", "statuses", "workflow"],
    view: null,
    manage: "teams.manage",
  },
  slas: {
    group: "issues",
    label: "SLAs",
    keywords: ["service level", "breach", "deadline", "priority"],
    view: null,
    manage: "settings.manage",
  },
  "issue-templates": {
    group: "issues",
    label: "Templates",
    keywords: ["issue templates"],
    view: null,
    manage: "planning.edit",
  },
  "project-labels": {
    group: "projects",
    label: "Labels",
    keywords: ["project labels"],
    view: null,
    manage: "planning.edit",
  },
  "project-statuses": {
    group: "projects",
    label: "Statuses",
    keywords: ["project statuses"],
    view: null,
    manage: "settings.manage",
  },
  "project-updates": {
    group: "projects",
    label: "Updates",
    keywords: ["project updates", "cadence", "reminders"],
    view: null,
    manage: "settings.manage",
  },
  ai: {
    group: "features",
    label: "AI & agents",
    keywords: ["providers", "models", "api keys", "agent", "instructions"],
    view: ["ai.manage"],
    manage: "ai.manage",
  },
  execution: {
    group: "features",
    label: "Execution",
    keywords: [
      "sandbox",
      "runner",
      "client",
      "device",
      "profiles",
      "autopilot",
    ],
    view: ["ai.manage"],
    manage: "ai.manage",
  },
  loops: {
    group: "features",
    label: "Loops",
    keywords: [
      "automations",
      "schedules",
      "trusted sources",
      "triggers",
      "budget",
      "code access",
    ],
    view: null,
    manage: "settings.manage",
  },
  initiatives: {
    group: "features",
    label: "Initiatives",
    keywords: ["roadmap"],
    view: null,
    manage: "planning.edit",
  },
  "customer-requests": {
    group: "features",
    label: "Customer requests",
    keywords: ["asks", "intake", "customers", "feedback"],
    view: null,
    manage: "settings.manage",
  },
  releases: {
    group: "features",
    label: "Releases",
    keywords: ["pipelines", "deployments", "products", "channels"],
    view: ["releases.view"],
    manage: "releases.manage",
  },
  pulse: {
    group: "features",
    label: "Pulse",
    keywords: ["updates feed", "digest"],
    view: null,
    manage: "settings.manage",
  },
  integrations: {
    group: "features",
    label: "Integrations",
    keywords: ["github", "gitlab", "webhooks", "repositories", "git"],
    view: ["git.view", "git.manage"],
    manage: "git.manage",
  },
  members: {
    group: "administration",
    label: "Members",
    keywords: ["people", "users", "suspend", "access"],
    view: ["members.view", "members.manage"],
    manage: "members.manage",
  },
  roles: {
    group: "administration",
    label: "Roles",
    keywords: ["permissions"],
    view: ["roles.manage", "members.manage"],
    manage: "roles.manage",
  },
  invitations: {
    group: "administration",
    label: "Invitations",
    keywords: ["invite", "join link"],
    view: ["members.manage"],
    manage: "members.manage",
  },
  sso: {
    group: "administration",
    label: "SSO",
    keywords: ["saml", "oidc", "authentication", "sign-in", "single sign-on"],
    view: ["settings.manage"],
    manage: "settings.manage",
  },
  email: {
    group: "administration",
    label: "Email",
    keywords: ["smtp", "mail", "sender"],
    view: ["settings.manage"],
    manage: "settings.manage",
  },
  branding: {
    group: "administration",
    label: "Branding",
    keywords: ["organization", "logo", "colors", "name", "theme"],
    view: ["settings.manage"],
    manage: "settings.manage",
  },
  mimorii: {
    group: "administration",
    label: "Mimorii",
    keywords: ["memory", "knowledge"],
    view: ["settings.manage"],
    manage: "settings.manage",
  },
} as const satisfies Record<string, SettingsSectionDefinition>;

export type SettingsSectionId = keyof typeof settingsSections;
export const settingsSectionIds = Object.keys(
  settingsSections,
) as SettingsSectionId[];

export const teamSettingsTabs = [
  { id: "workflow", label: "Workflow" },
  { id: "cycles", label: "Cycles" },
  { id: "estimates", label: "Estimates" },
  { id: "triage", label: "Triage" },
  { id: "members", label: "Members" },
] as const;
export type TeamSettingsTab = (typeof teamSettingsTabs)[number]["id"];

export type SettingsAccess = "edit" | "read" | "hidden";

export function isSettingsSection(value: string): value is SettingsSectionId {
  return Object.hasOwn(settingsSections, value);
}

export function settingsSectionAccess(
  holder: PermissionHolder,
  id: SettingsSectionId,
): SettingsAccess {
  const section: SettingsSectionDefinition = settingsSections[id];
  const canManage = !section.manage || holderCan(holder, section.manage);
  if (canManage) return "edit";
  const canView =
    !section.view ||
    section.view.some((permission) => holderCan(holder, permission));
  return canView ? "read" : "hidden";
}

export function teamSettingsAccess(holder: PermissionHolder): SettingsAccess {
  return holderCan(holder, "teams.manage") ? "edit" : "read";
}

export interface SettingsNavigationEntry {
  id: SettingsSectionId;
  label: string;
  href: string;
  access: Exclude<SettingsAccess, "hidden">;
}

export interface SettingsNavigationGroup {
  id: SettingsGroupId;
  label: string;
  entries: SettingsNavigationEntry[];
}

export function settingsHref(id: SettingsSectionId): string {
  return `/cloud/settings/${id}`;
}

export function teamSettingsHref(teamId: string, tab: TeamSettingsTab): string {
  return `/cloud/settings/teams/${teamId}/${tab}`;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function settingsSectionMatches(
  id: SettingsSectionId,
  query: string,
): boolean {
  const needle = normalize(query);
  if (!needle) return true;
  const section: SettingsSectionDefinition = settingsSections[id];
  const group = settingsGroups.find((entry) => entry.id === section.group);
  return [section.label, group?.label ?? "", ...section.keywords].some((text) =>
    normalize(text).includes(needle),
  );
}

export function settingsNavigation(
  holder: PermissionHolder,
  query = "",
): SettingsNavigationGroup[] {
  return settingsGroups.flatMap((group) => {
    const entries = settingsSectionIds.flatMap((id) => {
      const section: SettingsSectionDefinition = settingsSections[id];
      if (section.group !== group.id) return [];
      const access = settingsSectionAccess(holder, id);
      if (access === "hidden" || !settingsSectionMatches(id, query)) return [];
      return [{ id, label: section.label, href: settingsHref(id), access }];
    });
    return entries.length
      ? [{ id: group.id, label: group.label, entries }]
      : [];
  });
}

export interface SettingsTeam {
  id: string;
  name: string;
  parentId: string | null;
}

export interface SettingsTeamNode {
  team: SettingsTeam;
  path: string;
  children: SettingsTeamNode[];
}

export function settingsTeamTree(
  teams: readonly SettingsTeam[],
): SettingsTeamNode[] {
  const known = new Set(teams.map((team) => team.id));
  const build = (
    parentId: string | null,
    prefix: string,
    seen: ReadonlySet<string>,
  ): SettingsTeamNode[] =>
    teams
      .filter(
        (team) =>
          !seen.has(team.id) &&
          (parentId === null
            ? team.parentId === null || !known.has(team.parentId)
            : team.parentId === parentId),
      )
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((team) => {
        const path = prefix ? `${prefix} › ${team.name}` : team.name;
        return {
          team,
          path,
          children: build(team.id, path, new Set([...seen, team.id])),
        };
      });
  return build(null, "", new Set());
}

const accountTabSections: Record<string, SettingsSectionId> = {
  appearance: "preferences",
  privacy: "preferences",
  security: "security",
  sessions: "security",
  git: "connected-accounts",
};

const administrationTabSections: Record<string, SettingsSectionId> = {
  organization: "branding",
  members: "members",
  roles: "roles",
  authentication: "sso",
  email: "email",
  git: "integrations",
  mimorii: "mimorii",
};

export function legacySettingsSection(
  route: "account" | "settings" | "connections" | "providers" | "execution",
  tab?: string,
): SettingsSectionId {
  switch (route) {
    case "account":
      return (tab && accountTabSections[tab]) || "preferences";
    case "settings":
      return (tab && administrationTabSections[tab]) || "preferences";
    case "connections":
      return "security";
    case "providers":
      return "ai";
    case "execution":
      return "execution";
  }
}

export function legacySettingsHref(
  route: Parameters<typeof legacySettingsSection>[0],
  params: Record<string, string | string[] | undefined>,
): string {
  const tab = typeof params.tab === "string" ? params.tab : undefined;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (key !== "tab")
      for (const entry of [value ?? []].flat()) query.append(key, entry);
  const search = query.toString();
  const href = settingsHref(legacySettingsSection(route, tab));
  return search ? `${href}?${search}` : href;
}
