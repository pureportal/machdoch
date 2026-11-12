"use client";

import {
  CalendarRange,
  CircleDot,
  CircleDotDashed,
  ChevronRight,
  FolderKanban,
} from "lucide-react";
import type { CloudTeam, CloudWorkspace } from "@/lib/cloud-contract";
import { SidebarLink, type CollapsedSections } from "./sidebar-parts";

export function SidebarTeams({
  teams,
  workspace,
  triage,
  sections,
  onNavigate,
}: {
  teams: CloudTeam[];
  workspace: CloudWorkspace;
  triage: Record<string, number>;
  sections: CollapsedSections;
  onNavigate: () => void;
}) {
  return teams.map((team) => {
    const key = `team:${team.id}`;
    const open = sections.isOpen(key, teams.length < 4);
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
      .filter((cycle) => cycle.teamId === team.id && cycle.status === "planned")
      .sort((left, right) => left.startsOn.localeCompare(right.startsOn))[0];
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
            {(triageEnabled || !!triage[team.id]) && (
              <SidebarLink
                item={{
                  href: `/cloud/triage?teamId=${team.id}`,
                  label: "Triage",
                  icon: CircleDotDashed,
                }}
                count={triage[team.id]}
                onNavigate={onNavigate}
              />
            )}
            <SidebarLink
              item={{
                href: `/cloud/issues?teamId=${team.id}`,
                label: "Issues",
                icon: CircleDot,
              }}
              onNavigate={onNavigate}
            />
            <SidebarLink
              item={{
                href: `/cloud/cycles?teamId=${team.id}`,
                label: "Cycles",
                icon: CalendarRange,
              }}
              onNavigate={onNavigate}
            />
            {(current || upcoming) && (
              <div className="cloud-navigation-nested">
                {current && (
                  <SidebarLink
                    item={{
                      href: `/cloud/cycles/${current.id}`,
                      label: "Current",
                    }}
                    onNavigate={onNavigate}
                  />
                )}
                {upcoming && (
                  <SidebarLink
                    item={{
                      href: `/cloud/cycles/${upcoming.id}`,
                      label: "Upcoming",
                    }}
                    onNavigate={onNavigate}
                  />
                )}
              </div>
            )}
            <SidebarLink
              item={{
                href: `/cloud/projects?teamId=${team.id}`,
                label: "Projects",
                icon: FolderKanban,
              }}
              onNavigate={onNavigate}
            />
          </div>
        )}
      </div>
    );
  });
}
