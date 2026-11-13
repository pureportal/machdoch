"use client";

import { holderCan } from "@/lib/cloud-permissions";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CalendarRange,
  Diamond,
  FolderKanban,
  Plus,
  Triangle,
  UserRound,
  Users,
} from "lucide-react";
import type { CloudMilestone } from "@/lib/cloud-milestone-contract";
import { IssueRunList } from "./issue-run-list";
import { IssuePullRequests } from "./issue-pull-requests";
import type { CloudIssue, CloudWorkspace } from "@/lib/cloud-contract";
import type {
  IssueChangeSet,
  IssueChangesResult,
} from "@/lib/cloud-issue-changes-contract";
import { CloudRequestError, cloudRequest } from "./api-client";
import type { IssueHistoryEntry } from "./issue-activity";
import { PokerPanel } from "./poker-panel";
import { IssueComments } from "./comments";
import { TaskList } from "./task-list";
import { IssueDelegate } from "./issue-delegate";
import { IssueAutomations } from "./issue-automations";
import { IssueHeader } from "./issue-header";
import { triageChangedEvent } from "./events";
import { TriageActions } from "./triage-actions";
import { IssueLabels } from "./issue-labels";
import { DueDateField } from "./due-date-field";
import { IssueMarkdownField } from "./issue-markdown-field";
import { IssueAttachments } from "./issue-attachments";
import { uploadAttachment } from "./attachment-upload";
import { IssuePriority } from "./issue-priority";
import {
  IssueRelationSidebar,
  IssueSubIssues,
  useIssueRelations,
} from "./issue-relations";
import {
  applyIssueChanges,
  assigneeOptions,
  cycleOptions,
  estimateOptions,
  noValue,
  priorityNames,
  priorityOptions,
  projectOptions,
  referenceValue,
  statusChange,
  statusOptions,
} from "./issue-properties";
import { PersonAvatar } from "./person-avatar";
import { PropertyMenu, type PropertyOption } from "./property-menu";
import { useToast } from "./toast";
import { useAgentPageEntity } from "./agent/agent-shell";

type TextField = "title" | "description" | "acceptanceCriteria";

function useProjectMilestones(projectId: string | null): CloudMilestone[] {
  const [milestones, setMilestones] = useState<CloudMilestone[]>([]);
  useEffect(() => {
    setMilestones([]);
    if (!projectId) return;
    const abort = new AbortController();
    void cloudRequest<{ milestones: CloudMilestone[] }>(
      `projects/${projectId}/milestones`,
      { signal: abort.signal },
    )
      .then((result) => setMilestones(result.milestones))
      .catch(() => undefined);
    return () => abort.abort();
  }, [projectId]);
  return milestones;
}

const pollMs = 15_000;

function Property({
  label,
  writable,
  options,
  value,
  display,
  onSelect,
}: {
  label: string;
  writable: boolean;
  options: PropertyOption[];
  value: string;
  display: React.ReactNode;
  onSelect: (value: string) => void;
}) {
  return (
    <div className="cloud-property">
      {writable ? (
        <PropertyMenu
          label={label}
          options={options}
          value={value}
          onSelect={onSelect}
        >
          <button
            type="button"
            className="cloud-property-value"
            aria-label={label}
          >
            {display}
          </button>
        </PropertyMenu>
      ) : (
        <span className="cloud-property-value" aria-label={label}>
          {display}
        </span>
      )}
    </div>
  );
}

export function IssueEditor({
  initial,
  workspace,
  favorite,
}: {
  initial: CloudIssue;
  workspace: CloudWorkspace;
  favorite: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [issue, setIssue] = useState(initial);
  const [title, setTitle] = useState(initial.title);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">(
    "idle",
  );
  const [conflict, setConflict] = useState("");
  const [history, setHistory] = useState<IssueHistoryEntry[]>([]);
  const [opened, setOpened] = useState<string[]>([]);
  const [criteriaOpen, setCriteriaOpen] = useState(false);
  const latest = useRef(initial);
  const queue = useRef(Promise.resolve());
  const editingTitle = useRef(false);
  latest.current = issue;
  const writable = holderCan(workspace.actor, "issues.edit");
  const team = workspace.teams.find((entry) => entry.id === issue.teamId)!;
  const relations = useIssueRelations(issue.id);
  const milestones = useProjectMilestones(issue.projectId);
  const milestone = milestones.find((entry) => entry.id === issue.milestoneId);
  useAgentPageEntity({
    kind: "issue",
    id: issue.id,
    label: issue.identifier,
    title: issue.title,
  });
  const refreshHistory = useCallback(() => {
    void cloudRequest<{ history: IssueHistoryEntry[] }>(
      `issues/${initial.id}/history`,
    )
      .then((value) => setHistory(value.history))
      .catch(() => undefined);
  }, [initial.id]);
  const reload = useCallback(async () => {
    const next = await cloudRequest<CloudIssue>(`issues/${initial.id}`);
    setIssue(next);
    if (!editingTitle.current) setTitle(next.title);
    refreshHistory();
    return next;
  }, [initial.id, refreshHistory]);
  useEffect(() => {
    refreshHistory();
    const timer = setInterval(() => {
      if (!document.hidden) void reload().catch(() => undefined);
    }, pollMs);
    return () => clearInterval(timer);
  }, [refreshHistory, reload]);
  function changeProperties(changes: IssueChangeSet) {
    const previous = latest.current;
    setIssue(applyIssueChanges(previous, changes, workspace));
    queue.current = queue.current
      .then(async () => {
        await cloudRequest<IssueChangesResult>("issues/changes", {
          method: "POST",
          key: crypto.randomUUID(),
          body: { issues: [{ id: previous.id }], changes },
        });
        await reload();
        router.refresh();
      })
      .catch((reason: Error) => {
        setIssue(previous);
        toast(reason.message, "error");
        if (
          reason instanceof CloudRequestError &&
          reason.code === "workflow_changed"
        )
          router.refresh();
      });
  }
  function saveText(field: TextField, raw: string) {
    const value = field === "title" ? raw.trim() : raw;
    if (value === latest.current[field] || (field === "title" && !value)) {
      if (field === "title") setTitle(latest.current.title);
      return;
    }
    const base = latest.current[field];
    setIssue({ ...latest.current, [field]: value });
    setSaveState("saving");
    setConflict("");
    const send = (revision: number) =>
      cloudRequest<IssueChangesResult>("issues/changes", {
        method: "POST",
        key: crypto.randomUUID(),
        body: {
          issues: [{ id: issue.id, revision }],
          changes: { [field]: value },
        },
      });
    queue.current = queue.current
      .then(async () => {
        try {
          await send(latest.current.revision);
        } catch (reason) {
          if (
            !(reason instanceof CloudRequestError) ||
            reason.code !== "revision_conflict"
          )
            throw reason;
          const current = await cloudRequest<CloudIssue>(`issues/${issue.id}`);
          if (current[field] !== base) throw reason;
          await send(current.revision);
        }
        await reload();
        setSaveState("saved");
        router.refresh();
      })
      .catch(async (reason: Error) => {
        setSaveState("idle");
        setConflict(reason.message);
        await reload().catch(() => undefined);
      });
  }
  const assignee = workspace.members.find(
    (member) => member.id === issue.assigneeId,
  );
  const project = workspace.projects.find(
    (entry) => entry.id === issue.projectId,
  );
  const cycle = workspace.cycles.find((entry) => entry.id === issue.cycleId);
  const open = (section: string) =>
    setOpened((current) =>
      current.includes(section) ? current : [...current, section],
    );
  return (
    <div className="cloud-issue-page">
      <IssueHeader
        issue={issue}
        workspace={workspace}
        favorite={favorite}
        writable={writable}
        saveState={
          saveState === "saving"
            ? "Saving…"
            : saveState === "saved"
              ? "Saved"
              : ""
        }
        onArchive={() => changeProperties({ archived: !issue.archived })}
        delegate={
          writable &&
          !issue.archived && (
            <>
              <IssueAutomations issueId={issue.id} />
              {!["triage", "complete", "canceled"].includes(issue.state) && (
                <IssueDelegate
                  issue={issue}
                  workspace={workspace}
                  onBeforeStart={async (projectId) => {
                    const result = await cloudRequest<IssueChangesResult>(
                      "issues/changes",
                      {
                        method: "POST",
                        key: crypto.randomUUID(),
                        body: {
                          issues: [{ id: issue.id }],
                          changes: { projectId },
                        },
                      },
                    );
                    return result.updated[0]!.revision;
                  }}
                />
              )}
            </>
          )
        }
      />
      {writable && issue.state === "triage" && !issue.archived && (
        <div className="cloud-issue-triage">
          <TriageActions
            key={issue.revision}
            issue={issue}
            workspace={workspace}
            onDecided={(_, message) => {
              toast(message);
              window.dispatchEvent(new Event(triageChangedEvent));
              router.refresh();
            }}
          />
        </div>
      )}
      <div className="cloud-issue-layout">
        <div className="cloud-issue-document">
          <label className="sr-only" htmlFor="title">
            Title
          </label>
          <textarea
            id="title"
            name="title"
            className="cloud-issue-title-input"
            value={title}
            rows={1}
            disabled={!writable}
            maxLength={300}
            onFocus={() => {
              editingTitle.current = true;
            }}
            onChange={(event) =>
              setTitle(event.target.value.replace(/[\r\n]+/g, " "))
            }
            onBlur={() => {
              editingTitle.current = false;
              saveText("title", title);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
          />
          <IssueMarkdownField
            id="description"
            label="Description"
            value={issue.description}
            placeholder="Add description…"
            writable={writable}
            maxLength={30000}
            className="cloud-issue-description"
            uploadFile={(file) => uploadAttachment(file, issue.id)}
            onSave={(value) => saveText("description", value)}
          />
          {(issue.acceptanceCriteria || criteriaOpen) && (
            <section className="cloud-issue-criteria">
              <h2>Acceptance criteria</h2>
              <IssueMarkdownField
                id="acceptance"
                label="Acceptance criteria"
                value={issue.acceptanceCriteria}
                placeholder="What must be true when this is done?"
                writable={writable}
                maxLength={20000}
                autoEdit={!issue.acceptanceCriteria}
                uploadFile={(file) => uploadAttachment(file, issue.id)}
                onSave={(value) => saveText("acceptanceCriteria", value)}
              />
            </section>
          )}
          {writable && !issue.acceptanceCriteria && !criteriaOpen && (
            <button
              type="button"
              className="cloud-inline-add"
              onClick={() => setCriteriaOpen(true)}
            >
              <Plus size={13} aria-hidden="true" />
              Add acceptance criteria
            </button>
          )}
          {conflict && (
            <div role="alert" className="cloud-error">
              <p>{conflict}</p>
            </div>
          )}
          <IssueAttachments issueId={issue.id} writable={writable} />
          <IssueSubIssues issue={issue} writable={writable} state={relations} />
          <details
            className="cloud-issue-disclosure"
            onToggle={(event) => {
              if (event.currentTarget.open) open("tasks");
            }}
          >
            <summary>AI tasks</summary>
            {opened.includes("tasks") && (
              <TaskList issue={issue} workspace={workspace} />
            )}
          </details>
          <details
            className="cloud-issue-disclosure"
            onToggle={(event) => {
              if (event.currentTarget.open) open("poker");
            }}
          >
            <summary>Planning poker</summary>
            {opened.includes("poker") && (
              <PokerPanel
                issue={issue}
                workspace={workspace}
                dirty={false}
                onDecision={async () => {
                  await reload();
                }}
              />
            )}
          </details>
          <IssueComments
            relations={relations.relations}
            issue={issue}
            workspace={workspace}
            history={history}
          />
        </div>
        <aside className="cloud-issue-aside" aria-label="Issue properties">
          <section
            className="cloud-aside-section cloud-aside-properties"
            aria-label="Properties"
          >
            <header>
              <h2>Properties</h2>
            </header>
            <div className="cloud-property">
              <span className="cloud-property-value" aria-label="Team">
                <Users size={14} aria-hidden="true" />
                {team.name}
              </span>
            </div>
            <Property
              label="Status"
              writable={writable}
              options={statusOptions(workspace, [issue.teamId])}
              value={JSON.stringify(issue.status)}
              display={
                <span className="cloud-state" data-state={issue.state}>
                  {issue.statusName}
                </span>
              }
              onSelect={(value) => changeProperties(statusChange(value))}
            />
            <Property
              label="Priority"
              writable={writable}
              options={priorityOptions}
              value={issue.priority}
              display={
                <>
                  <IssuePriority priority={issue.priority} compact />
                  {priorityNames[issue.priority]}
                </>
              }
              onSelect={(value) =>
                changeProperties({ priority: value as CloudIssue["priority"] })
              }
            />
            <Property
              label="Assignee"
              writable={writable}
              options={assigneeOptions(workspace)}
              value={issue.assigneeId ?? noValue}
              display={
                assignee ? (
                  <>
                    <PersonAvatar
                      name={assignee.name}
                      className="cloud-avatar-small"
                    />
                    {assignee.name}
                  </>
                ) : (
                  <span className="cloud-property-empty">
                    <UserRound size={14} aria-hidden="true" />
                    Assign
                  </span>
                )
              }
              onSelect={(value) =>
                changeProperties({ assigneeId: referenceValue(value) })
              }
            />
            <Property
              label="Estimate"
              writable={writable}
              options={estimateOptions(team, issue.estimate)}
              value={issue.estimate ?? noValue}
              display={
                issue.estimate ? (
                  <>
                    <Triangle size={14} aria-hidden="true" />
                    {issue.estimate} points
                  </>
                ) : (
                  <span className="cloud-property-empty">
                    <Triangle size={14} aria-hidden="true" />
                    Estimate
                  </span>
                )
              }
              onSelect={(value) =>
                changeProperties({ estimate: referenceValue(value) })
              }
            />
            <Property
              label="Cycle"
              writable={writable}
              options={cycleOptions(workspace, issue.teamId, issue.cycleId)}
              value={issue.cycleId ?? noValue}
              display={
                cycle ? (
                  <>
                    <CalendarRange size={14} aria-hidden="true" />
                    {cycle.name}
                  </>
                ) : (
                  <span className="cloud-property-empty">
                    <CalendarRange size={14} aria-hidden="true" />
                    Add to cycle
                  </span>
                )
              }
              onSelect={(value) =>
                changeProperties({ cycleId: referenceValue(value) })
              }
            />
            <div className="cloud-property">
              <DueDateField
                id="due"
                value={issue.dueOn}
                writable={writable}
                onChange={(dueOn) => changeProperties({ dueOn })}
              />
            </div>
          </section>
          <section className="cloud-aside-section" aria-label="Labels">
            <header>
              <h2>Labels</h2>
            </header>
            <IssueLabels issue={issue} writable={writable} />
          </section>
          <section className="cloud-aside-section" aria-label="Project">
            <header>
              <h2>Project</h2>
            </header>
            <Property
              label="Project"
              writable={writable}
              options={projectOptions(workspace, issue.teamId)}
              value={issue.projectId ?? noValue}
              display={
                project ? (
                  <>
                    <FolderKanban size={14} aria-hidden="true" />
                    {project.name}
                  </>
                ) : (
                  <span className="cloud-property-empty">
                    <FolderKanban size={14} aria-hidden="true" />
                    Add to project
                  </span>
                )
              }
              onSelect={(value) =>
                changeProperties({ projectId: referenceValue(value) })
              }
            />
            {project && (
              <Property
                label="Milestone"
                writable={writable}
                options={[
                  { value: noValue, label: "No milestone" },
                  ...milestones.map((entry) => ({
                    value: entry.id,
                    label: entry.name,
                  })),
                ]}
                value={issue.milestoneId ?? noValue}
                display={
                  milestone ? (
                    <span className="cloud-property-milestone">
                      <Diamond size={12} aria-hidden="true" />
                      {milestone.name}
                    </span>
                  ) : (
                    <span className="cloud-property-empty cloud-property-milestone">
                      <Diamond size={12} aria-hidden="true" />
                      Add milestone
                    </span>
                  )
                }
                onSelect={(value) =>
                  changeProperties({ milestoneId: referenceValue(value) })
                }
              />
            )}
          </section>
          <IssueRelationSidebar
            issue={issue}
            writable={writable}
            state={relations}
          />
          <IssuePullRequests issueId={issue.id} />
          <IssueRunList issueId={issue.id} />
        </aside>
      </div>
    </div>
  );
}
