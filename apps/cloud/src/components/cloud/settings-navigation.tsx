"use client";

import Link from "next/link";
import {
  Bell,
  Bot,
  Clock,
  FileText,
  Flag,
  GitPullRequest,
  KeyRound,
  Link2,
  ListChecks,
  LockKeyhole,
  Mail,
  MessageSquareText,
  Palette,
  Plug,
  Rocket,
  Search,
  Server,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Tag,
  Target,
  Tags,
  UserRound,
  UserPlus,
  Users,
  Activity,
  Brain,
  CircleDot,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import {
  settingsNavigation,
  settingsTeamTree,
  teamSettingsHref,
  type SettingsSectionId,
  type SettingsTeamNode,
} from "@/lib/settings-navigation";
import { Input } from "@/components/ui/input";
import { Section, SidebarLink, useCollapsed } from "./sidebar-parts";

const sectionIcons: Record<SettingsSectionId, LucideIcon> = {
  setup: ListChecks,
  preferences: SlidersHorizontal,
  profile: UserRound,
  notifications: Bell,
  "code-reviews": GitPullRequest,
  security: LockKeyhole,
  "connected-accounts": Link2,
  "agent-personalization": Sparkles,
  "issue-labels": Tag,
  "workflow-states": CircleDot,
  slas: Clock,
  "issue-templates": FileText,
  "project-labels": Tags,
  "project-statuses": Flag,
  "project-updates": MessageSquareText,
  initiatives: Target,
  ai: Bot,
  execution: Server,
  automations: Zap,
  "customer-requests": Users,
  releases: Rocket,
  pulse: Activity,
  integrations: Plug,
  members: Users,
  roles: Shield,
  invitations: UserPlus,
  sso: KeyRound,
  email: Mail,
  branding: Palette,
  mimorii: Brain,
};

function TeamLinks({
  nodes,
  onNavigate,
}: {
  nodes: SettingsTeamNode[];
  onNavigate: () => void;
}) {
  return nodes.map((node) => (
    <div key={node.team.id}>
      <SidebarLink
        item={{
          href: teamSettingsHref(node.team.id, "workflow"),
          paths: [`/cloud/settings/teams/${node.team.id}`],
          label: node.team.name,
        }}
        onNavigate={onNavigate}
      />
      {node.children.length > 0 && (
        <div className="cloud-navigation-nested">
          <TeamLinks nodes={node.children} onNavigate={onNavigate} />
        </div>
      )}
    </div>
  ));
}

export function SettingsNavigation({
  workspace,
  onNavigate,
}: {
  workspace: CloudWorkspace;
  onNavigate: () => void;
}) {
  const [query, setQuery] = useState("");
  const sections = useCollapsed();
  const groups = settingsNavigation(workspace.actor, query);
  const teams = settingsTeamTree(workspace.teams);
  return (
    <>
      <div className="cloud-sidebar-header cloud-settings-sidebar-header">
        <strong>Settings</strong>
        <Link
          href="/cloud/issues"
          className="cloud-settings-close"
          aria-label="Close settings"
          onClick={onNavigate}
        >
          <X size={15} strokeWidth={1.7} />
        </Link>
      </div>
      <label className="cloud-settings-search">
        <Search size={14} aria-hidden="true" />
        <Input
          type="search"
          aria-label="Search settings"
          placeholder="Search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <nav aria-label="Settings" className="cloud-navigation-groups">
        {groups.map((group) => (
          <Section
            key={group.id}
            label={group.label}
            open={query !== "" || sections.isOpen(`settings-${group.id}`)}
            onToggle={() => sections.toggle(`settings-${group.id}`)}
          >
            {group.entries.map((entry) => (
              <SidebarLink
                key={entry.id}
                item={{
                  href: entry.href,
                  label: entry.label,
                  icon: sectionIcons[entry.id],
                }}
                onNavigate={onNavigate}
              />
            ))}
          </Section>
        ))}
        {!query && teams.length > 0 && (
          <Section
            label="Teams"
            open={sections.isOpen("settings-teams")}
            onToggle={() => sections.toggle("settings-teams")}
          >
            <TeamLinks nodes={teams} onNavigate={onNavigate} />
          </Section>
        )}
        {query && groups.length === 0 && (
          <p className="cloud-settings-search-empty">No matching settings</p>
        )}
      </nav>
    </>
  );
}
