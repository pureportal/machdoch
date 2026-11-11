"use client";

import Link from "next/link";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { CalendarRange, FolderKanban, Plus, Search, Users } from "lucide-react";
import type {
  CloudProjectProgress,
  CloudWorkspace,
} from "@/lib/cloud-contract";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { PlanningCreateDialog } from "./planning-create-dialog";
import { TeamDirectory, CycleDirectory } from "./planning-directory";
import { ProjectTable, projectTabs, type ProjectTab } from "./project-table";
import type { CloudProjectUpdate } from "@/lib/cloud-project-update-contract";
import type { CloudInitiative } from "@/lib/cloud-initiative-contract";

export function PlanningCatalog({
  kind,
  workspace,
  progress = [],
  updates = [],
  initiatives = [],
}: {
  kind: "teams" | "projects" | "cycles";
  workspace: CloudWorkspace;
  progress?: CloudProjectProgress[];
  updates?: CloudProjectUpdate[];
  initiatives?: CloudInitiative[];
}) {
  const search = useSearchParams();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [teamId, setTeamId] = useState(() => {
    const requested = search.get("teamId") ?? "";
    return workspace.teams.some((team) => team.id === requested)
      ? requested
      : "";
  });
  const [tab, setTab] = useState<ProjectTab>("all");
  const labels = {
    teams: { title: "Teams", single: "team", icon: Users },
    projects: { title: "Projects", single: "project", icon: FolderKanban },
    cycles: { title: "Cycles", single: "cycle", icon: CalendarRange },
  }[kind];
  const writable = workspace.actor.role !== "viewer";
  const canCreate =
    writable &&
    (kind !== "teams" || ["owner", "admin"].includes(workspace.actor.role));
  const term = query.trim().toLowerCase();
  const statuses = kind === "projects" ? projectTabs[tab].statuses : null;
  const items = workspace[kind].filter(
    (item) =>
      (!teamId || ("teamId" in item && item.teamId === teamId)) &&
      (!statuses ||
        ("status" in item &&
          (statuses as readonly string[]).includes(item.status))) &&
      [
        item.name,
        "description" in item ? item.description : "",
        "key" in item ? item.key : "",
      ].some((value) => value.toLowerCase().includes(term)),
  );
  const visibleIds = new Set(items.map((item) => item.id));
  return (
    <>
      <header className="cloud-page-header">
        <h1>{labels.title}</h1>
        {canCreate && (kind === "teams" || workspace.teams.length > 0) && (
          <Button onClick={() => setOpen(true)}>
            <Plus />
            New {labels.single}
          </Button>
        )}
      </header>
      {kind === "projects" && workspace.projects.length > 0 && (
        <nav
          className="cloud-scope-tabs cloud-project-tabs"
          aria-label="Project views"
        >
          {(Object.keys(projectTabs) as ProjectTab[]).map((entry) => (
            <button
              key={entry}
              type="button"
              aria-current={entry === tab ? "page" : undefined}
              onClick={() => setTab(entry)}
            >
              {projectTabs[entry].label}
            </button>
          ))}
        </nav>
      )}
      {workspace[kind].length > 0 && (
        <div className="cloud-toolbar">
          <div className="cloud-issue-search">
            <Search size={15} aria-hidden="true" />
            <Input
              aria-label={`Search ${kind}`}
              placeholder={`Search ${kind}…`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              type="search"
            />
          </div>
          {kind !== "teams" && workspace.teams.length > 1 && (
            <Select
              aria-label="Filter by team"
              value={teamId}
              onChange={(event) => setTeamId(event.target.value)}
            >
              <option value="">All teams</option>
              {workspace.teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </Select>
          )}
        </div>
      )}
      {!items.length ? (
        <div className="cloud-empty">
          <labels.icon aria-hidden="true" />
          <p>
            {workspace[kind].length
              ? `No matching ${kind}.`
              : `No ${kind} yet.`}
          </p>
          {(query || teamId || tab !== "all") && (
            <Button
              variant="outline"
              onClick={() => {
                setQuery("");
                setTeamId("");
                setTab("all");
              }}
            >
              Clear filters
            </Button>
          )}
          {kind !== "teams" && !workspace.teams.length && (
            <Link className="underline" href="/cloud/teams">
              Create a team
            </Link>
          )}
        </div>
      ) : kind === "projects" ? (
        <ProjectTable
          projects={workspace.projects.filter((item) =>
            visibleIds.has(item.id),
          )}
          workspace={workspace}
          progress={progress}
          updates={updates}
          initiatives={initiatives}
          writable={writable}
        />
      ) : kind === "teams" ? (
        <TeamDirectory
          teams={workspace.teams.filter((item) => visibleIds.has(item.id))}
          workspace={workspace}
        />
      ) : (
        <CycleDirectory
          cycles={workspace.cycles.filter((item) => visibleIds.has(item.id))}
          teams={workspace.teams}
        />
      )}
      <PlanningCreateDialog
        kind={kind}
        workspace={workspace}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
