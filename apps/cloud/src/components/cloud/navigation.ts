import {
  Bot,
  CalendarClock,
  CalendarRange,
  CircleDot,
  FolderKanban,
  Layers,
  MessageSquare,
  Monitor,
  Plug,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Users,
  Workflow,
} from "lucide-react";
import type { CloudRole } from "@/lib/cloud-contract";

export const cloudNavigation = [
  {
    label: "Workspace",
    items: [
      { href: "/cloud/issues", label: "Issues", icon: CircleDot },
      { href: "/cloud/projects", label: "Projects", icon: FolderKanban },
      { href: "/cloud/cycles", label: "Cycles", icon: CalendarRange },
      { href: "/cloud/teams", label: "Teams", icon: Users },
    ],
  },
  {
    label: "Automation",
    items: [
      { href: "/cloud/tasks", label: "AI tasks", icon: Bot },
      { href: "/cloud/chat", label: "Chat", icon: MessageSquare },
      { href: "/cloud/schedules", label: "Schedules", icon: CalendarClock },
      { href: "/instances", label: "Clients", icon: Monitor, admin: true },
    ],
  },
  {
    label: "Organization",
    items: [
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
      {
        href: "/cloud/settings",
        label: "Settings",
        icon: Settings2,
        admin: true,
      },
    ],
  },
];

export const clientNavigation = [
  { href: "/instances", label: "Clients", icon: Monitor },
  { href: "/workspaces", label: "Workspaces", icon: FolderKanban },
  { href: "/copilot", label: "Copilot", icon: Bot },
  { href: "/enrollment", label: "Enrollment", icon: Plug },
  { href: "/settings", label: "Profiles", icon: SlidersHorizontal },
  { href: "/privacy", label: "Privacy", icon: ShieldCheck },
];

export function navigationForRole(role: CloudRole) {
  return cloudNavigation.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) =>
        !("admin" in item && item.admin) ||
        role === "owner" ||
        role === "admin",
    ),
  }));
}
