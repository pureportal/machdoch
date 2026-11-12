"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  CalendarRange,
  CircleDot,
  Ellipsis,
  FolderKanban,
  Layers2,
  Monitor,
  Settings2,
  type LucideIcon,
} from "lucide-react";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import {
  favoriteHref,
  type CloudFavorite,
  type FavoriteKind,
} from "@/lib/cloud-favorite-contract";
import {
  resolveSidebar,
  type SidebarPreferences,
} from "@/lib/cloud-sidebar-contract";
import { navigationItem, sidebarAccess } from "./navigation";
import { Section, SidebarLink, useCollapsed } from "./sidebar-parts";
import { SidebarTeams } from "./sidebar-teams";
import { useClientDevices } from "./use-client-devices";

const visibleDevices = 6;
const favoriteIcons: Record<FavoriteKind, LucideIcon> = {
  issue: CircleDot,
  project: FolderKanban,
  cycle: CalendarRange,
  view: Layers2,
};

export function Sidebar({
  workspace,
  unread,
  favorites,
  triage,
  preferences,
  onNavigate,
  onCustomize,
}: {
  workspace: CloudWorkspace;
  unread: number;
  favorites: CloudFavorite[];
  triage: Record<string, number>;
  preferences: SidebarPreferences;
  onNavigate: () => void;
  onCustomize: () => void;
}) {
  const pathname = usePathname();
  const sections = useCollapsed();
  const role = workspace.actor.role;
  const admin = role === "owner" || role === "admin";
  const sidebar = resolveSidebar(preferences, sidebarAccess(workspace));
  const devices = useClientDevices(admin && sidebar.sections.devices);
  const teams = workspace.teams.filter(
    (team) => !sidebar.hiddenTeamIds.has(team.id),
  );
  const link = (item: (typeof sidebar.top)[number]) => (
    <SidebarLink
      key={item.id}
      item={navigationItem(item)}
      count={item.id === "inbox" ? unread : 0}
      countLabel="unread"
      onNavigate={onNavigate}
    />
  );
  return (
    <nav aria-label="Cloud navigation" className="cloud-navigation-groups">
      {sidebar.top.length > 0 && (
        <div className="cloud-navigation-group">{sidebar.top.map(link)}</div>
      )}
      <Section
        label="Workspace"
        open={sections.isOpen("workspace")}
        onToggle={() => sections.toggle("workspace")}
      >
        {sidebar.workspace.map(link)}
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
            {sidebar.more.map(link)}
            <button
              type="button"
              className="cloud-navigation-more"
              onClick={onCustomize}
            >
              <Settings2 size={15} strokeWidth={1.7} />
              <span>Customize sidebar</span>
            </button>
          </div>
        )}
      </Section>
      {sidebar.sections.favorites && favorites.length > 0 && (
        <Section
          label="Favorites"
          open={sections.isOpen("favorites")}
          onToggle={() => sections.toggle("favorites")}
        >
          {favorites.map((favorite) => {
            const href = favoriteHref(favorite);
            const Icon = favoriteIcons[favorite.kind];
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
      {devices.length > 0 && (
        <Section
          label="Clients"
          open={sections.isOpen("devices")}
          onToggle={() => sections.toggle("devices")}
        >
          {devices.slice(0, visibleDevices).map((device) => {
            const href = `/instances/${encodeURIComponent(device.instanceId)}`;
            return (
              <Link
                key={device.instanceId}
                href={href}
                onClick={onNavigate}
                aria-label={`${device.displayName}, ${device.status}`}
                aria-current={
                  pathname === href || pathname.startsWith(`${href}/`)
                    ? "page"
                    : undefined
                }
              >
                <span
                  className="cloud-device-status"
                  data-status={device.status}
                  aria-hidden="true"
                />
                <span>{device.displayName}</span>
              </Link>
            );
          })}
          {devices.length > visibleDevices && (
            <Link href="/instances" onClick={onNavigate}>
              <Monitor size={15} strokeWidth={1.7} />
              <span>All clients</span>
              <span className="cloud-navigation-badge">{devices.length}</span>
            </Link>
          )}
        </Section>
      )}
      {sidebar.sections.teams && teams.length > 0 && (
        <Section
          label="Your teams"
          open={sections.isOpen("teams")}
          onToggle={() => sections.toggle("teams")}
        >
          <SidebarTeams
            teams={teams}
            workspace={workspace}
            triage={triage}
            sections={sections}
            onNavigate={onNavigate}
          />
        </Section>
      )}
    </nav>
  );
}
