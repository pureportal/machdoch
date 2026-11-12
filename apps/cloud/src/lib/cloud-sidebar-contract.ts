import { z } from "zod";
import { cloudId, type CloudRole } from "./cloud-contract";

export const sidebarPlacements = ["show", "more", "hide"] as const;
export type SidebarPlacement = (typeof sidebarPlacements)[number];
export type SidebarGroup = "top" | "workspace";

export const sidebarItems = [
  {
    id: "inbox",
    label: "Inbox",
    href: "/cloud/inbox",
    group: "top",
    placement: "show",
  },
  {
    id: "my-issues",
    label: "My issues",
    href: "/cloud/issues?scope=mine",
    group: "top",
    placement: "show",
  },
  {
    id: "pulse",
    label: "Pulse",
    href: "/cloud/pulse",
    group: "top",
    placement: "show",
  },
  {
    id: "agent",
    label: "Agent",
    href: "/cloud/chat",
    group: "top",
    placement: "show",
  },
  {
    id: "activity",
    label: "AI activity",
    href: "/cloud/activity",
    group: "top",
    placement: "show",
  },
  {
    id: "issues",
    label: "Issues",
    href: "/cloud/issues",
    group: "workspace",
    placement: "show",
  },
  {
    id: "pull-requests",
    label: "Pull requests",
    href: "/cloud/pull-requests",
    group: "workspace",
    placement: "show",
    integration: "github",
  },
  {
    id: "initiatives",
    label: "Initiatives",
    href: "/cloud/initiatives",
    group: "workspace",
    placement: "show",
  },
  {
    id: "projects",
    label: "Projects",
    href: "/cloud/projects",
    group: "workspace",
    placement: "show",
  },
  {
    id: "views",
    label: "Views",
    href: "/cloud/views",
    group: "workspace",
    placement: "show",
  },
  {
    id: "cycles",
    label: "Cycles",
    href: "/cloud/cycles",
    group: "workspace",
    placement: "show",
  },
  {
    id: "releases",
    label: "Releases",
    href: "/cloud/releases",
    group: "workspace",
    placement: "show",
  },
  {
    id: "automations",
    label: "Automations",
    href: "/cloud/automations",
    group: "workspace",
    placement: "show",
  },
  {
    id: "clients",
    label: "Clients",
    href: "/instances",
    group: "workspace",
    placement: "show",
    admin: true,
  },
  {
    id: "roadmap",
    label: "Roadmap",
    href: "/cloud/roadmap",
    group: "workspace",
    placement: "more",
  },
  {
    id: "tasks",
    label: "AI tasks",
    href: "/cloud/tasks",
    group: "workspace",
    placement: "more",
  },
  {
    id: "schedules",
    label: "Schedules",
    href: "/cloud/schedules",
    group: "workspace",
    placement: "more",
  },
  {
    id: "teams",
    label: "Teams",
    href: "/cloud/teams",
    group: "workspace",
    placement: "more",
  },
  {
    id: "connections",
    label: "Connected apps",
    href: "/cloud/connections",
    group: "workspace",
    placement: "more",
  },
  {
    id: "workspaces",
    label: "Client workspaces",
    href: "/workspaces",
    group: "workspace",
    placement: "more",
    admin: true,
  },
  {
    id: "copilot",
    label: "Copilot",
    href: "/copilot",
    group: "workspace",
    placement: "more",
    admin: true,
  },
  {
    id: "enrollment",
    label: "Enrollment",
    href: "/enrollment",
    group: "workspace",
    placement: "more",
    admin: true,
  },
  {
    id: "profiles",
    label: "Client profiles",
    href: "/settings",
    group: "workspace",
    placement: "more",
    admin: true,
  },
  {
    id: "privacy",
    label: "Client privacy",
    href: "/privacy",
    group: "workspace",
    placement: "more",
    admin: true,
  },
  {
    id: "providers",
    label: "AI providers",
    href: "/cloud/providers",
    group: "workspace",
    placement: "more",
    admin: true,
  },
  {
    id: "execution",
    label: "AI execution",
    href: "/cloud/execution",
    group: "workspace",
    placement: "more",
    admin: true,
  },
  {
    id: "settings",
    label: "Settings",
    href: "/cloud/settings",
    group: "workspace",
    placement: "more",
    admin: true,
  },
] as const satisfies readonly {
  id: string;
  label: string;
  href: string;
  group: SidebarGroup;
  placement: SidebarPlacement;
  admin?: true;
  integration?: "github";
}[];
export type SidebarItemId = (typeof sidebarItems)[number]["id"];
export type SidebarItem = (typeof sidebarItems)[number];
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

export interface SidebarAccess {
  role: CloudRole;
  github: boolean;
}

export function canSeeSidebarItem(
  item: SidebarItem,
  access: SidebarAccess,
): boolean {
  if ("integration" in item && !access.github) return false;
  return (
    !("admin" in item) || access.role === "owner" || access.role === "admin"
  );
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
