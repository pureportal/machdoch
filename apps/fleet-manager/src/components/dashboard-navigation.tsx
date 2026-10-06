"use client";

import {
  FolderKanban,
  KeyRound,
  LayoutDashboard,
  MessagesSquare,
  Settings2,
  Users,
} from "lucide-react";
import { ApplicationNavigation } from "@machdoch/product-ui";
import { usePathname } from "next/navigation";

const items: {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  settingsOnly?: boolean;
}[] = [
  { href: "/instances", label: "Overview", icon: LayoutDashboard },
  { href: "/workspaces", label: "Workspaces", icon: FolderKanban },
  { href: "/copilot", label: "Copilot", icon: MessagesSquare },
  { href: "/enrollment", label: "Enrollment", icon: KeyRound },
  { href: "/settings", label: "Settings", icon: Settings2, settingsOnly: true },
  { href: "/users", label: "Users", icon: Users },
];

export function DashboardNavigation({
  settingsEnabled,
}: {
  settingsEnabled: boolean;
}): React.ReactElement {
  const pathname = usePathname();
  return (
    <ApplicationNavigation
      items={items
        .filter((item) => !item.settingsOnly || settingsEnabled)
        .map(({ href, label, icon }) => ({
          id: href,
          href,
          label,
          icon,
          active: pathname === href || pathname.startsWith(`${href}/`),
        }))}
    />
  );
}
