import {
  Activity,
  BrainCircuit,
  CalendarRange,
  CircleDot,
  CircleDotDashed,
  CircleUserRound,
  FolderKanban,
  GitPullRequest,
  Inbox,
  Layers,
  Layers2,
  Megaphone,
  Monitor,
  Plug,
  Settings2,
  Sparkles,
  Target,
  Users,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import {
  canSeeSidebarItem,
  sidebarItems,
  sidebarPages,
  type SidebarAccess,
  type SidebarItem,
  type SidebarItemId,
  type SidebarPage,
} from "@/lib/cloud-sidebar-contract";

export interface NavigationItem {
  href: string;
  label: string;
  icon: LucideIcon;
  paths?: readonly string[];
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
  teams: Users,
  connections: Plug,
  providers: Layers,
  settings: Settings2,
};

export function navigationItem(
  item: SidebarItem,
  access: SidebarAccess,
): NavigationItem {
  const pages = sidebarPages(item, access);
  return {
    href: pages[0]!.href,
    label: item.label,
    icon: sidebarIcons[item.id],
    paths: pages.map((page) => page.href),
  };
}

export function sidebarAccess(workspace: CloudWorkspace): SidebarAccess {
  return {
    owner: workspace.actor.owner,
    permissions: workspace.actor.permissions,
    git: workspace.gitProviders.length > 0,
  };
}

export function navigationFor(access: SidebarAccess): NavigationItem[] {
  return sidebarItems
    .filter((item) => canSeeSidebarItem(item, access))
    .flatMap((item) =>
      sidebarPages(item, access).map((page, index) => ({
        href: page.href,
        label: index === 0 ? item.label : page.label,
        icon: sidebarIcons[item.id],
      })),
    );
}

export interface NavigationSection {
  label: string;
  pages: SidebarPage[];
  page: SidebarPage;
  fullBleed: boolean;
}

export function navigationSection(
  access: SidebarAccess,
  pathname: string,
  search: URLSearchParams,
): NavigationSection | null {
  for (const item of sidebarItems) {
    if (!canSeeSidebarItem(item, access)) continue;
    const pages = sidebarPages(item, access);
    const page = pages.find(
      (candidate) =>
        candidate.href.split("?")[0] === pathname &&
        isNavigationActive(candidate.href, pathname, search),
    );
    if (page)
      return {
        label: item.label,
        pages,
        page,
        fullBleed: "fullBleed" in item,
      };
  }
  return null;
}

export const pageNavigation: NavigationItem[] = [
  { href: "/cloud/triage", label: "Triage", icon: CircleDotDashed },
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
