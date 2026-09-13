import type { ProductShell, ProductSnapshot } from "@machdoch/fleet-protocol";
import {
  BookOpenText,
  CalendarClock,
  FolderKanban,
  Layers3,
  ListChecks,
  Plus,
} from "lucide-react";
import { useState } from "react";
import { Tabs } from "radix-ui";
import { formatRelativeTime } from "./format";
import { InspectorContextPacks } from "./inspector-context-packs";
import { InspectorTasks } from "./inspector-tasks";
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
  pending,
  onCommand,
  onRefresh,
}: {
  snapshot: ProductSnapshot;
  shell: ProductShell;
  activeSessionId: string | undefined;
  pending: boolean;
  onCommand: ProductCommandHandler;
  onRefresh: () => Promise<void>;
}): React.ReactElement {
  const [tab, setTab] = useState<InspectorTab>("tasks");
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const navigate: ProductCommandHandler = async (command) => {
    if (pending) return false;
    setNavigationError(null);
    const accepted = await onCommand(command);
    if (!accepted) setNavigationError("Chat could not be opened. Try again.");
    return accepted;
  };
  return (
    <Tabs.Root
      asChild
      value={tab}
      onValueChange={(value) => setTab(value as InspectorTab)}
    >
      <aside className="m-product-inspector" aria-label="Activity">
        <Tabs.List
          className="m-product-inspector-tabs"
          aria-label="Activity views"
        >
          <Tab value="tasks" label="Tasks" icon={<ListChecks />} />
          <Tab value="scheduler" label="Scheduler" icon={<CalendarClock />} />
          <Tab value="context" label="Context" icon={<Layers3 />} />
          <Tab value="workspaces" label="Workspaces" icon={<FolderKanban />} />
          <Tab
            value="instructions"
            label="Instructions"
            icon={<BookOpenText />}
          />
        </Tabs.List>
        <Tabs.Content value={tab} className="m-product-inspector-content">
          {navigationError ? (
            <p role="alert" className="m-product-inline-error">
              {navigationError}
            </p>
          ) : null}
          {tab === "tasks" ? (
            <InspectorTasks
              snapshot={snapshot}
              pending={pending}
              onCommand={onCommand}
              onOpenChat={(sessionId) =>
                navigate({ kind: "activate-session", sessionId })
              }
            />
          ) : null}
          {tab === "scheduler" ? (
            <Scheduler
              shell={shell}
              pending={pending}
              onCommand={onCommand}
              onRefresh={onRefresh}
            />
          ) : null}
          {tab === "context" ? (
            <InspectorContextPacks
              shell={shell}
              activeSessionId={activeSessionId}
              pending={pending}
              onCommand={onCommand}
            />
          ) : null}
          {tab === "workspaces" ? (
            <Workspaces shell={shell} pending={pending} onCommand={navigate} />
          ) : null}
          {tab === "instructions" ? (
            <Instructions shell={shell} onRefresh={onRefresh} />
          ) : null}
        </Tabs.Content>
      </aside>
    </Tabs.Root>
  );
}

function Workspaces({
  shell,
  pending,
  onCommand,
}: {
  shell: ProductShell;
  pending: boolean;
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
            disabled={pending}
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

function Instructions({
  shell,
  onRefresh,
}: {
  shell: ProductShell;
  onRefresh: () => Promise<void>;
}): React.ReactElement {
  const instructions = shell.instructions;
  if (
    !instructions ||
    (!instructions.error &&
      !instructions.loading &&
      !instructions.profiles.length)
  ) {
    return <p className="m-product-empty-small">No instructions</p>;
  }
  return (
    <div className="m-product-card-list">
      {instructions.error ? (
        <InspectorError error={instructions.error} onRefresh={onRefresh} />
      ) : instructions.loading ? (
        <p role="status" className="m-product-empty-small">
          Loading instructions…
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
  value,
  icon,
  label,
}: {
  value: InspectorTab;
  icon: React.ReactNode;
  label: string;
}): React.ReactElement {
  return (
    <Tabs.Trigger
      type="button"
      value={value}
      onFocus={(event) =>
        event.currentTarget.scrollIntoView({
          block: "nearest",
          inline: "nearest",
        })
      }
    >
      {icon}
      <span>{label}</span>
    </Tabs.Trigger>
  );
}

function Scheduler({
  shell,
  pending,
  onCommand,
  onRefresh,
}: {
  shell: ProductShell;
  pending: boolean;
  onCommand: ProductCommandHandler;
  onRefresh: () => Promise<void>;
}): React.ReactElement {
  const scheduler = shell.scheduler;
  if (
    !scheduler ||
    (!scheduler.error &&
      !scheduler.loading &&
      !scheduler.jobs.length &&
      !scheduler.runs.length)
  ) {
    return <p className="m-product-empty-small">No scheduled work</p>;
  }
  const workspace = scheduler.workspaceRoot;
  return (
    <div className="m-product-card-list">
      {scheduler.error ? (
        <InspectorError error={scheduler.error} onRefresh={onRefresh} />
      ) : scheduler.loading ? (
        <p role="status" className="m-product-empty-small">
          Loading scheduled work…
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
                disabled={
                  pending || scheduler.loading || Boolean(scheduler.error)
                }
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
                disabled={
                  pending || scheduler.loading || Boolean(scheduler.error)
                }
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
              disabled={
                pending || scheduler.loading || Boolean(scheduler.error)
              }
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
              disabled={
                pending || scheduler.loading || Boolean(scheduler.error)
              }
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

function InspectorError({
  error,
  onRefresh,
}: {
  error: string;
  onRefresh: () => Promise<void>;
}): React.ReactElement {
  const [pending, setPending] = useState(false);
  return (
    <div role="alert" className="m-product-inspector-error">
      <p className="m-product-inline-error">{error}</p>
      <button
        type="button"
        className="m-product-secondary-button"
        disabled={pending}
        onClick={() => {
          setPending(true);
          void onRefresh().finally(() => setPending(false));
        }}
      >
        Retry
      </button>
    </div>
  );
}
