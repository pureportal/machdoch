"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import {
  ArrowLeft,
  CalendarRange,
  Check,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import type {
  CloudRun,
  ProjectClient,
} from "@machdoch/fleet-protocol/cloud-execution";
import type {
  CloudIssueSummary,
  CloudProject,
  CloudProjectProgress,
  CloudWorkspace,
} from "@/lib/cloud-contract";
import type { CloudLabel } from "@/lib/cloud-label-contract";
import type { CloudMilestone } from "@/lib/cloud-milestone-contract";
import { issueFilterKeys } from "@/lib/issue-filter-model";
import type { CloudProjectUpdate } from "@/lib/cloud-project-update-contract";
import { useAgentPageEntity, useAgentShell } from "./agent/agent-shell";
import { FavoriteButton } from "./favorite-button";
import { ProgressRing, ProjectHealth } from "./project-table";
import { ProjectUpdates } from "./project-updates";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cloudRequest, formReference, formText } from "./api-client";
import { profileAgentLabel } from "./execution-labels";
import { IssueBulkBar } from "./issue-bulk-bar";
import { IssueDisplayMenu } from "./issue-display-menu";
import { filterFieldDefinitions } from "./issue-filter-fields";
import {
  IssueFilterButton,
  IssueFilterChips,
  useIssueFilterState,
} from "./issue-filters";
import { CreateIssue } from "./issue-form";
import { parseIssueSort } from "@/lib/issue-scopes";
import { groupIssues, parseGrouping } from "./issue-grouping";
import { IssueRows } from "./issue-rows";
import { PersonAvatar } from "./person-avatar";
import { ProjectEditor } from "./project-editor";
import { CloudMarkdown } from "./cloud-markdown";
import { formatProjectDate, ProjectOverview } from "./project-overview";
import { projectStatusLabels, projectStatusStates } from "./project-fields";
import { TaskState } from "./task-state";
import { useToast } from "./toast";
import { useIssueList } from "./use-issue-list";
import { useIssueSelection } from "./use-issue-selection";

function MilestoneProgress({ issues }: { issues: CloudIssueSummary[] }) {
  if (!issues.length) return null;
  const done = issues.filter((issue) => issue.state === "complete").length;
  return (
    <span
      className="cloud-milestone-progress"
      title={`${done} of ${issues.length} issues completed`}
    >
      <ProgressRing percent={Math.round((done / issues.length) * 100)} />
      {done}/{issues.length}
    </span>
  );
}

function Milestones({
  projectId,
  milestones,
  issues,
  writable,
}: {
  projectId: string;
  milestones: CloudMilestone[];
  issues: CloudIssueSummary[];
  writable: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const run = (operation: Promise<unknown>) =>
    void operation
      .then(() => router.refresh())
      .catch((reason: Error) => toast(reason.message, "error"));
  return (
    <section className="cloud-card cloud-project-milestones">
      <header>
        <h2>Milestones</h2>
        {writable && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Add milestone"
            onClick={() => setCreating(true)}
          >
            <Plus />
          </Button>
        )}
      </header>
      <ul>
        {milestones.map((milestone) => (
          <li
            key={milestone.id}
            data-completed={milestone.completed || undefined}
          >
            <button
              type="button"
              className="cloud-milestone-check"
              role="checkbox"
              aria-checked={milestone.completed}
              aria-label={milestone.name}
              disabled={!writable}
              onClick={() =>
                run(
                  cloudRequest(`milestones/${milestone.id}`, {
                    method: "PATCH",
                    key: crypto.randomUUID(),
                    body: {
                      revision: milestone.revision,
                      name: milestone.name,
                      targetOn: milestone.targetOn,
                      completed: !milestone.completed,
                    },
                  }),
                )
              }
            >
              {milestone.completed && <Check size={12} />}
            </button>
            <span className="cloud-milestone-name">{milestone.name}</span>
            <MilestoneProgress
              issues={issues.filter(
                (issue) => issue.milestoneId === milestone.id,
              )}
            />
            {milestone.targetOn && (
              <time>{formatProjectDate(milestone.targetOn)}</time>
            )}
            {writable && (
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove ${milestone.name}`}
                onClick={() =>
                  run(
                    cloudRequest(`milestones/${milestone.id}/remove`, {
                      method: "POST",
                      body: {},
                    }),
                  )
                }
              >
                <Trash2 />
              </Button>
            )}
          </li>
        ))}
      </ul>
      <FormDialog
        open={creating}
        onOpenChange={setCreating}
        title="New milestone"
        submitLabel="Add milestone"
        onSubmit={async (form) => {
          await cloudRequest(`projects/${projectId}/milestones`, {
            method: "POST",
            key: crypto.randomUUID(),
            body: {
              name: formText(form, "name"),
              targetOn: formReference(form, "targetOn"),
            },
          });
          router.refresh();
        }}
      >
        <Field label="Name" htmlFor="milestone-name">
          <Input
            id="milestone-name"
            name="name"
            required
            maxLength={120}
            autoFocus
          />
        </Field>
        <Field label="Target date" htmlFor="milestone-target">
          <Input id="milestone-target" name="targetOn" type="date" />
        </Field>
      </FormDialog>
    </section>
  );
}

function ConnectedClients({
  clients,
  administrator,
}: {
  clients: ProjectClient[];
  administrator: boolean;
}) {
  if (!clients.length && !administrator) return null;
  return (
    <section className="cloud-card cloud-project-runs">
      <header className="cloud-project-section-header">
        <h2>Connected clients</h2>
        {administrator && (
          <Link href="/cloud/execution" prefetch={false}>
            {clients.length ? "Manage" : "Connect"}
          </Link>
        )}
      </header>
      {clients.length > 0 && (
        <ul>
          {clients.map((client) => (
            <li key={client.id}>
              <span
                className="cloud-project-client"
                title={profileAgentLabel(client.profile)}
              >
                {client.workspaceName ?? client.name}
              </span>
              <span
                className="cloud-state"
                data-state={client.online ? "complete" : "backlog"}
              >
                {client.online ? "Online" : "Offline"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ProjectDetail({
  project,
  progress,
  issues: initial,
  projectIssues,
  labels,
  milestones,
  runs,
  clients,
  updates,
  favorite,
  workspace,
}: {
  project: CloudProject;
  progress?: CloudProjectProgress;
  issues: CloudIssueSummary[];
  projectIssues: CloudIssueSummary[];
  labels: CloudLabel[];
  milestones: CloudMilestone[];
  runs: CloudRun[];
  clients: ProjectClient[];
  updates: CloudProjectUpdate[];
  favorite: boolean;
  workspace: CloudWorkspace;
}) {
  const router = useRouter();
  const search = useSearchParams();
  const { issues, apply } = useIssueList(initial, workspace, search.toString());
  const agent = useAgentShell();
  useAgentPageEntity({
    kind: "project",
    id: project.id,
    label: project.name,
    title: null,
  });
  const writable = workspace.actor.role !== "viewer";
  const definitions = useMemo(
    () =>
      filterFieldDefinitions(workspace, labels, project.teamId).filter(
        (definition) => definition.field !== "project",
      ),
    [workspace, labels, project.teamId],
  );
  const navigate = (next: URLSearchParams) => {
    const encoded = next.toString();
    router.push(
      `/cloud/projects/${project.id}${encoded ? `?${encoded}` : ""}`,
      {
        scroll: false,
      },
    );
  };
  const setDisplay = (name: string, value: string) => {
    const next = new URLSearchParams(search);
    if (value) next.set(name, value);
    else next.delete(name);
    navigate(next);
  };
  const filters = useIssueFilterState(
    new URLSearchParams(search),
    definitions,
    [],
    navigate,
  );
  const grouping = parseGrouping(search.get("group"));
  const sort = parseIssueSort(search.get("sort"));
  const reversed = search.get("order") === "reverse";
  const groups = useMemo(
    () =>
      groupIssues(
        issues,
        grouping,
        workspace,
        project.teamId,
        sort,
        reversed,
        false,
      ),
    [issues, grouping, workspace, project.teamId, sort, reversed],
  );
  const { selected, selectedIssues, toggle, clear } = useIssueSelection(
    issues,
    groups,
  );
  const lead = workspace.members.find((member) => member.id === project.leadId);
  const team = workspace.teams.find((entry) => entry.id === project.teamId);
  return (
    <>
      <header className="cloud-page-header">
        <div>
          <Link className="cloud-back-link" href="/cloud/projects">
            <ArrowLeft size={14} aria-hidden="true" /> Projects
          </Link>
          <h1 className="cloud-project-title">
            {project.name}
            <FavoriteButton kind="project" id={project.id} initial={favorite} />
          </h1>
          <div className="cloud-project-chips">
            <span
              className="cloud-state"
              data-state={projectStatusStates[project.status]}
            >
              {projectStatusLabels[project.status]}
            </span>
            <ProjectHealth update={updates[0]} />
          </div>
        </div>
        <div className="cloud-editor-actions">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => agent.openPanel(null)}
          >
            <Sparkles />
            Agent
          </Button>
          {writable && (
            <>
              <ProjectEditor id={project.id} members={workspace.members} />
              <CreateIssue
                workspace={workspace}
                teamId={project.teamId}
                projectId={project.id}
                shortcut
              />
            </>
          )}
        </div>
      </header>
      <div className="cloud-project-page">
        <div className="cloud-project-main">
          {project.description && (
            <CloudMarkdown
              className="cloud-project-summary"
              content={project.description}
            />
          )}
          <ProjectOverview
            project={project}
            progress={progress}
            issues={projectIssues}
          />
          <ProjectUpdates
            projectId={project.id}
            updates={updates}
            writable={writable}
          />
          <div className="cloud-project-issues-toolbar">
            <h2>Issues</h2>
            <IssueFilterButton
              fields={filters.fields}
              selected={filters.selected}
              onToggle={filters.toggle}
            />
            <IssueDisplayMenu
              search={new URLSearchParams(search)}
              setFilter={setDisplay}
            />
          </div>
          {filters.conditions.length > 0 && (
            <IssueFilterChips
              state={filters}
              definitions={definitions}
              workspace={workspace}
              onClear={() => {
                const kept = new URLSearchParams(search);
                for (const name of issueFilterKeys) kept.delete(name);
                navigate(kept);
              }}
            />
          )}
          {issues.length ? (
            <IssueRows
              groups={groups}
              workspace={workspace}
              writable={writable}
              apply={apply}
              selected={selected}
              onToggle={toggle}
              showProject={false}
            />
          ) : (
            <div className="cloud-empty">
              <p>
                {filters.conditions.length
                  ? "No matching issues."
                  : "No issues yet."}
              </p>
            </div>
          )}
        </div>
        <aside className="cloud-project-side" aria-label="Project details">
          <section className="cloud-card">
            <dl className="cloud-task-properties">
              <div>
                <dt>Lead</dt>
                <dd className="cloud-assignee">
                  {lead ? (
                    <>
                      <PersonAvatar
                        name={lead.name}
                        className="cloud-avatar-small"
                      />
                      {lead.name}
                    </>
                  ) : (
                    "No lead"
                  )}
                </dd>
              </div>
              <div>
                <dt>Team</dt>
                <dd>{team?.name}</dd>
              </div>
              {project.startsOn && (
                <div>
                  <dt>Start</dt>
                  <dd className="cloud-assignee">
                    <CalendarRange size={13} aria-hidden="true" />
                    {formatProjectDate(project.startsOn)}
                  </dd>
                </div>
              )}
            </dl>
          </section>
          <Milestones
            projectId={project.id}
            milestones={milestones}
            issues={projectIssues}
            writable={writable}
          />
          <ConnectedClients
            clients={clients}
            administrator={["owner", "admin"].includes(workspace.actor.role)}
          />
          {runs.length > 0 && (
            <section className="cloud-card cloud-project-runs">
              <h2>AI tasks</h2>
              <ul>
                {runs.map((run) => (
                  <li key={run.id}>
                    <Link href={`/cloud/tasks/${run.id}`} prefetch={false}>
                      {run.title}
                    </Link>
                    <TaskState state={run.state} />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>
      {selectedIssues.length > 0 && (
        <IssueBulkBar
          issues={selectedIssues}
          workspace={workspace}
          apply={apply}
          onClear={clear}
        />
      )}
    </>
  );
}
