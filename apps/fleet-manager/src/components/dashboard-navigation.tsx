"use client";

import { KeyRound, Monitor, Settings2, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const items: {
  href: string;
  label: string;
  icon: typeof Monitor;
  settingsOnly?: boolean;
}[] = [
  { href: "/instances", label: "Instances", icon: Monitor },
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
    <nav className="grid grid-cols-4 gap-1 px-3 py-2 lg:grid-cols-1 lg:px-2">
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
                "flex min-w-0 flex-col items-center justify-center gap-1 rounded-lg px-1 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:h-9 sm:flex-row sm:gap-2 sm:px-3 sm:py-0 sm:text-sm lg:justify-start",
                active && "bg-primary/10 text-primary",
              )}
            >
              <Icon className="size-4" />
              {item.label}
            </Link>
          );
        })}
    </nav>
  );
}
