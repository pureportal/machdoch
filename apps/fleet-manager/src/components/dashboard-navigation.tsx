"use client";

import { KeyRound, LayoutDashboard, Settings2, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const items: {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  settingsOnly?: boolean;
}[] = [
  { href: "/instances", label: "Overview", icon: LayoutDashboard },
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
    <nav
      aria-label="Fleet Manager"
      className="fleet-navigation grid auto-cols-fr grid-flow-col gap-1 px-3 py-2 lg:grid-flow-row lg:grid-cols-1 lg:gap-2 lg:px-4"
    >
      {items
        .filter((item) => !item.settingsOnly || settingsEnabled)
        .map((item) => {
          const Icon = item.icon;
          const active =
            pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "fleet-nav-item flex min-w-0 flex-col items-center justify-center gap-1.5 rounded-xl px-1 py-2 text-[11px] font-medium transition-colors lg:min-h-12 lg:flex-row lg:justify-start lg:gap-3 lg:px-4 lg:text-sm",
                active && "fleet-nav-active",
              )}
            >
              <Icon className="size-[18px]" aria-hidden="true" />
              {item.label}
            </Link>
          );
        })}
    </nav>
  );
}
