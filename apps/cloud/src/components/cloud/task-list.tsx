"use client";
import { pollWhileVisible } from "@machdoch/product-ui/view-visibility";
import { holderCan } from "@/lib/cloud-permissions";
import { executionTargetLabels, profileAgentLabel } from "./execution-labels";

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

function enabledProfiles(profiles: ExecutionProfile[]): ExecutionProfile[] {
  return profiles.filter((profile) => profile.enabled);
}

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
  const [profilesReady, setProfilesReady] = useState(false);
  const [starting, setStarting] = useState(false);
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
    let profilesLoaded = false;
    async function poll() {
      try {
        const [tasks, settings] = await Promise.all([
          cloudRequest<{ runs: CloudRun[] }>(
            `runs${issueId ? `?issueId=${issueId}` : ""}`,
            { signal: abort.signal },
          ),
          profilesLoaded
            ? null
            : cloudRequest<{ profiles: ExecutionProfile[] }>(
                "execution-profiles",
                { signal: abort.signal },
              ),
        ]);
        if (!abort.signal.aborted) {
          setRuns(tasks.runs);
          if (settings) {
            setProfiles(enabledProfiles(settings.profiles));
            setProfilesReady(true);
            profilesLoaded = true;
          }
          setError("");
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
    }
    const stop = pollWhileVisible(poll, 5000);
    return () => {
      abort.abort();
      stop();
    };
  }, [issueId]);
  const canStart =
    holderCan(workspace.actor, "ai.tasks") &&
    !issue?.archived &&
    (!issue || !["complete", "canceled"].includes(issue.state));
  const readyProjects = workspace.projects.filter((project) =>
    profiles.some((profile) => profile.projectId === project.id),
  );
  const selectedProject =
    issue?.projectId ??
    (readyProjects.some((project) => project.id === projectId)
      ? projectId
      : (readyProjects[0]?.id ?? ""));
  const available = profiles.filter(
    (profile) => profile.projectId === selectedProject,
  );
  async function queue(profileId: string, subject: Record<string, unknown>) {
    const result = await sender.current<{ id: string }>("runs", {
      profileId,
      subject,
    });
    router.push(`/cloud/tasks/${result.id}`);
    router.refresh();
  }
  function start() {
    if (starting) return;
    if (issue && !issue.projectId) {
      setError("Add the issue to a project before starting a task.");
      return;
    }
    if (issue && available.length === 1) {
      setError("");
      setStarting(true);
      void queue(available[0]!.id, {
        kind: "issue",
        id: issue.id,
        revision: issue.revision,
      })
        .catch((reason: Error) => setError(reason.message))
        .finally(() => setStarting(false));
      return;
    }
    setOpen(true);
  }
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
            disabled={dirty || starting || !profilesReady}
            onClick={start}
          >
            {issue ? <Bot /> : <Plus />}
            {starting ? "Starting…" : issue ? "Start AI task" : "New task"}
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
        submitLabel="Start task"
        pendingLabel="Starting…"
        submitDisabled={!available.length}
        onSubmit={async (form) => {
          const profileId = formText(form, "profileId");
          const project = workspace.projects.find(
            (entry) => entry.id === selectedProject,
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
          await queue(profileId, subject);
        }}
      >
        {!issue && (
          <>
            <Field label="Project" htmlFor="task-project">
              <Select
                id="task-project"
                value={selectedProject}
                onChange={(event) => setProjectId(event.target.value)}
                required
              >
                <option value="" disabled>
                  Select project
                </option>
                {readyProjects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Purpose" htmlFor="task-purpose">
              <Select id="task-purpose" name="purpose">
                <option value="research">Research and report</option>
                <option value="maintenance">Maintenance</option>
                <option value="test">Testing</option>
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
        {available.length > 1 ? (
          <Field label="AI setup" htmlFor="task-profile">
            <Select
              id="task-profile"
              name="profileId"
              required
              key={selectedProject}
              defaultValue={available[0]!.id}
            >
              {available.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name} · {executionTargetLabels[profile.target]} ·{" "}
                  {profileAgentLabel(profile)}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          available[0] && (
            <input type="hidden" name="profileId" value={available[0].id} />
          )
        )}
        {!available.length && (
          <p>
            {readyProjects.length || issue
              ? "AI is not set up for this project yet."
              : "AI is not set up for any project yet."}
            {holderCan(workspace.actor, "ai.manage") && (
              <>
                {" "}
                <Link className="underline" href="/cloud/execution">
                  Set up AI
                </Link>
              </>
            )}
          </p>
        )}
      </FormDialog>
    </section>
  );
}
