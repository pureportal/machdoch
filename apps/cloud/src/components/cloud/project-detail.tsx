"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ArrowLeft, CalendarRange, Check, Plus, Trash2 } from "lucide-react";
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
import type { CloudMilestone } from "@/lib/cloud-milestone-contract";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cloudRequest, formReference, formText } from "./api-client";
import { profileAgentLabel } from "./execution-labels";
import { IssueBulkBar } from "./issue-bulk-bar";
import { CreateIssue } from "./issue-form";
import { groupIssues } from "./issue-grouping";
import { IssueRows } from "./issue-rows";
import { PersonAvatar } from "./person-avatar";
import { ProjectEditor } from "./project-editor";
import { projectStatusLabels, projectStatusStates } from "./project-fields";
import { TaskState } from "./task-state";
import { useToast } from "./toast";
import { useIssueList } from "./use-issue-list";
import { useIssueSelection } from "./use-issue-selection";

const longDate = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function formatDate(value: string): string {
  return longDate.format(new Date(`${value}T00:00:00Z`));
}

function Milestones({
  projectId,
  milestones,
  writable,
}: {
  projectId: string;
  milestones: CloudMilestone[];
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
          <li key={milestone.id} data-completed={milestone.completed || undefined}>
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
            {milestone.targetOn && <time>{formatDate(milestone.targetOn)}</time>}
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
          <Input id="milestone-name" name="name" required maxLength={120} autoFocus />
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
  milestones,
  runs,
  clients,
  workspace,
}: {
  project: CloudProject;
  progress?: CloudProjectProgress;
  issues: CloudIssueSummary[];
  milestones: CloudMilestone[];
  runs: CloudRun[];
  clients: ProjectClient[];
  workspace: CloudWorkspace;
}) {
  const { issues, apply } = useIssueList(initial, workspace);
  const writable = workspace.actor.role !== "viewer";
  const groups = useMemo(
    () => groupIssues(issues, "status", workspace, project.teamId, null, false),
    [issues, workspace, project.teamId],
  );
  const { selected, selectedIssues, toggle, clear } = useIssueSelection(
    issues,
    groups,
  );
  const lead = workspace.members.find((member) => member.id === project.leadId);
  const team = workspace.teams.find((entry) => entry.id === project.teamId);
  const percent = progress?.total
    ? Math.round((progress.completed / progress.total) * 100)
    : 0;
  return (
    <>
      <header className="cloud-page-header">
        <div>
          <Link className="cloud-back-link" href="/cloud/projects">
            <ArrowLeft size={14} aria-hidden="true" /> Projects
          </Link>
          <h1>{project.name}</h1>
        </div>
        {writable && (
          <div className="cloud-editor-actions">
            <ProjectEditor id={project.id} members={workspace.members} />
            <CreateIssue
              workspace={workspace}
              teamId={project.teamId}
              projectId={project.id}
              shortcut
            />
          </div>
        )}
      </header>
      <div className="cloud-project-page">
        <div className="cloud-project-main">
          {project.description && (
            <p className="cloud-project-summary">{project.description}</p>
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
              <p>No issues yet.</p>
            </div>
          )}
        </div>
        <aside className="cloud-project-side" aria-label="Project details">
          <section className="cloud-card">
            <dl className="cloud-task-properties">
              <div>
                <dt>Status</dt>
                <dd>
                  <span
                    className="cloud-state"
                    data-state={projectStatusStates[project.status]}
                  >
                    {projectStatusLabels[project.status]}
                  </span>
                </dd>
              </div>
              <div>
                <dt>Progress</dt>
                <dd className="cloud-project-progress">
                  <span
                    className="cloud-project-progress-track"
                    role="progressbar"
                    aria-label={`${project.name} progress`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percent}
                  >
                    <span style={{ width: `${percent}%` }} />
                  </span>
                  <span>{percent}%</span>
                </dd>
              </div>
              <div>
                <dt>Scope</dt>
                <dd>
                  {progress?.completed ?? 0} of {progress?.total ?? 0} issues
                  {progress?.points
                    ? ` · ${progress.completedPoints} of ${progress.points} points`
                    : ""}
                </dd>
              </div>
              <div>
                <dt>Lead</dt>
                <dd className="cloud-assignee">
                  {lead ? (
                    <>
                      <PersonAvatar name={lead.name} className="cloud-avatar-small" />
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
              {(project.startsOn || project.targetOn) && (
                <div>
                  <dt>Dates</dt>
                  <dd className="cloud-assignee">
                    <CalendarRange size={13} aria-hidden="true" />
                    {project.startsOn ? formatDate(project.startsOn) : "—"} →{" "}
                    {project.targetOn ? formatDate(project.targetOn) : "—"}
                  </dd>
                </div>
              )}
            </dl>
          </section>
          <Milestones
            projectId={project.id}
            milestones={milestones}
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
