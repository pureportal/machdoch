import {
  Activity,
  Bot,
  BrainCircuit,
  CalendarClock,
  CalendarRange,
  CircleDot,
  CircleDotDashed,
  CircleUserRound,
  FolderKanban,
  FolderTree,
  GitPullRequest,
  Inbox,
  KeyRound,
  Layers,
  Layers2,
  Megaphone,
  Map,
  Monitor,
  Plug,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  SquareTerminal,
  Target,
  Users,
  Workflow,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import {
  canSeeSidebarItem,
  sidebarItems,
  type SidebarAccess,
  type SidebarItem,
  type SidebarItemId,
} from "@/lib/cloud-sidebar-contract";

export interface NavigationItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

export const sidebarIcons: Record<SidebarItemId, LucideIcon> = {
  inbox: Inbox,
  "my-issues": CircleUserRound,
  pulse: Activity,
  agent: Sparkles,
  activity: BrainCircuit,
  issues: CircleDot,
  "pull-requests": GitPullRequest,
  initiatives: Target,
  projects: FolderKanban,
  views: Layers2,
  cycles: CalendarRange,
  releases: Megaphone,
  automations: Zap,
  clients: Monitor,
  roadmap: Map,
  tasks: Bot,
  schedules: CalendarClock,
  teams: Users,
  connections: Plug,
  workspaces: FolderTree,
  copilot: SquareTerminal,
  enrollment: KeyRound,
  profiles: SlidersHorizontal,
  privacy: ShieldCheck,
  providers: Layers,
  execution: Workflow,
  settings: Settings2,
};

export function navigationItem(item: SidebarItem): NavigationItem {
  return { href: item.href, label: item.label, icon: sidebarIcons[item.id] };
}

export function sidebarAccess(workspace: CloudWorkspace): SidebarAccess {
  return { role: workspace.actor.role, github: workspace.github };
}

export function navigationFor(access: SidebarAccess): NavigationItem[] {
  return sidebarItems
    .filter((item) => canSeeSidebarItem(item, access))
    .map(navigationItem);
}

export const pageNavigation: NavigationItem[] = [
  { href: "/cloud/triage", label: "Triage", icon: CircleDotDashed },
];

export const clientNavigation: NavigationItem[] = [
  { href: "/instances", label: "Clients", icon: Monitor },
  { href: "/workspaces", label: "Workspaces", icon: FolderTree },
  { href: "/copilot", label: "Copilot", icon: SquareTerminal },
  { href: "/enrollment", label: "Enrollment", icon: KeyRound },
  { href: "/settings", label: "Profiles", icon: SlidersHorizontal },
  { href: "/privacy", label: "Privacy", icon: ShieldCheck },
];

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
