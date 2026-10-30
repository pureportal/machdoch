"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { Bot, ChevronRight, History, Sparkles } from "lucide-react";
import {
  issuePriorities,
  issueUpdateSchema,
  type CloudIssue,
  type IssueSnapshot,
  type CloudWorkspace,
} from "@/lib/cloud-contract";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Field } from "@/components/field";
import {
  cloudRequest,
  createCommandSender,
  formReference,
  formText,
} from "./api-client";
import { PokerPanel } from "./poker-panel";
import { IssueComments } from "./comments";
import { TaskList } from "./task-list";
import { IssueLabels } from "./issue-labels";
import { IssueRelations } from "./issue-relations";
import { Timestamp } from "./timestamp";
import {
  WorkflowStatusField,
  formIssueStatus,
  isWorkflowConflict,
} from "./workflow-status-field";

type IssueHistory = {
  revision: number;
  actor: string;
  snapshot: IssueSnapshot;
  statusName: string;
  createdAt: string;
}[];

export function IssueEditor({
  initial,
  workspace,
}: {
  initial: CloudIssue;
  workspace: CloudWorkspace;
}) {
  const [issue, setIssue] = useState(initial);
  const [pending, setPending] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [workflowReload, setWorkflowReload] = useState(0);
  const [history, setHistory] = useState<IssueHistory | null>(null);
  const [panel, setPanel] = useState("activity");
  const [delegateRequest, setDelegateRequest] = useState(0);
  const sender = useRef(createCommandSender());
  const writable = workspace.actor.role !== "viewer";
  const team = workspace.teams.find((entry) => entry.id === issue.teamId)!;
  async function reload() {
    const latest = await cloudRequest<CloudIssue>(`issues/${issue.id}`);
    setIssue(latest);
    setDirty(false);
    setError("");
    setHistory(null);
    sender.current = createCommandSender();
  }
  function archive() {
    setPending(true);
    setError("");
    void sender
      .current(
        `issues/${issue.id}`,
        {
          ...issueUpdateSchema.strip().parse(issue),
          archived: !issue.archived,
        },
        "PATCH",
      )
      .then(reload)
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setPending(false));
  }
  return (
    <>
      <header className="cloud-issue-header">
        <nav className="cloud-issue-breadcrumb" aria-label="Issue location">
          <Link href={`/cloud/issues?teamId=${team.id}`}>{team.name}</Link>
          <ChevronRight size={13} aria-hidden="true" />
          <h1 className="cloud-issue-key">{issue.identifier}</h1>
          {issue.archived && <span className="cloud-issue-flag">Archived</span>}
        </nav>
        <div className="cloud-issue-actions">
          {writable &&
            !issue.archived &&
            !["complete", "canceled"].includes(issue.state) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setPanel("tasks");
                  setDelegateRequest((previous) => previous + 1);
                }}
              >
                <Bot />
                Delegate
              </Button>
            )}
          <Button asChild variant="ghost" size="sm">
            <Link href={`/cloud/chat?issue=${issue.id}`}>
              <Sparkles />
              Ask
            </Link>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              void cloudRequest<{ history: IssueHistory }>(
                `issues/${issue.id}/history`,
              )
                .then((value) => setHistory(value.history))
                .catch((reason: Error) => setError(reason.message))
            }
          >
            <History />
            History
          </Button>
        </div>
      </header>
      <div className="cloud-issue-layout">
        <form
          className="cloud-issue-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (pending || !writable) return;
            const form = new FormData(event.currentTarget);
            const parsed = issueUpdateSchema.strip().safeParse({
              ...issue,
              title: formText(form, "title"),
              description: formText(form, "description"),
              acceptanceCriteria: formText(form, "acceptanceCriteria"),
              status: formIssueStatus(form),
              priority: formText(form, "priority"),
              projectId: formReference(form, "projectId"),
              cycleId: formReference(form, "cycleId"),
              assigneeId: formReference(form, "assigneeId"),
              estimate: formReference(form, "estimate"),
              dueOn: formReference(form, "dueOn"),
            });
            if (!parsed.success) {
              setError(parsed.error.issues[0]!.message);
              return;
            }
            setPending(true);
            setError("");
            setSaved(false);
            void sender
              .current(`issues/${issue.id}`, parsed.data, "PATCH")
              .then(reload)
              .then(() => setSaved(true))
              .catch((reason: Error) => {
                setError(reason.message);
                if (isWorkflowConflict(reason))
                  setWorkflowReload((previous) => previous + 1);
              })
              .finally(() => setPending(false));
          }}
        >
          <fieldset
            className="cloud-issue-fieldset"
            key={`${issue.id}:${issue.revision}`}
            disabled={pending || !writable}
            onChange={() => {
              setDirty(true);
              setSaved(false);
            }}
          >
            <div className="cloud-issue-document">
              <label className="sr-only" htmlFor="title">
                Title
              </label>
              <Textarea
                id="title"
                name="title"
                className="cloud-issue-title-input"
                defaultValue={issue.title}
                rows={1}
                onChange={(event) => {
                  event.currentTarget.value = event.currentTarget.value.replace(
                    /[\r\n]+/g,
                    " ",
                  );
                }}
                maxLength={300}
                required
              />
              <label className="sr-only" htmlFor="description">
                Description
              </label>
              <Textarea
                id="description"
                name="description"
                className="cloud-issue-description-input"
                placeholder="Add a description…"
                defaultValue={issue.description}
                maxLength={30000}
              />
              <div className="cloud-issue-section">
                <label htmlFor="acceptance">Acceptance criteria</label>
                <Textarea
                  id="acceptance"
                  name="acceptanceCriteria"
                  defaultValue={issue.acceptanceCriteria}
                  maxLength={20000}
                />
              </div>
              {writable && (
                <div className="cloud-issue-savebar">
                  <span role="status" className="cloud-issue-save-state">
                    {saved ? "Saved" : dirty ? "Unsaved changes" : ""}
                  </span>
                  <Button type="submit" disabled={!dirty}>
                    {pending ? "Saving…" : "Save changes"}
                  </Button>
                </div>
              )}
              {error && (
                <div role="alert" className="cloud-error">
                  <p>{error}</p>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      void reload().catch((reason: Error) =>
                        setError(reason.message),
                      )
                    }
                  >
                    Reload issue
                  </Button>
                </div>
              )}
            </div>
            <div className="cloud-issue-properties">
              <WorkflowStatusField
                id="issue-status"
                initial={workspace.workflows.find(
                  (workflow) => workflow.teamId === issue.teamId,
                )!}
                current={issue}
                reloadRequest={workflowReload}
              />
              <Field label="Priority" htmlFor="priority">
                <Select
                  id="priority"
                  name="priority"
                  defaultValue={issue.priority}
                >
                  {issuePriorities.map((priority) => (
                    <option key={priority} value={priority}>
                      {priority[0]!.toUpperCase() + priority.slice(1)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Assignee" htmlFor="assignee">
                <Select
                  id="assignee"
                  name="assigneeId"
                  defaultValue={issue.assigneeId ?? ""}
                >
                  <option value="">Unassigned</option>
                  {workspace.members.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Project" htmlFor="project">
                <Select
                  id="project"
                  name="projectId"
                  defaultValue={issue.projectId ?? ""}
                >
                  <option value="">No project</option>
                  {workspace.projects
                    .filter((project) => project.teamId === issue.teamId)
                    .map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                </Select>
              </Field>
              <Field label="Cycle" htmlFor="cycle">
                <Select
                  id="cycle"
                  name="cycleId"
                  defaultValue={issue.cycleId ?? ""}
                >
                  <option value="">No cycle</option>
                  {workspace.cycles
                    .filter(
                      (cycle) =>
                        cycle.teamId === issue.teamId &&
                        (cycle.status !== "closed" ||
                          cycle.id === issue.cycleId),
                    )
                    .map((cycle) => (
                      <option key={cycle.id} value={cycle.id}>
                        {cycle.name}
                      </option>
                    ))}
                </Select>
              </Field>
              <Field label="Estimate" htmlFor="estimate">
                <Select
                  id="estimate"
                  name="estimate"
                  defaultValue={issue.estimate ?? ""}
                >
                  <option value="">Not estimated</option>
                  {issue.estimate &&
                    !team.estimateScale.some(
                      (card) => card.label === issue.estimate,
                    ) && (
                      <option value={issue.estimate}>{issue.estimate}</option>
                    )}
                  {team.estimateScale
                    .filter((card) => card.points !== null)
                    .map((card) => (
                      <option key={card.label} value={card.label}>
                        {card.label}
                      </option>
                    ))}
                </Select>
              </Field>
              <Field label="Due date" htmlFor="due">
                <Input
                  type="date"
                  id="due"
                  name="dueOn"
                  defaultValue={issue.dueOn ?? ""}
                />
              </Field>
            </div>
          </fieldset>
        </form>
        <aside className="cloud-issue-aside" aria-label="Issue organization">
          <IssueLabels issue={issue} writable={writable} />
          {writable && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={archive}
              disabled={dirty || pending}
            >
              {issue.archived ? "Restore issue" : "Archive issue"}
            </Button>
          )}
        </aside>
      </div>
      {history && (
        <section className="cloud-issue-history" aria-label="Issue history">
          <header>
            <h2>History</h2>
            <Button variant="ghost" size="sm" onClick={() => setHistory(null)}>
              Close history
            </Button>
          </header>
          <ol>
            {history.map((entry) => (
              <li key={entry.revision}>
                <span>
                  {entry.actor} · <Timestamp value={entry.createdAt} />
                </span>
                <p>
                  {entry.snapshot.title} · {entry.statusName}
                  {entry.snapshot.estimate
                    ? ` · ${entry.snapshot.estimate} points`
                    : ""}
                </p>
              </li>
            ))}
          </ol>
        </section>
      )}
      <Tabs
        value={panel}
        onValueChange={setPanel}
        className="cloud-issue-panels"
      >
        <TabsList aria-label="Issue details">
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="relationships">Relationships</TabsTrigger>
          <TabsTrigger value="poker">Planning poker</TabsTrigger>
          <TabsTrigger value="tasks">AI tasks</TabsTrigger>
        </TabsList>
        <TabsContent value="activity" forceMount>
          <IssueComments issue={issue} workspace={workspace} />
        </TabsContent>
        <TabsContent value="relationships" forceMount>
          <IssueRelations
            issue={issue}
            workspace={workspace}
            writable={writable}
          />
        </TabsContent>
        <TabsContent value="poker" forceMount>
          <PokerPanel
            issue={issue}
            workspace={workspace}
            dirty={dirty}
            onDecision={reload}
          />
        </TabsContent>
        <TabsContent value="tasks" forceMount>
          <TaskList
            issue={issue}
            workspace={workspace}
            dirty={dirty}
            startRequest={delegateRequest}
          />
        </TabsContent>
      </Tabs>
    </>
  );
}
