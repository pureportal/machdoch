"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  CircleDot,
  Bot,
  MessageSquare,
  Layers,
  CalendarRange,
  CalendarClock,
  Users,
  Settings2,
  Monitor,
  Plug,
  LogOut,
  Menu,
  X,
} from "lucide-react";
import { useState } from "react";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import { cloudRequest } from "./api-client";

const navigation = [
  { href: "/cloud/issues", label: "Issues", icon: CircleDot },
  { href: "/cloud/tasks", label: "AI tasks", icon: Bot },
  { href: "/cloud/chat", label: "Chat", icon: MessageSquare },
  { href: "/cloud/projects", label: "Projects", icon: Layers },
  { href: "/cloud/cycles", label: "Cycles", icon: CalendarRange },
  { href: "/cloud/schedules", label: "Schedules", icon: CalendarClock },
  { href: "/cloud/teams", label: "Teams", icon: Users },
  { href: "/cloud/settings", label: "Settings", icon: Settings2 },
  { href: "/cloud/connections", label: "Connected apps", icon: Plug },
  { href: "/instances", label: "Clients", icon: Monitor },
];

export function CloudShell({
  workspace,
  children,
}: {
  workspace: CloudWorkspace;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  return (
    <div
      className="cloud-shell"
      data-cloud-accent={workspace.organization.accent}
    >
      <a className="fleet-skip-link" href="#cloud-content">
        Skip to content
      </a>
      <header className="cloud-mobile-header">
        <button
          type="button"
          aria-label={open ? "Close navigation" : "Open navigation"}
          aria-expanded={open}
          aria-controls="cloud-navigation"
          onClick={() => setOpen(!open)}
        >
          {open ? <X /> : <Menu />}
        </button>
        <span>machdoch.cloud</span>
      </header>
      <aside id="cloud-navigation" className="cloud-sidebar" data-open={open}>
        <Link className="cloud-brand" href="/cloud/issues">
          machdoch<span>.cloud</span>
        </Link>
        <div className="cloud-organization">{workspace.organization.name}</div>
        <nav aria-label="Cloud navigation">
          {navigation
            .filter(
              (item) =>
                item.href !== "/cloud/settings" ||
                ["owner", "admin"].includes(workspace.actor.role),
            )
            .map(({ href, label, icon: Icon }) => (
              <Link
                href={href}
                key={href}
                onClick={() => setOpen(false)}
                aria-current={
                  pathname === href || pathname.startsWith(`${href}/`)
                    ? "page"
                    : undefined
                }
              >
                <Icon size={17} />
                <span>{label}</span>
              </Link>
            ))}
        </nav>
        <div className="cloud-sidebar-footer">
          <Link href="/cloud/account">{workspace.actor.name}</Link>
          <button
            type="button"
            aria-label="Sign out"
            onClick={() =>
              void cloudRequest("auth/logout", { method: "POST" })
                .then(() => location.assign("/cloud/login"))
                .catch((reason: Error) => setError(reason.message))
            }
          >
            <LogOut size={17} />
          </button>
        </div>
        {error && <p role="alert">{error}</p>}
      </aside>
      <main id="cloud-content" tabIndex={-1} className="cloud-content">
        {children}
      </main>
    </div>
  );
}
