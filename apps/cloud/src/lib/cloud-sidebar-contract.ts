import { z } from "zod";
import { cloudId } from "./cloud-contract";
import {
  holderCan,
  type CloudPermission,
  type PermissionHolder,
} from "./cloud-permissions";

export const settingsPermissions = [
  "settings.manage",
  "members.manage",
  "roles.manage",
  "git.manage",
] as const satisfies readonly CloudPermission[];

export const sidebarPlacements = ["show", "more", "hide"] as const;
export type SidebarPlacement = (typeof sidebarPlacements)[number];
export type SidebarGroup = "top" | "workspace";

export interface SidebarTab {
  href: string;
  label: string;
  description: string;
  permission?: CloudPermission;
}

export const sidebarItems = [
  {
    id: "inbox",
    label: "Inbox",
    href: "/cloud/inbox",
    group: "top",
    placement: "show",
    description:
      "Notifications about issues you are assigned to, mentioned in or subscribed to.",
  },
  {
    id: "my-issues",
    label: "My issues",
    href: "/cloud/issues?scope=mine",
    group: "top",
    placement: "show",
    description: "Issues assigned to you across all of your teams.",
  },
  {
    id: "pulse",
    label: "Pulse",
    href: "/cloud/pulse",
    group: "top",
    placement: "show",
    description:
      "Status updates posted on projects, newest first, so you can follow progress without opening each project.",
  },
  {
    id: "agent",
    label: "Agent",
    href: "/cloud/chat",
    group: "top",
    placement: "show",
    permission: "ai.chat",
    fullBleed: true,
    description:
      "Ask the AI assistant about your workspace. It drafts issues and changes that only apply after you confirm them.",
  },
  {
    id: "activity",
    label: "AI activity",
    href: "/cloud/activity",
    group: "top",
    placement: "show",
    tabs: [
      {
        href: "/cloud/activity",
        label: "Activity",
        description:
          "A log of everything the AI did: Agent answers and proposals, task progress and model calls. Entries are kept for 90 days.",
      },
      {
        href: "/cloud/tasks",
        label: "AI tasks",
        description:
          "AI tasks do coding work on an issue in a sandbox or on a linked client and report back. Start one from an issue.",
      },
    ],
  },
  {
    id: "issues",
    label: "Issues",
    href: "/cloud/issues",
    group: "workspace",
    placement: "show",
    description: "All issues in the teams you can access.",
  },
  {
    id: "pull-requests",
    label: "Pull requests",
    href: "/cloud/pull-requests",
    group: "workspace",
    placement: "show",
    integration: "git",
    tabs: [
      {
        href: "/cloud/pull-requests",
        label: "Pull requests",
        description:
          "Pull requests from connected GitHub and GitLab repositories, grouped by what they need next.",
      },
      {
        href: "/cloud/reviews",
        label: "Reviews",
        description:
          "Pull requests waiting for your review and the ones you opened, grouped by what they need from you.",
      },
    ],
  },
  {
    id: "initiatives",
    label: "Initiatives",
    href: "/cloud/initiatives",
    group: "workspace",
    placement: "show",
    description:
      "Long-term goals that group several projects, so you can track progress above project level.",
  },
  {
    id: "projects",
    label: "Projects",
    href: "/cloud/projects",
    group: "workspace",
    placement: "show",
    tabs: [
      {
        href: "/cloud/projects",
        label: "Projects",
        description:
          "Time-bound pieces of work with a lead, a target date and progress across their issues.",
      },
      {
        href: "/cloud/roadmap",
        label: "Roadmap",
        description: "Projects and their milestones on a timeline.",
      },
    ],
  },
  {
    id: "views",
    label: "Views",
    href: "/cloud/views",
    group: "workspace",
    placement: "show",
    description:
      "Saved issue filters that you can reopen at any time or share with your team.",
  },
  {
    id: "cycles",
    label: "Cycles",
    href: "/cloud/cycles",
    group: "workspace",
    placement: "show",
    description:
      "Fixed-length iterations, like sprints, for planning how much work a team takes on.",
  },
  {
    id: "releases",
    label: "Releases",
    href: "/cloud/releases",
    group: "workspace",
    placement: "show",
    permission: "releases.view",
    tabs: [
      {
        href: "/cloud/releases",
        label: "Releases",
        description:
          "Collect shipped issues into releases and publish posts about them on your channels.",
      },
      {
        href: "/cloud/releases/products",
        label: "Products",
        description:
          "The products you ship, with the voice, channels and rules Agent follows when it writes release posts.",
      },
      {
        href: "/cloud/releases/connections",
        label: "Connections",
        permission: "releases.manage",
        description:
          "Social accounts and publishing channels that release posts go out to.",
      },
    ],
  },
  {
    id: "automations",
    label: "Automations",
    href: "/cloud/automations",
    group: "workspace",
    placement: "show",
    tabs: [
      {
        href: "/cloud/automations",
        label: "Automations",
        description:
          "Rules that act when something happens in a team, such as labeling, assigning, commenting or asking Agent.",
      },
      {
        href: "/cloud/schedules",
        label: "Schedules",
        description:
          "Create issues or run AI tasks on a timetable, such as a nightly dependency check.",
      },
    ],
  },
  {
    id: "clients",
    label: "Clients",
    href: "/instances",
    group: "workspace",
    placement: "show",
    permission: ["clients.manage", "ai.manage"],
    tabs: [
      {
        href: "/instances",
        label: "Devices",
        permission: "clients.manage",
        description:
          "Computers running the Machdoch app that are linked to this organization. Check their status, control them remotely or revoke them.",
      },
      {
        href: "/workspaces",
        label: "Workspaces",
        permission: "clients.manage",
        description:
          "Projects open on linked clients. Open one to chat, run tasks or use its files and terminal remotely.",
      },
      {
        href: "/enrollment",
        label: "Enrollment",
        permission: "clients.manage",
        description:
          "Create the keys that link a new client to this organization.",
      },
      {
        href: "/settings",
        label: "Profiles",
        permission: "ai.manage",
        description:
          "Shared configuration for clients, such as instructions, prompts, MCP servers and secrets. Assign a profile to clients to keep them in sync.",
      },
    ],
  },
  {
    id: "teams",
    label: "Teams",
    href: "/cloud/teams",
    group: "workspace",
    placement: "more",
    description:
      "Groups of people with their own issues, workflow, labels and cycles.",
  },
  {
    id: "connections",
    label: "Connected apps",
    href: "/cloud/connections",
    group: "workspace",
    placement: "more",
    description: "Apps and MCP clients you allowed to work with your account.",
  },
  {
    id: "providers",
    label: "AI providers",
    href: "/cloud/providers",
    group: "workspace",
    placement: "more",
    permission: "ai.manage",
    tabs: [
      {
        href: "/cloud/providers",
        label: "Providers",
        description:
          "Accounts for AI models, as API keys or signed-in CLIs, that Agent and AI tasks use.",
      },
      {
        href: "/cloud/execution",
        label: "Execution profiles",
        description:
          "Where AI tasks run, with which repository, provider and model, and which checks they must pass.",
      },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    href: "/cloud/settings",
    group: "workspace",
    placement: "more",
    permission: settingsPermissions,
    description:
      "Organization, members, roles, sign-in, email and Git settings.",
  },
] as const satisfies readonly ({
  id: string;
  label: string;
  href: string;
  group: SidebarGroup;
  placement: SidebarPlacement;
  permission?: CloudPermission | readonly CloudPermission[];
  integration?: "git";
  fullBleed?: true;
} & (
  | { description: string; tabs?: never }
  | { tabs: readonly [SidebarTab, ...SidebarTab[]]; description?: never }
))[];
export type SidebarItemId = (typeof sidebarItems)[number]["id"];
export type SidebarItem = (typeof sidebarItems)[number];
type PageHrefs<Item> = Item extends { tabs: readonly (infer Tab)[] }
  ? Tab extends { href: infer Href }
    ? Href
    : never
  : Item extends { href: infer Href }
    ? Href
    : never;
export type SidebarPageHref = PageHrefs<SidebarItem>;
export const sidebarItemIds = sidebarItems.map((item) => item.id) as [
  SidebarItemId,
  ...SidebarItemId[],
];
export const sidebarSections = ["favorites", "teams", "devices"] as const;
export type SidebarSection = (typeof sidebarSections)[number];

const unique = <T>(values: T[]) => new Set(values).size === values.length;

export const sidebarPreferencesSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        id: z.enum(sidebarItemIds),
        placement: z.enum(sidebarPlacements),
      }),
    )
    .max(sidebarItemIds.length)
    .refine((items) => unique(items.map((item) => item.id)), {
      message: "List each sidebar item once.",
    }),
  hiddenSections: z
    .array(z.enum(sidebarSections))
    .max(sidebarSections.length)
    .refine(unique, { message: "List each section once." }),
  hiddenTeamIds: z
    .array(cloudId)
    .max(500)
    .refine(unique, { message: "List each team once." }),
});
export type SidebarPreferences = z.infer<typeof sidebarPreferencesSchema>;
export const defaultSidebarPreferences: SidebarPreferences = {
  items: [],
  hiddenSections: [],
  hiddenTeamIds: [],
};

export interface SidebarEntry {
  item: SidebarItem;
  placement: SidebarPlacement;
}

export interface SidebarAccess extends PermissionHolder {
  git: boolean;
}

export type SidebarPage = Omit<SidebarTab, "permission">;

export function sidebarPages(
  item: SidebarItem,
  access: PermissionHolder,
): SidebarPage[] {
  if (!("tabs" in item))
    return [
      { href: item.href, label: item.label, description: item.description },
    ];
  const tabs: readonly SidebarTab[] = item.tabs;
  return tabs.filter(
    (tab) => !tab.permission || holderCan(access, tab.permission),
  );
}

export function canSeeSidebarItem(
  item: SidebarItem,
  access: SidebarAccess,
): boolean {
  if ("integration" in item && !access.git) return false;
  if ("permission" in item) {
    const required: readonly CloudPermission[] =
      typeof item.permission === "string" ? [item.permission] : item.permission;
    if (!required.some((permission) => holderCan(access, permission)))
      return false;
  }
  return sidebarPages(item, access).length > 0;
}

export function sidebarEntries(
  preferences: SidebarPreferences,
  access: SidebarAccess,
): SidebarEntry[] {
  const available = sidebarItems.filter((item) =>
    canSeeSidebarItem(item, access),
  );
  const chosen = preferences.items.flatMap((entry) => {
    const item = available.find((candidate) => candidate.id === entry.id);
    return item ? [{ item, placement: entry.placement }] : [];
  });
  const added = available
    .filter((item) => !chosen.some((entry) => entry.item.id === item.id))
    .map((item) => ({ item, placement: item.placement }));
  return (["top", "workspace"] as const).flatMap((group) =>
    [...chosen, ...added].filter((entry) => entry.item.group === group),
  );
}

export interface ResolvedSidebar {
  top: SidebarItem[];
  workspace: SidebarItem[];
  more: SidebarItem[];
  sections: Record<SidebarSection, boolean>;
  hiddenTeamIds: ReadonlySet<string>;
}

export function resolveSidebar(
  preferences: SidebarPreferences,
  access: SidebarAccess,
): ResolvedSidebar {
  const entries = sidebarEntries(preferences, access);
  const placed = (group: SidebarGroup | null, placement: SidebarPlacement) =>
    entries
      .filter(
        (entry) =>
          entry.placement === placement &&
          (group === null || entry.item.group === group),
      )
      .map((entry) => entry.item);
  return {
    top: placed("top", "show"),
    workspace: placed("workspace", "show"),
    more: placed(null, "more"),
    sections: Object.fromEntries(
      sidebarSections.map((section) => [
        section,
        !preferences.hiddenSections.includes(section),
      ]),
    ) as Record<SidebarSection, boolean>,
    hiddenTeamIds: new Set(preferences.hiddenTeamIds),
  };
}

export function sidebarPreferencesFrom(
  entries: SidebarEntry[],
  hiddenSections: SidebarSection[],
  hiddenTeamIds: string[],
): SidebarPreferences {
  return {
    items: entries.map((entry) => ({
      id: entry.item.id,
      placement: entry.placement,
    })),
    hiddenSections,
    hiddenTeamIds,
  };
}

export function moveSidebarEntry(
  entries: SidebarEntry[],
  id: SidebarItemId,
  targetId: SidebarItemId,
): SidebarEntry[] {
  const from = entries.findIndex((entry) => entry.item.id === id);
  const to = entries.findIndex((entry) => entry.item.id === targetId);
  if (
    from < 0 ||
    to < 0 ||
    from === to ||
    entries[from]!.item.group !== entries[to]!.item.group
  )
    return entries;
  const next = [...entries];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}
