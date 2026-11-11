import {
  Activity,
  Bot,
  CalendarClock,
  CalendarRange,
  CircleDot,
  CircleDotDashed,
  CircleUserRound,
  FolderKanban,
  Inbox,
  Layers,
  Map,
  Sparkles,
  Target,
  Layers2,
  Monitor,
  Plug,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Users,
  Workflow,
} from "lucide-react";
import type { CloudRole } from "@/lib/cloud-contract";

export interface NavigationItem {
  href: string;
  label: string;
  icon: typeof Inbox;
  admin?: boolean;
}

export const primaryNavigation: NavigationItem[] = [
  { href: "/cloud/inbox", label: "Inbox", icon: Inbox },
  { href: "/cloud/pulse", label: "Pulse", icon: Activity },
  {
    href: "/cloud/issues?scope=mine",
    label: "My issues",
    icon: CircleUserRound,
  },
  { href: "/cloud/chat", label: "Agent", icon: Sparkles },
];

export const workspaceNavigation: NavigationItem[] = [
  { href: "/cloud/issues", label: "Issues", icon: CircleDot },
  { href: "/cloud/initiatives", label: "Initiatives", icon: Target },
  { href: "/cloud/projects", label: "Projects", icon: FolderKanban },
  { href: "/cloud/views", label: "Views", icon: Layers2 },
  { href: "/cloud/roadmap", label: "Roadmap", icon: Map },
  { href: "/cloud/cycles", label: "Cycles", icon: CalendarRange },
  { href: "/cloud/tasks", label: "AI tasks", icon: Bot },
  { href: "/cloud/schedules", label: "Schedules", icon: CalendarClock },
];

export const pageNavigation: NavigationItem[] = [
  { href: "/cloud/triage", label: "Triage", icon: CircleDotDashed },
];

export const organizationNavigation: NavigationItem[] = [
  { href: "/cloud/teams", label: "Teams", icon: Users },
  { href: "/instances", label: "Clients", icon: Monitor, admin: true },
  { href: "/cloud/connections", label: "Connected apps", icon: Plug },
  {
    href: "/cloud/providers",
    label: "AI providers",
    icon: Layers,
    admin: true,
  },
  {
    href: "/cloud/execution",
    label: "AI execution",
    icon: Workflow,
    admin: true,
  },
  { href: "/cloud/settings", label: "Settings", icon: Settings2, admin: true },
];

export const clientNavigation = [
  { href: "/instances", label: "Clients", icon: Monitor },
  { href: "/workspaces", label: "Workspaces", icon: FolderKanban },
  { href: "/copilot", label: "Copilot", icon: Bot },
  { href: "/enrollment", label: "Enrollment", icon: Plug },
  { href: "/settings", label: "Profiles", icon: SlidersHorizontal },
  { href: "/privacy", label: "Privacy", icon: ShieldCheck },
];

export function visibleForRole(items: NavigationItem[], role: CloudRole) {
  return items.filter(
    (item) => !item.admin || role === "owner" || role === "admin",
  );
}

export function navigationForRole(role: CloudRole) {
  return [
    {
      label: "Workspace",
      items: [...primaryNavigation, ...workspaceNavigation],
    },
    {
      label: "Organization",
      items: visibleForRole(organizationNavigation, role),
    },
  ];
}

export function isNavigationActive(
  href: string,
  pathname: string,
  search: URLSearchParams,
): boolean {
  const [path, query] = href.split("?") as [string, string | undefined];
  if (pathname !== path && !pathname.startsWith(`${path}/`)) return false;
  if (query) {
    const expected = new URLSearchParams(query);
    return [...expected].every(([name, value]) => search.get(name) === value);
  }
  return !(
    pathname === path &&
    (search.get("scope") === "mine" || search.has("teamId"))
  );
}
