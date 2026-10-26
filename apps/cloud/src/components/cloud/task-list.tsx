"use client";
import { executionTargetLabels } from "./execution-labels";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Bot, Plus } from "lucide-react";
import type { CloudIssue, CloudWorkspace } from "@/lib/cloud-contract";
import type {
  CloudRun,
  ExecutionProfile,
} from "@machdoch/fleet-protocol/cloud-execution";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { TaskResults } from "./task-results";
import {
  CloudRequestError,
  cloudRequest,
  createCommandSender,
  formText,
} from "./api-client";

export function TaskList({
  workspace,
  initial = [],
  issue,
  dirty = false,
}: {
  workspace: CloudWorkspace;
  initial?: CloudRun[];
  issue?: CloudIssue;
  dirty?: boolean;
}) {
  const [runs, setRuns] = useState(initial);
  const [profiles, setProfiles] = useState<ExecutionProfile[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [projectId, setProjectId] = useState(
    issue?.projectId ?? workspace.projects[0]?.id ?? "",
  );
  const sender = useRef(createCommandSender());
  const router = useRouter();
  const issueId = issue?.id;
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        if (!document.hidden) {
          const [tasks, settings] = await Promise.all([
            cloudRequest<{ runs: CloudRun[] }>(
              `runs${issueId ? `?issueId=${issueId}` : ""}`,
              { signal: abort.signal },
            ),
            cloudRequest<{ profiles: ExecutionProfile[] }>(
              "execution-profiles",
              { signal: abort.signal },
            ),
          ]);
          if (!abort.signal.aborted) {
            setRuns(tasks.runs);
            setProfiles(settings.profiles.filter((profile) => profile.enabled));
            setError("");
          }
        }
      } catch (reason) {
        if (abort.signal.aborted) return;
        if (
          reason instanceof CloudRequestError &&
          [401, 403, 404].includes(reason.status)
        ) {
          setRuns([]);
          setProfiles([]);
        }
        setError((reason as Error).message);
      }
      if (!abort.signal.aborted) timer = setTimeout(() => void poll(), 5000);
    }
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [issueId]);
  const canStart =
    workspace.actor.role !== "viewer" &&
    !issue?.archived &&
    (!issue || !["complete", "canceled"].includes(issue.state));
  const selectedProject = issue?.projectId ?? projectId;
  const available = profiles.filter(
    (profile) => profile.projectId === selectedProject,
  );
  return (
    <section
      className={issue ? "cloud-issue-tasks" : undefined}
      aria-labelledby={issue ? "issue-tasks-heading" : "tasks-heading"}
    >
      <header className="cloud-page-header">
        {issue ? (
          <h2 id="issue-tasks-heading">AI tasks</h2>
        ) : (
          <h1 id="tasks-heading">AI tasks</h1>
        )}
        {canStart && (
          <Button
            variant={issue ? "outline" : "default"}
            disabled={dirty}
            onClick={() => {
              if (issue && !issue.projectId) {
                setError("Assign a project before starting a task.");
                return;
              }
              if (issue && !issue.acceptanceCriteria.trim()) {
                setError("Add acceptance criteria before starting a task.");
                return;
              }
              sender.current = createCommandSender();
              setOpen(true);
            }}
          >
            <Plus />
            New task
          </Button>
        )}
      </header>
      {dirty && (
        <p className="text-muted-foreground mb-4">
          Save changes before starting a task.
        </p>
      )}
      {error && (
        <p role="alert" className="cloud-error">
          {error}
        </p>
      )}
      {!runs.length ? (
        <div className="cloud-empty">
          <Bot aria-hidden="true" />
          <p>No tasks yet.</p>
        </div>
      ) : (
        <TaskResults runs={runs} workspace={workspace} />
      )}
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title="New AI task"
        submitLabel="Queue task"
        onSubmit={async (form) => {
          const profileId = formText(form, "profileId");
          if (!profileId)
            throw new Error("Configure an execution profile for this project.");
          const project = workspace.projects.find(
            (entry) => entry.id === projectId,
          );
          if (!issue && !project) throw new Error("Choose a project.");
          const subject = issue
            ? { kind: "issue", id: issue.id, revision: issue.revision }
            : {
                kind: "project",
                id: project!.id,
                revision: project!.revision,
                purpose: formText(form, "purpose"),
                objective: formText(form, "objective"),
                acceptanceCriteria: formText(form, "acceptanceCriteria"),
              };
          const result = await sender.current<{ id: string }>("runs", {
            profileId,
            subject,
          });
          router.push(`/cloud/tasks/${result.id}`);
          router.refresh();
        }}
      >
        {!issue && (
          <>
            <Field label="Project" htmlFor="task-project">
              <Select
                id="task-project"
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
                required
              >
                <option value="" disabled>
                  Select project
                </option>
                {workspace.projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Purpose" htmlFor="task-purpose">
              <Select id="task-purpose" name="purpose">
                <option value="research">Research</option>
                <option value="maintenance">Maintenance</option>
                <option value="test">Test</option>
              </Select>
            </Field>
            <Field label="Objective" htmlFor="task-objective">
              <Textarea
                id="task-objective"
                name="objective"
                required
                maxLength={20000}
              />
            </Field>
            <Field label="Acceptance criteria" htmlFor="task-acceptance">
              <Textarea
                id="task-acceptance"
                name="acceptanceCriteria"
                required
                maxLength={20000}
              />
            </Field>
          </>
        )}
        <Field label="Execution profile" htmlFor="task-profile">
          <Select
            id="task-profile"
            name="profileId"
            required
            key={selectedProject}
          >
            <option value="" disabled>
              Select profile
            </option>
            {available.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name} · {executionTargetLabels[profile.target]}
              </option>
            ))}
          </Select>
        </Field>
        {!available.length && (
          <p>
            No execution profiles for this project.
            {["owner", "admin"].includes(workspace.actor.role) && (
              <>
                {" "}
                <Link className="underline" href="/cloud/execution">
                  Configure execution
                </Link>
              </>
            )}
          </p>
        )}
      </FormDialog>
    </section>
  );
}
