"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { ExecutionProfile } from "@machdoch/fleet-protocol/cloud-execution";
import type {
  CloudIssue,
  CloudProject,
  CloudWorkspace,
} from "@/lib/cloud-contract";
import type { ScheduleAction } from "@/lib/cloud-schedule-contract";
import { cloudRequest } from "./api-client";
import { executionTargetLabels, profileAgentLabel } from "./execution-labels";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

type TaskAction = Extract<ScheduleAction, { kind: "run-task" }>;
export function ScheduleTaskFields({
  workspace,
  teamId,
  initial,
  onChange,
  reloadRevision,
}: {
  workspace: CloudWorkspace;
  teamId: string;
  initial?: TaskAction;
  onChange: (action: TaskAction | null) => void;
  reloadRevision: number;
}) {
  const [profiles, setProfiles] = useState<ExecutionProfile[]>([]);
  const [profileId, setProfileId] = useState(initial?.run.profileId ?? "");
  const [scope, setScope] = useState(initial?.run.subject.kind ?? "project");
  const [purpose, setPurpose] = useState(
    initial?.run.subject.kind === "project"
      ? initial.run.subject.purpose
      : "maintenance",
  );
  const [objective, setObjective] = useState(
    initial?.run.subject.kind === "project"
      ? initial.run.subject.objective
      : "",
  );
  const [criteria, setCriteria] = useState(
    initial?.run.subject.kind === "project"
      ? initial.run.subject.acceptanceCriteria
      : "",
  );
  const [issueId, setIssueId] = useState(
    initial?.run.subject.kind === "issue" ? initial.run.subject.id : "",
  );
  const [issues, setIssues] = useState<CloudIssue[]>([]);
  const [query, setQuery] = useState("");
  const [selectedIssue, setSelectedIssue] = useState<CloudIssue | null>(null);
  const [maxRuns, setMaxRuns] = useState(String(initial?.maxRuns ?? 1));
  const [maxTokens, setMaxTokens] = useState(
    initial ? String(initial.maxTokens) : "",
  );
  const initialExpiry = initial
    ? new Date(initial.expiresAt).toISOString().slice(0, 16)
    : "";
  const [expiry, setExpiry] = useState(
    initialExpiry ||
      new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 16),
  );
  const [loading, setLoading] = useState(true);
  const [subjectLoading, setSubjectLoading] = useState(false);
  const [error, setError] = useState("");
  const [subjectError, setSubjectError] = useState("");
  const [reload, setReload] = useState(0);
  const profile = profiles.find(
    (entry) =>
      entry.id === profileId && entry.teamId === teamId && entry.enabled,
  );
  const [project, setProject] = useState<CloudProject | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError("");
    void cloudRequest<{ profiles: ExecutionProfile[] }>("execution-profiles", {
      signal: abort.signal,
    })
      .then((result) => {
        if (!abort.signal.aborted)
          setProfiles(
            result.profiles.filter((entry) => entry.teamId === teamId),
          );
      })
      .catch((reason: Error) => {
        if (!abort.signal.aborted) setError(reason.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [teamId, reload, reloadRevision]);
  useEffect(() => {
    const abort = new AbortController();
    setSubjectError("");
    setSelectedIssue(null);
    setProject(null);
    setIssues([]);
    if (!profile?.projectId) {
      setSubjectLoading(false);
      return () => abort.abort();
    }
    setSubjectLoading(true);
    const timer = setTimeout(() => {
      void Promise.all([
        cloudRequest<CloudProject>(`projects/${profile.projectId}`, {
          signal: abort.signal,
        }),
        scope === "issue"
          ? cloudRequest<{ issues: CloudIssue[] }>(
              `issues?projectId=${profile.projectId}&query=${encodeURIComponent(query)}`,
              { signal: abort.signal },
            )
          : Promise.resolve({ issues: [] }),
        scope === "issue" && issueId
          ? cloudRequest<CloudIssue>(`issues/${issueId}`, {
              signal: abort.signal,
            })
          : Promise.resolve(null),
      ])
        .then(([currentProject, result, issue]) => {
          if (abort.signal.aborted) return;
          setProject(currentProject);
          setIssues(
            result.issues.filter(
              (entry) =>
                !entry.archived &&
                !["complete", "canceled"].includes(entry.state),
            ),
          );
          setSelectedIssue(
            issue?.projectId === profile.projectId ? issue : null,
          );
        })
        .catch((reason: Error) => {
          if (!abort.signal.aborted) setSubjectError(reason.message);
        })
        .finally(() => {
          if (!abort.signal.aborted) setSubjectLoading(false);
        });
    }, 200);
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [scope, profile?.projectId, issueId, query, reload, reloadRevision]);
  let action: TaskAction | null = null;
  if (
    profile &&
    project &&
    project.id === profile.projectId &&
    !loading &&
    !subjectLoading &&
    !error &&
    !subjectError
  ) {
    const subject =
      scope === "issue"
        ? selectedIssue &&
          selectedIssue.id === issueId &&
          !selectedIssue.archived &&
          !["complete", "canceled"].includes(selectedIssue.state)
          ? {
              kind: "issue" as const,
              id: selectedIssue.id,
              revision: selectedIssue.revision,
            }
          : null
        : {
            kind: "project" as const,
            id: project.id,
            revision: project.revision,
            purpose,
            objective,
            acceptanceCriteria: criteria,
          };
    if (subject && Number.isFinite(Date.parse(expiry + "Z")))
      action = {
        kind: "run-task",
        run: { profileId: profile.id, subject },
        profileRevision: profile.revision,
        maxRuns: Number(maxRuns),
        maxTokens: Number(maxTokens),
        expiresAt:
          initial && expiry === initialExpiry
            ? initial.expiresAt
            : new Date(expiry + "Z").toISOString(),
      };
  }
  const serialized = JSON.stringify(action);
  useEffect(() => {
    onChange(JSON.parse(serialized) as TaskAction | null);
  }, [serialized, onChange]);
  return (
    <div className="grid min-w-0 gap-4">
      <Field label="Execution profile" htmlFor="schedule-profile">
        <Select
          id="schedule-profile"
          value={profileId}
          required
          disabled={loading}
          onChange={(event) => {
            const next = profiles.find(
              (entry) => entry.id === event.target.value,
            );
            setProfileId(event.target.value);
            setIssueId("");
            if (!maxTokens && next) setMaxTokens(String(next.maxTokens));
          }}
        >
          <option value="">Choose a profile</option>
          {profiles.map((entry) => (
            <option key={entry.id} value={entry.id} disabled={!entry.enabled}>
              {project?.id === entry.projectId
                ? project.name
                : workspace.projects.find(
                    (value) => value.id === entry.projectId,
                  )?.name}{" "}
              · {entry.name}
              {entry.enabled ? "" : " (disabled)"}
            </option>
          ))}
        </Select>
      </Field>
      {error && (
        <div>
          <p role="alert">{error}</p>
          <Button
            type="button"
            variant="outline"
            onClick={() => setReload(reload + 1)}
          >
            Reload profiles
          </Button>
        </div>
      )}
      {!loading && !error && !profiles.length && (
        <p>
          No execution profiles for this team.{" "}
          <Link className="underline" href="/cloud/execution">
            Configure a profile
          </Link>
        </p>
      )}
      {profile && (
        <p className="text-sm text-muted-foreground">
          {executionTargetLabels[profile.target]} · {profileAgentLabel(profile)}{" "}
          · Up to {profile.maxTokens.toLocaleString()} tokens per task
        </p>
      )}
      {initial && profile && initial.profileRevision !== profile.revision && (
        <p role="status">
          The execution profile changed. Review its settings before saving.
        </p>
      )}
      <Field label="Task scope" htmlFor="schedule-task-scope">
        <Select
          id="schedule-task-scope"
          value={scope}
          onChange={(event) =>
            setScope(event.target.value as "issue" | "project")
          }
        >
          <option value="project">Project task</option>
          <option value="issue">Issue implementation</option>
        </Select>
      </Field>
      {scope === "issue" ? (
        <>
          <Field label="Find issue" htmlFor="schedule-find-issue">
            <Input
              id="schedule-find-issue"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              maxLength={200}
            />
          </Field>
          <Field label="Issue" htmlFor="schedule-issue">
            <Select
              id="schedule-issue"
              value={issueId}
              disabled={subjectLoading || !profile}
              onChange={(event) => setIssueId(event.target.value)}
              required
            >
              <option value="">Choose an issue</option>
              {selectedIssue &&
                !issues.some((entry) => entry.id === selectedIssue.id) && (
                  <option value={selectedIssue.id}>
                    {selectedIssue.identifier} · {selectedIssue.title}
                  </option>
                )}
              {issues.map((issue) => (
                <option key={issue.id} value={issue.id}>
                  {issue.identifier} · {issue.title}
                </option>
              ))}
            </Select>
          </Field>
          {selectedIssue && (
            <Link
              className="text-sm underline"
              href={`/cloud/issues/${selectedIssue.id}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open {selectedIssue.identifier}
            </Link>
          )}
        </>
      ) : (
        <>
          <Field label="Purpose" htmlFor="schedule-purpose">
            <Select
              id="schedule-purpose"
              value={purpose}
              onChange={(event) =>
                setPurpose(event.target.value as typeof purpose)
              }
            >
              <option value="maintenance">Maintenance</option>
              <option value="research">Research</option>
              <option value="test">Testing</option>
            </Select>
          </Field>
          <Field label="Objective" htmlFor="schedule-objective">
            <Textarea
              id="schedule-objective"
              value={objective}
              onChange={(event) => setObjective(event.target.value)}
              maxLength={20000}
              required
              rows={3}
            />
          </Field>
          <Field label="Acceptance criteria" htmlFor="schedule-task-criteria">
            <Textarea
              id="schedule-task-criteria"
              value={criteria}
              onChange={(event) => setCriteria(event.target.value)}
              maxLength={20000}
              required
              rows={3}
            />
          </Field>
        </>
      )}
      {subjectError && (
        <div>
          <p role="alert">{subjectError}</p>
          <Button
            type="button"
            variant="outline"
            onClick={() => setReload(reload + 1)}
          >
            Reload task settings
          </Button>
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Maximum tasks" htmlFor="schedule-max-runs">
          <Input
            id="schedule-max-runs"
            type="number"
            min={1}
            max={1000}
            value={maxRuns}
            onChange={(event) => setMaxRuns(event.target.value)}
            required
          />
        </Field>
        <Field label="Total token allowance" htmlFor="schedule-max-tokens">
          <Input
            id="schedule-max-tokens"
            type="number"
            min={1}
            max={1000000000}
            value={maxTokens}
            onChange={(event) => setMaxTokens(event.target.value)}
            required
          />
        </Field>
      </div>
      <Field label="Authorization expires (UTC)" htmlFor="schedule-expiry">
        <Input
          id="schedule-expiry"
          type="datetime-local"
          value={expiry}
          onChange={(event) => setExpiry(event.target.value)}
          required
        />
      </Field>
    </div>
  );
}
