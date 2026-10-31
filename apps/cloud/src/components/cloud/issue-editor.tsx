"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Archive, ArchiveRestore, Bot, ChevronRight, Sparkles } from "lucide-react";
import type { CloudIssue, CloudWorkspace } from "@/lib/cloud-contract";
import type {
  IssueChangeSet,
  IssueChangesResult,
} from "@/lib/cloud-issue-changes-contract";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { CloudRequestError, cloudRequest } from "./api-client";
import type { IssueHistoryEntry } from "./issue-activity";
import { PokerPanel } from "./poker-panel";
import { IssueComments } from "./comments";
import { TaskList } from "./task-list";
import { IssueDelegate } from "./issue-delegate";
import { IssueLabels } from "./issue-labels";
import { IssuePriority } from "./issue-priority";
import { IssueRelations } from "./issue-relations";
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

type TextField = "title" | "description" | "acceptanceCriteria";
type Drafts = Record<TextField, string>;

const textFields: TextField[] = ["title", "description", "acceptanceCriteria"];
const pollMs = 15_000;

function draftsFrom(issue: CloudIssue): Drafts {
  return {
    title: issue.title,
    description: issue.description,
    acceptanceCriteria: issue.acceptanceCriteria,
  };
}

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
      <span className="cloud-property-label">{label}</span>
      {writable ? (
        <PropertyMenu
          label={label}
          options={options}
          value={value}
          onSelect={onSelect}
        >
          <button type="button" className="cloud-property-value" aria-label={label}>
            {display}
          </button>
        </PropertyMenu>
      ) : (
        <span className="cloud-property-value">{display}</span>
      )}
    </div>
  );
}

export function IssueEditor({
  initial,
  workspace,
  activeRunId,
}: {
  initial: CloudIssue;
  workspace: CloudWorkspace;
  activeRunId: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [issue, setIssue] = useState(initial);
  const [drafts, setDrafts] = useState(() => draftsFrom(initial));
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">(
    "idle",
  );
  const [conflict, setConflict] = useState("");
  const [history, setHistory] = useState<IssueHistoryEntry[]>([]);
  const [panel, setPanel] = useState("activity");
  const [visited, setVisited] = useState(() => new Set(["activity"]));
  const latest = useRef(initial);
  const queue = useRef(Promise.resolve());
  const dirtyRef = useRef(false);
  latest.current = issue;
  const writable = workspace.actor.role !== "viewer";
  const team = workspace.teams.find((entry) => entry.id === issue.teamId)!;
  const dirty = textFields.some((field) => drafts[field] !== issue[field]);
  dirtyRef.current = dirty;
  const refreshHistory = useCallback(() => {
    void cloudRequest<{ history: IssueHistoryEntry[] }>(
      `issues/${initial.id}/history`,
    )
      .then((value) => setHistory(value.history))
      .catch(() => undefined);
  }, [initial.id]);
  const reload = useCallback(
    async (replaceDrafts: boolean) => {
      const next = await cloudRequest<CloudIssue>(`issues/${initial.id}`);
      setIssue(next);
      if (replaceDrafts) {
        setDrafts(draftsFrom(next));
        setConflict("");
      } else if (!dirtyRef.current) setDrafts(draftsFrom(next));
      refreshHistory();
      return next;
    },
    [initial.id, refreshHistory],
  );
  useEffect(() => {
    refreshHistory();
    const timer = setInterval(() => {
      if (!document.hidden) void reload(false).catch(() => undefined);
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
        await reload(false);
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
  function saveText(field: TextField) {
    const value = field === "title" ? drafts.title.trim() : drafts[field];
    if (value === latest.current[field] || (field === "title" && !value)) {
      if (field === "title" && !value)
        setDrafts((current) => ({ ...current, title: latest.current.title }));
      return;
    }
    const base = latest.current[field];
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
        const next = await cloudRequest<CloudIssue>(`issues/${issue.id}`);
        setIssue(next);
        setSaveState("saved");
        refreshHistory();
        router.refresh();
      })
      .catch((reason: Error) => {
        setSaveState("idle");
        setConflict(reason.message);
      });
  }
  const assignee = workspace.members.find(
    (member) => member.id === issue.assigneeId,
  );
  const project = workspace.projects.find(
    (entry) => entry.id === issue.projectId,
  );
  const cycle = workspace.cycles.find((entry) => entry.id === issue.cycleId);
  return (
    <>
      <header className="cloud-issue-header">
        <nav className="cloud-issue-breadcrumb" aria-label="Issue location">
          <Link href={`/cloud/issues?teamId=${team.id}`}>{team.name}</Link>
          <ChevronRight size={13} aria-hidden="true" />
          <h1 className="cloud-issue-key">{issue.identifier}</h1>
          {issue.archived && <span className="cloud-issue-flag">Archived</span>}
          <span role="status" className="cloud-issue-save-state">
            {saveState === "saving"
              ? "Saving…"
              : saveState === "saved" && !dirty
                ? "Saved"
                : ""}
          </span>
        </nav>
        <div className="cloud-issue-actions">
          {writable &&
            !issue.archived &&
            !["complete", "canceled"].includes(issue.state) && (
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
          <Button asChild variant="ghost" size="sm">
            <Link href={`/cloud/chat?issue=${issue.id}`}>
              <Sparkles />
              Ask
            </Link>
          </Button>
        </div>
      </header>
      <div className="cloud-issue-layout">
        <div className="cloud-issue-document">
          <label className="sr-only" htmlFor="title">
            Title
          </label>
          <Textarea
            id="title"
            name="title"
            className="cloud-issue-title-input"
            value={drafts.title}
            rows={1}
            disabled={!writable}
            maxLength={300}
            onChange={(event) =>
              setDrafts((current) => ({
                ...current,
                title: event.target.value.replace(/[\r\n]+/g, " "),
              }))
            }
            onBlur={() => saveText("title")}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
          />
          <label className="sr-only" htmlFor="description">
            Description
          </label>
          <Textarea
            id="description"
            name="description"
            className="cloud-issue-description-input"
            placeholder="Add a description…"
            value={drafts.description}
            disabled={!writable}
            maxLength={30000}
            onChange={(event) =>
              setDrafts((current) => ({
                ...current,
                description: event.target.value,
              }))
            }
            onBlur={() => saveText("description")}
          />
          <div className="cloud-issue-section">
            <label htmlFor="acceptance">Acceptance criteria</label>
            <Textarea
              id="acceptance"
              name="acceptanceCriteria"
              placeholder="What must be true when this is done?"
              value={drafts.acceptanceCriteria}
              disabled={!writable}
              maxLength={20000}
              onChange={(event) =>
                setDrafts((current) => ({
                  ...current,
                  acceptanceCriteria: event.target.value,
                }))
              }
              onBlur={() => saveText("acceptanceCriteria")}
            />
          </div>
          {conflict && (
            <div role="alert" className="cloud-error">
              <p>{conflict}</p>
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  void reload(true).catch((reason: Error) =>
                    setConflict(reason.message),
                  )
                }
              >
                Reload issue
              </Button>
            </div>
          )}
        </div>
        <aside className="cloud-issue-aside" aria-label="Issue properties">
          <div className="cloud-issue-properties">
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
                  <span className="cloud-property-empty">Unassigned</span>
                )
              }
              onSelect={(value) =>
                changeProperties({ assigneeId: referenceValue(value) })
              }
            />
            <Property
              label="Project"
              writable={writable}
              options={projectOptions(workspace, issue.teamId)}
              value={issue.projectId ?? noValue}
              display={
                project?.name ?? (
                  <span className="cloud-property-empty">No project</span>
                )
              }
              onSelect={(value) =>
                changeProperties({ projectId: referenceValue(value) })
              }
            />
            <Property
              label="Cycle"
              writable={writable}
              options={cycleOptions(workspace, issue.teamId, issue.cycleId)}
              value={issue.cycleId ?? noValue}
              display={
                cycle?.name ?? (
                  <span className="cloud-property-empty">No cycle</span>
                )
              }
              onSelect={(value) =>
                changeProperties({ cycleId: referenceValue(value) })
              }
            />
            <Property
              label="Estimate"
              writable={writable}
              options={estimateOptions(team, issue.estimate)}
              value={issue.estimate ?? noValue}
              display={
                issue.estimate ?? (
                  <span className="cloud-property-empty">Not estimated</span>
                )
              }
              onSelect={(value) =>
                changeProperties({ estimate: referenceValue(value) })
              }
            />
            <div className="cloud-property">
              <label className="cloud-property-label" htmlFor="due">
                Due date
              </label>
              <input
                className="cloud-property-value cloud-property-date"
                type="date"
                id="due"
                disabled={!writable}
                value={issue.dueOn ?? ""}
                onChange={(event) =>
                  changeProperties({ dueOn: event.target.value || null })
                }
              />
            </div>
          </div>
          <IssueLabels issue={issue} writable={writable} />
          {activeRunId && (
            <Button asChild variant="outline" size="sm">
              <Link href={`/cloud/tasks/${activeRunId}`}>
                <Bot />
                AI task running
              </Link>
            </Button>
          )}
          {writable && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => changeProperties({ archived: !issue.archived })}
            >
              {issue.archived ? <ArchiveRestore /> : <Archive />}
              {issue.archived ? "Restore issue" : "Archive issue"}
            </Button>
          )}
        </aside>
      </div>
      <Tabs
        value={panel}
        onValueChange={(next) => {
          setPanel(next);
          setVisited((current) => new Set(current).add(next));
        }}
        className="cloud-issue-panels"
      >
        <TabsList aria-label="Issue details">
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="relationships">Relationships</TabsTrigger>
          <TabsTrigger value="poker">Planning poker</TabsTrigger>
          <TabsTrigger value="tasks">AI tasks</TabsTrigger>
        </TabsList>
        <TabsContent value="activity" forceMount>
          <IssueComments issue={issue} workspace={workspace} history={history} />
        </TabsContent>
        <TabsContent value="relationships" forceMount>
          {visited.has("relationships") && (
            <IssueRelations
              issue={issue}
              workspace={workspace}
              writable={writable}
            />
          )}
        </TabsContent>
        <TabsContent value="poker" forceMount>
          {visited.has("poker") && (
            <PokerPanel
              issue={issue}
              workspace={workspace}
              dirty={dirty}
              onDecision={async () => {
                await reload(false);
              }}
            />
          )}
        </TabsContent>
        <TabsContent value="tasks" forceMount>
          {visited.has("tasks") && (
            <TaskList issue={issue} workspace={workspace} dirty={dirty} />
          )}
        </TabsContent>
      </Tabs>
    </>
  );
}
