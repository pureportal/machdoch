import type { ProductShell, ProductSnapshot } from "@machdoch/fleet-protocol";
import {
  BookOpenText,
  CalendarClock,
  FolderKanban,
  Layers3,
  ListChecks,
  Plus,
  Square,
} from "lucide-react";
import { useState } from "react";
import { formatDuration, formatRelativeTime } from "./format";
import type { ProductCommandHandler } from "./product-runtime";

type InspectorTab =
  | "tasks"
  | "scheduler"
  | "context"
  | "workspaces"
  | "instructions";

export function Inspector({
  snapshot,
  shell,
  activeSessionId,
  onCommand,
}: {
  snapshot: ProductSnapshot;
  shell: ProductShell;
  activeSessionId: string | undefined;
  onCommand: ProductCommandHandler;
}): React.ReactElement {
  const [tab, setTab] = useState<InspectorTab>("tasks");
  return (
    <aside className="m-product-inspector" aria-label="Activity">
      <div className="m-product-inspector-tabs" role="tablist">
        <Tab
          active={tab === "tasks"}
          label="Tasks"
          icon={<ListChecks />}
          onClick={() => setTab("tasks")}
        />
        <Tab
          active={tab === "scheduler"}
          label="Scheduler"
          icon={<CalendarClock />}
          onClick={() => setTab("scheduler")}
        />
        <Tab
          active={tab === "context"}
          label="Context"
          icon={<Layers3 />}
          onClick={() => setTab("context")}
        />
        <Tab
          active={tab === "workspaces"}
          label="Workspaces"
          icon={<FolderKanban />}
          onClick={() => setTab("workspaces")}
        />
        <Tab
          active={tab === "instructions"}
          label="Instructions"
          icon={<BookOpenText />}
          onClick={() => setTab("instructions")}
        />
      </div>
      <div className="m-product-inspector-content">
        {tab === "tasks" ? (
          <Tasks snapshot={snapshot} onCommand={onCommand} />
        ) : null}
        {tab === "scheduler" ? (
          <Scheduler shell={shell} onCommand={onCommand} />
        ) : null}
        {tab === "context" ? (
          <ContextPacks
            shell={shell}
            activeSessionId={activeSessionId}
            onCommand={onCommand}
          />
        ) : null}
        {tab === "workspaces" ? (
          <Workspaces shell={shell} onCommand={onCommand} />
        ) : null}
        {tab === "instructions" ? <Instructions shell={shell} /> : null}
      </div>
    </aside>
  );
}

function Workspaces({
  shell,
  onCommand,
}: {
  shell: ProductShell;
  onCommand: ProductCommandHandler;
}): React.ReactElement {
  if (!shell.workspaces.length) {
    return <p className="m-product-empty-small">No workspaces</p>;
  }
  return (
    <div className="m-product-card-list">
      {shell.workspaces.map((workspace) => (
        <article key={workspace.root} className="m-product-card">
          <div className="m-product-card-heading">
            <strong>{workspace.label}</strong>
            <span>{workspace.sessionCount}</span>
          </div>
          <p title={workspace.root}>{workspace.root}</p>
          <button
            type="button"
            onClick={() =>
              void onCommand({
                kind: "create-session",
                workspace: workspace.root,
              })
            }
          >
            <Plus aria-hidden="true" />
            New chat
          </button>
        </article>
      ))}
    </div>
  );
}

function Instructions({ shell }: { shell: ProductShell }): React.ReactElement {
  const instructions = shell.instructions;
  if (
    !instructions ||
    (!instructions.loading && !instructions.profiles.length)
  ) {
    return <p className="m-product-empty-small">No instructions</p>;
  }
  return (
    <div className="m-product-card-list">
      {instructions.error ? (
        <p role="alert" className="m-product-inline-error">
          {instructions.error}
        </p>
      ) : null}
      {instructions.profiles.map((profile) => (
        <article key={profile.id} className="m-product-card">
          <div className="m-product-card-heading">
            <strong>{profile.name}</strong>
            <span>
              {profile.enabled ? (profile.global ? "Global" : "Active") : "Off"}
            </span>
          </div>
          {profile.description || profile.body ? (
            <p>{profile.description ?? profile.body}</p>
          ) : null}
        </article>
      ))}
    </div>
  );
}

function Tab({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-active={active}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function Tasks({
  snapshot,
  onCommand,
}: {
  snapshot: ProductSnapshot;
  onCommand: ProductCommandHandler;
}): React.ReactElement {
  if (snapshot.sessions.length === 0) {
    return <p className="m-product-empty-small">No tasks</p>;
  }
  return (
    <div className="m-product-card-list">
      {snapshot.sessions.map((task) => (
        <article key={task.taskId} className="m-product-card">
          <div className="m-product-card-heading">
            <strong>{task.task}</strong>
            <span data-state={task.state}>{task.state}</span>
          </div>
          <p>{task.message}</p>
          <div className="m-product-card-meta">
            <span>{task.mode}</span>
            <span>{formatDuration(task.startedAt, task.updatedAt)}</span>
          </div>
          {task.cancellable ? (
            <button
              type="button"
              className="m-product-secondary-button"
              onClick={() =>
                void onCommand({ kind: "cancel", taskId: task.taskId })
              }
            >
              <Square aria-hidden="true" />
              Cancel
            </button>
          ) : null}
        </article>
      ))}
    </div>
  );
}

function Scheduler({
  shell,
  onCommand,
}: {
  shell: ProductShell;
  onCommand: ProductCommandHandler;
}): React.ReactElement {
  const scheduler = shell.scheduler;
  if (!scheduler || (!scheduler.jobs.length && !scheduler.runs.length)) {
    return <p className="m-product-empty-small">No scheduled work</p>;
  }
  const workspace = scheduler.workspaceRoot;
  return (
    <div className="m-product-card-list">
      {scheduler.error ? (
        <p role="alert" className="m-product-inline-error">
          {scheduler.error}
        </p>
      ) : null}
      {scheduler.jobs.map((job) => (
        <article key={job.id} className="m-product-card">
          <div className="m-product-card-heading">
            <strong>{job.name}</strong>
            <span>{job.status}</span>
          </div>
          <p>{job.promptPreview}</p>
          <div className="m-product-card-meta">
            <span>{job.schedule}</span>
          </div>
          {workspace ? (
            <div className="m-product-card-actions">
              <button
                type="button"
                onClick={() =>
                  void onCommand({
                    kind: "scheduler-trigger",
                    workspace,
                    jobId: job.id,
                  })
                }
              >
                Run
              </button>
              <button
                type="button"
                onClick={() =>
                  void onCommand({
                    kind:
                      job.status === "paused"
                        ? "scheduler-resume"
                        : "scheduler-pause",
                    workspace,
                    jobId: job.id,
                  })
                }
              >
                {job.status === "paused" ? "Resume" : "Pause"}
              </button>
            </div>
          ) : null}
        </article>
      ))}
      {scheduler.runs.slice(0, 12).map((run) => (
        <article key={run.id} className="m-product-card m-product-run-card">
          <div className="m-product-card-heading">
            <strong>{run.status}</strong>
            <span>{formatRelativeTime(run.updatedAt)}</span>
          </div>
          {run.summary || run.error ? <p>{run.summary ?? run.error}</p> : null}
          {workspace &&
          ["failed", "cancelled", "timed_out"].includes(run.status) ? (
            <button
              type="button"
              onClick={() =>
                void onCommand({
                  kind: "scheduler-retry-run",
                  workspace,
                  runId: run.id,
                })
              }
            >
              Retry
            </button>
          ) : null}
          {workspace && ["queued", "running"].includes(run.status) ? (
            <button
              type="button"
              onClick={() =>
                void onCommand({
                  kind: "scheduler-cancel-run",
                  workspace,
                  runId: run.id,
                })
              }
            >
              Cancel
            </button>
          ) : null}
        </article>
      ))}
    </div>
  );
}

function ContextPacks({
  shell,
  activeSessionId,
  onCommand,
}: {
  shell: ProductShell;
  activeSessionId: string | undefined;
  onCommand: ProductCommandHandler;
}): React.ReactElement {
  if (shell.contextPacks.length === 0) {
    return <p className="m-product-empty-small">No context packs</p>;
  }
  return (
    <div className="m-product-card-list">
      {shell.contextPacks.map((pack) => (
        <article key={pack.id} className="m-product-card">
          <div className="m-product-card-heading">
            <strong>{pack.name}</strong>
            {pack.scopeLabel ? <span>{pack.scopeLabel}</span> : null}
          </div>
          {pack.instructionsPreview || pack.promptPreview ? (
            <p>{pack.instructionsPreview || pack.promptPreview}</p>
          ) : null}
          <div className="m-product-card-actions">
            {activeSessionId ? (
              <button
                type="button"
                disabled={pack.matched}
                onClick={() =>
                  void onCommand({
                    kind: "apply-context-pack",
                    sessionId: activeSessionId,
                    contextPackId: pack.id,
                  })
                }
              >
                {pack.matched ? "Applied" : "Apply"}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                if (window.confirm(`Delete “${pack.name}”?`)) {
                  void onCommand({
                    kind: "delete-context-pack",
                    contextPackId: pack.id,
                  });
                }
              }}
            >
              Delete
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}
