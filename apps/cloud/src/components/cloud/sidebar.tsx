"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  CalendarRange,
  ChevronRight,
  CircleDot,
  CircleDotDashed,
  Ellipsis,
  FolderKanban,
} from "lucide-react";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import {
  favoriteHref,
  type CloudFavorite,
} from "@/lib/cloud-favorite-contract";
import {
  isNavigationActive,
  organizationNavigation,
  primaryNavigation,
  visibleForRole,
  workspaceNavigation,
  type NavigationItem,
} from "./navigation";

const collapsedStorageKey = "machdoch.cloud.sidebar.collapsed";

function useCollapsed() {
  const [collapsed, setCollapsed] = useState<string[]>([]);
  useEffect(() => {
    try {
      const stored = JSON.parse(
        localStorage.getItem(collapsedStorageKey) ?? "[]",
      ) as unknown;
      if (Array.isArray(stored))
        setCollapsed(stored.filter((entry) => typeof entry === "string"));
    } catch {
      localStorage.removeItem(collapsedStorageKey);
    }
  }, []);
  return {
    isOpen: (key: string, initiallyOpen = true) =>
      collapsed.includes(key) !== initiallyOpen,
    toggle: (key: string) =>
      setCollapsed((current) => {
        const next = current.includes(key)
          ? current.filter((entry) => entry !== key)
          : [...current, key];
        localStorage.setItem(collapsedStorageKey, JSON.stringify(next));
        return next;
      }),
  };
}

function Section({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="cloud-navigation-group">
      <button
        type="button"
        className="cloud-navigation-section"
        aria-expanded={open}
        onClick={onToggle}
      >
        {label}
        <ChevronRight size={11} aria-hidden="true" />
      </button>
      {open && children}
    </div>
  );
}

export function Sidebar({
  workspace,
  unread,
  favorites,
  triage,
  onNavigate,
}: {
  workspace: CloudWorkspace;
  unread: number;
  favorites: CloudFavorite[];
  triage: Record<string, number>;
  onNavigate: () => void;
}) {
  const pathname = usePathname();
  const search = useSearchParams();
  const sections = useCollapsed();
  const role = workspace.actor.role;
  const parameters = new URLSearchParams(search);
  const active = (href: string) =>
    isNavigationActive(href, pathname, parameters) ? "page" : undefined;
  const link = ({
    href,
    label,
    icon: Icon,
    count = 0,
  }: Omit<NavigationItem, "icon"> & {
    icon?: NavigationItem["icon"];
    count?: number;
  }) => (
    <Link
      key={href}
      href={href}
      onClick={onNavigate}
      aria-current={
        active(href) ??
        (href === "/instances" &&
        [
          "/instances",
          "/workspaces",
          "/copilot",
          "/enrollment",
          "/settings",
          "/privacy",
        ].some((path) => pathname === path || pathname.startsWith(`${path}/`))
          ? "page"
          : undefined)
      }
    >
      {Icon && <Icon size={15} strokeWidth={1.7} />}
      <span>{label}</span>
      {href === "/cloud/inbox" && unread > 0 && (
        <span className="cloud-navigation-badge">
          {unread > 99 ? "99+" : unread}
          <span className="sr-only"> unread</span>
        </span>
      )}
      {count > 0 && (
        <span className="cloud-navigation-badge">
          {count > 99 ? "99+" : count}
        </span>
      )}
    </Link>
  );
  const organization = visibleForRole(organizationNavigation, role);
  return (
    <nav aria-label="Cloud navigation" className="cloud-navigation-groups">
      <div className="cloud-navigation-group">
        {primaryNavigation.map(link)}
      </div>
      <Section
        label="Workspace"
        open={sections.isOpen("workspace")}
        onToggle={() => sections.toggle("workspace")}
      >
        {workspaceNavigation.map(link)}
        <button
          type="button"
          className="cloud-navigation-more"
          aria-expanded={sections.isOpen("more", false)}
          onClick={() => sections.toggle("more")}
        >
          <Ellipsis size={15} strokeWidth={1.7} />
          <span>More</span>
        </button>
        {sections.isOpen("more", false) && (
          <div className="cloud-navigation-nested">
            {organization.map(link)}
          </div>
        )}
      </Section>
      {favorites.length > 0 && (
        <Section
          label="Favorites"
          open={sections.isOpen("favorites")}
          onToggle={() => sections.toggle("favorites")}
        >
          {favorites.map((favorite) => {
            const href = favoriteHref(favorite);
            const Icon =
              favorite.kind === "issue"
                ? CircleDot
                : favorite.kind === "project"
                  ? FolderKanban
                  : CalendarRange;
            return (
              <Link
                key={`${favorite.kind}:${favorite.id}`}
                href={href}
                onClick={onNavigate}
                aria-current={pathname === href ? "page" : undefined}
              >
                <Icon size={15} strokeWidth={1.7} />
                <span>{favorite.label}</span>
              </Link>
            );
          })}
        </Section>
      )}
      {workspace.teams.length > 0 && (
        <Section
          label="Your teams"
          open={sections.isOpen("teams")}
          onToggle={() => sections.toggle("teams")}
        >
          {workspace.teams.map((team) => {
            const key = `team:${team.id}`;
            const open = sections.isOpen(key, workspace.teams.length < 4);
            const triageEnabled = workspace.workflows.some(
              (workflow) =>
                workflow.teamId === team.id &&
                workflow.statuses.some(
                  (status) => status.category === "triage" && !status.archived,
                ),
            );
            const current = workspace.cycles.find(
              (cycle) => cycle.teamId === team.id && cycle.status === "active",
            );
            const upcoming = workspace.cycles
              .filter(
                (cycle) =>
                  cycle.teamId === team.id && cycle.status === "planned",
              )
              .sort((left, right) =>
                left.startsOn.localeCompare(right.startsOn),
              )[0];
            return (
              <div key={team.id} className="cloud-navigation-team">
                <button
                  type="button"
                  className="cloud-navigation-team-toggle"
                  aria-expanded={open}
                  onClick={() => sections.toggle(key)}
                >
                  <span className="cloud-team-key" aria-hidden="true">
                    {team.key.slice(0, 2)}
                  </span>
                  <span>{team.name}</span>
                  <ChevronRight size={11} aria-hidden="true" />
                </button>
                {open && (
                  <div className="cloud-navigation-nested">
                    {(triageEnabled || !!triage[team.id]) &&
                      link({
                        href: `/cloud/triage?teamId=${team.id}`,
                        label: "Triage",
                        icon: CircleDotDashed,
                        count: triage[team.id],
                      })}
                    {link({
                      href: `/cloud/issues?teamId=${team.id}`,
                      label: "Issues",
                      icon: CircleDot,
                    })}
                    {link({
                      href: `/cloud/cycles?teamId=${team.id}`,
                      label: "Cycles",
                      icon: CalendarRange,
                    })}
                    {(current || upcoming) && (
                      <div className="cloud-navigation-nested">
                        {current &&
                          link({
                            href: `/cloud/cycles/${current.id}`,
                            label: "Current",
                          })}
                        {upcoming &&
                          link({
                            href: `/cloud/cycles/${upcoming.id}`,
                            label: "Upcoming",
                          })}
                      </div>
                    )}
                    {link({
                      href: `/cloud/projects?teamId=${team.id}`,
                      label: "Projects",
                      icon: FolderKanban,
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </Section>
      )}
    </nav>
  );
}
