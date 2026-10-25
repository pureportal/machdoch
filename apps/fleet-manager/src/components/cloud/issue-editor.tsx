"use client";

import Link from "next/link";
import { useRef, useState } from "react";
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
import {
  WorkflowStatusField,
  formIssueStatus,
  isWorkflowConflict,
} from "./workflow-status-field";

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
  const [history, setHistory] = useState<
    | {
        revision: number;
        actor: string;
        snapshot: IssueSnapshot;
        statusName: string;
        createdAt: string;
      }[]
    | null
  >(null);
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
  return (
    <>
      <header className="cloud-page-header">
        <div className="flex min-w-0 items-center gap-4">
          <Link href="/cloud/issues">Issues</Link>
          <span className="cloud-issue-key">{issue.identifier}</span>
          {issue.archived && <span>Archived</span>}
        </div>
        <Button
          variant="ghost"
          onClick={() =>
            void cloudRequest<{ history: NonNullable<typeof history> }>(
              `issues/${issue.id}/history`,
            )
              .then((value) => setHistory(value.history))
              .catch((reason: Error) => setError(reason.message))
          }
        >
          History
        </Button>
      </header>
      <form
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
          const body = parsed.data;
          setPending(true);
          setError("");
          setSaved(false);
          void sender
            .current(`issues/${issue.id}`, body, "PATCH")
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
          className="cloud-editor"
          key={`${issue.id}:${issue.revision}`}
          disabled={pending || !writable}
          onChange={() => {
            setDirty(true);
            setSaved(false);
          }}
        >
          <div className="cloud-editor-body">
            <Field label="Title" htmlFor="title">
              <Input
                id="title"
                name="title"
                defaultValue={issue.title}
                maxLength={300}
                required
              />
            </Field>
            <Field label="Description" htmlFor="description">
              <Textarea
                id="description"
                name="description"
                defaultValue={issue.description}
                maxLength={30000}
              />
            </Field>
            <Field label="Acceptance criteria" htmlFor="acceptance">
              <Textarea
                id="acceptance"
                name="acceptanceCriteria"
                defaultValue={issue.acceptanceCriteria}
                maxLength={20000}
              />
            </Field>
            {writable && (
              <div className="cloud-editor-actions">
                <Button type="submit" disabled={!dirty}>
                  {pending ? "Saving…" : "Save changes"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
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
                  }}
                  disabled={dirty}
                >
                  {issue.archived ? "Restore issue" : "Archive issue"}
                </Button>
              </div>
            )}
          </div>
          <div className="cloud-editor-properties">
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
                      (cycle.status !== "closed" || cycle.id === issue.cycleId),
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
                  ) && <option value={issue.estimate}>{issue.estimate}</option>}
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
        {error && (
          <div role="alert" className="cloud-error">
            <p>{error}</p>
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                void reload().catch((reason: Error) => setError(reason.message))
              }
            >
              Reload issue
            </Button>
          </div>
        )}
        {saved && (
          <p role="status" className="mt-3 text-muted-foreground">
            Saved
          </p>
        )}
      </form>
      {history && (
        <section className="cloud-card mt-6" aria-label="Issue history">
          <div className="flex justify-between">
            <h2>History</h2>
            <Button variant="ghost" onClick={() => setHistory(null)}>
              Close history
            </Button>
          </div>
          {history.map((entry) => (
            <div key={entry.revision}>
              <span className="text-muted-foreground">
                {entry.actor} · {new Date(entry.createdAt).toLocaleString()}
              </span>
              <p>
                {entry.snapshot.title} · {entry.statusName}
                {entry.snapshot.estimate
                  ? ` · ${entry.snapshot.estimate} points`
                  : ""}
              </p>
            </div>
          ))}
        </section>
      )}
      <IssueLabels issue={issue} writable={writable} />
      <IssueRelations issue={issue} workspace={workspace} writable={writable} />
      <PokerPanel
        issue={issue}
        workspace={workspace}
        dirty={dirty}
        onDecision={reload}
      />
      <TaskList issue={issue} workspace={workspace} dirty={dirty} />
      <IssueComments issue={issue} workspace={workspace} />
    </>
  );
}
