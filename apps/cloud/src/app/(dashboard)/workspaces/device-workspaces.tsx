"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ChevronRight,
  ExternalLink,
  Folder,
  LoaderCircle,
  Monitor,
  Plus,
  Square,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { canOpenSessions } from "@/lib/fleet-session-routing";
import { formatAge, formatTime } from "@/lib/format";
import { versionWarning } from "@/lib/product-version";
import { cn } from "@/lib/utils";
import { DeviceResources } from "./device-resources";
import {
  displayPath,
  sessionTone,
  sessionWorkspace,
  workspaceName,
  workspaceSessions,
  type DeviceOverview,
  type SessionTone,
} from "./workspace-overview";

const visibleSessions = 8;

const toneClass: Record<SessionTone, string> = {
  running: "bg-primary motion-safe:animate-pulse",
  success: "bg-emerald-500",
  failed: "bg-destructive",
  blocked: "bg-amber-500",
  idle: "bg-muted-foreground/40",
};

function SectionHeading({
  id,
  title,
  count,
}: {
  id: string;
  title: string;
  count: number;
}): React.ReactElement {
  return (
    <h3
      id={id}
      className="flex items-center gap-2 px-4 pb-2 pt-4 text-xs font-medium text-muted-foreground sm:px-5"
    >
      {title}
      <span className="tabular-nums">{count}</span>
    </h3>
  );
}

export function DeviceWorkspaces({
  overview,
  managerVersion,
  filtered,
  startingWorkspace,
  startDisabled,
  stoppingTasks,
  onStartSession,
  onStopTask,
}: {
  overview: DeviceOverview;
  managerVersion: string | undefined;
  filtered: boolean;
  startingWorkspace: string | null;
  startDisabled: boolean;
  stoppingTasks: ReadonlySet<string>;
  onStartSession: (workspace: string) => void;
  onStopTask: (taskId: string) => void;
}): React.ReactElement {
  const { device, workspaces, sessions, runningSessions } = overview;
  const [showAll, setShowAll] = useState(false);
  const warning = versionWarning(device.versionStatus, managerVersion);
  const canStart = canOpenSessions(device) && !startDisabled;
  const shownSessions =
    showAll || filtered ? sessions : sessions.slice(0, visibleSessions);
  const deviceHref = `/instances/${encodeURIComponent(device.instanceId)}`;
  const headingId = `device-${device.instanceId}`;

  return (
    <Card role="region" className="overflow-hidden" aria-labelledby={headingId}>
      <header className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b px-4 py-4 sm:px-5">
        <span
          className={cn(
            "hidden size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground sm:grid",
            device.online && "bg-primary/10 text-primary",
          )}
        >
          <Monitor className="size-4" aria-hidden="true" />
        </span>
        <div className="grid min-w-0 flex-1 gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <h2
              id={headingId}
              className="truncate text-sm font-semibold leading-tight"
            >
              {device.displayName}
            </h2>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  device.online ? "bg-emerald-500" : "bg-muted-foreground/50",
                )}
                aria-hidden="true"
              />
              {device.online ? "Online" : "Offline"}
              <span aria-hidden="true">·</span>v{device.productVersion}
            </span>
            {runningSessions > 0 ? (
              <span className="text-xs text-primary">
                {runningSessions} running
              </span>
            ) : null}
          </div>
          {device.telemetry ? (
            <DeviceResources telemetry={device.telemetry} />
          ) : null}
        </div>
        {device.online ? (
          <Button asChild size="sm" variant="outline">
            <Link href={deviceHref}>
              <ExternalLink aria-hidden="true" />
              Open
            </Link>
          </Button>
        ) : null}
      </header>
      {warning || device.error ? (
        <div className="grid gap-1 border-b bg-amber-500/5 px-4 py-2.5 text-xs text-amber-700 sm:px-5 dark:text-amber-300">
          {[warning, device.error].filter(Boolean).map((message) => (
            <p key={message} className="flex items-start gap-2">
              <TriangleAlert
                className="mt-px size-3.5 shrink-0"
                aria-hidden="true"
              />
              <span className="[overflow-wrap:anywhere]">{message}</span>
            </p>
          ))}
        </div>
      ) : null}
      {workspaces.length || sessions.length ? (
        <div className="grid xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] xl:divide-x">
          <section aria-labelledby={`${headingId}-workspaces`} className="pb-2">
            <SectionHeading
              id={`${headingId}-workspaces`}
              title="Workspaces"
              count={workspaces.length}
            />
            {workspaces.length ? (
              <ul>
                {workspaces.map((workspace) => {
                  const name = workspaceName(workspace);
                  const path = displayPath(workspace.root);
                  const running = workspaceSessions(workspace, sessions).filter(
                    (session) => sessionTone(session.status) === "running",
                  ).length;
                  const starting = startingWorkspace === workspace.root;
                  return (
                    <li
                      key={workspace.root}
                      className="group flex min-h-12 items-center gap-3 px-4 py-1.5 transition-colors hover:bg-muted/40 sm:px-5"
                    >
                      <Folder
                        className="size-4 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <div className="grid min-w-0 flex-1">
                        <span className="truncate text-sm font-medium">
                          {name}
                        </span>
                        <span
                          className="truncate font-mono text-[11px] text-muted-foreground"
                          title={path}
                        >
                          {path}
                        </span>
                      </div>
                      {running > 0 ? (
                        <span
                          className="size-1.5 shrink-0 rounded-full bg-primary motion-safe:animate-pulse"
                          aria-label={`${running} running`}
                        />
                      ) : null}
                      <span
                        className="w-8 shrink-0 text-right text-xs tabular-nums text-muted-foreground"
                        title={`${workspace.sessionCount} sessions`}
                      >
                        {workspace.sessionCount || null}
                      </span>
                      {device.online ? (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-8 shrink-0 sm:opacity-0 sm:focus-visible:opacity-100 sm:group-hover:opacity-100 data-[starting=true]:opacity-100"
                          data-starting={starting}
                          disabled={!canStart}
                          aria-label={`New session in ${name}`}
                          title="New session"
                          onClick={() => onStartSession(workspace.root)}
                        >
                          {starting ? (
                            <LoaderCircle className="motion-safe:animate-spin" />
                          ) : (
                            <Plus />
                          )}
                        </Button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="px-4 pb-3 text-sm text-muted-foreground sm:px-5">
                No matching workspaces
              </p>
            )}
          </section>
          <section
            aria-labelledby={`${headingId}-sessions`}
            className="border-t pb-2 xl:border-t-0"
          >
            <SectionHeading
              id={`${headingId}-sessions`}
              title="Sessions"
              count={sessions.length}
            />
            {sessions.length ? (
              <ul>
                {shownSessions.map((session) => {
                  const tone = sessionTone(session.status);
                  const workspace = sessionWorkspace(
                    session,
                    device.workspaces,
                  );
                  const task = device.tasks.find(
                    (entry) =>
                      entry.taskId === session.runningTaskId &&
                      entry.cancellable,
                  );
                  return (
                    <li
                      key={session.id}
                      className="flex min-h-12 items-center gap-3 px-4 py-1.5 transition-colors hover:bg-muted/40 sm:px-5"
                    >
                      <span
                        className={cn(
                          "size-2 shrink-0 rounded-full",
                          toneClass[tone],
                        )}
                        role="img"
                        aria-label={session.status}
                        title={session.status}
                      />
                      <div className="grid min-w-0 flex-1">
                        <Link
                          href={`${deviceHref}?session=${encodeURIComponent(session.id)}`}
                          className="truncate text-sm font-medium hover:text-primary"
                        >
                          {session.title}
                        </Link>
                        <span className="truncate text-xs text-muted-foreground">
                          {[
                            workspace ? workspaceName(workspace) : null,
                            session.provider,
                            session.model,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </div>
                      {task ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="min-h-7 shrink-0 px-2.5"
                          aria-label={`Stop ${session.title}`}
                          disabled={stoppingTasks.has(task.taskId)}
                          onClick={() => onStopTask(task.taskId)}
                        >
                          <Square className="size-3" aria-hidden="true" />
                          <span className="hidden sm:inline">Stop</span>
                        </Button>
                      ) : null}
                      <time
                        dateTime={new Date(session.updatedAt).toISOString()}
                        title={formatTime(session.updatedAt / 1000)}
                        className="w-16 shrink-0 whitespace-nowrap text-right text-xs tabular-nums text-muted-foreground"
                      >
                        {formatAge(new Date(session.updatedAt).toISOString())}
                      </time>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="px-4 pb-3 text-sm text-muted-foreground sm:px-5">
                No sessions
              </p>
            )}
            {sessions.length > shownSessions.length || showAll ? (
              <button
                type="button"
                className="mx-4 mt-1 rounded text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:mx-5"
                onClick={() => setShowAll((current) => !current)}
              >
                {showAll ? "Show fewer" : `Show all ${sessions.length}`}
              </button>
            ) : null}
          </section>
        </div>
      ) : (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground sm:px-5">
          No workspaces
        </p>
      )}
      {device.failures.length ? (
        <details className="group border-t px-4 py-3 text-xs sm:px-5">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 font-medium text-destructive">
            <ChevronRight
              className="size-3.5 transition-transform group-open:rotate-90"
              aria-hidden="true"
            />
            {device.failures.length}{" "}
            {device.failures.length === 1 ? "error" : "errors"}
          </summary>
          <ul className="mt-2 grid gap-1.5">
            {device.failures.map((failure) => (
              <li
                key={failure.id}
                className="text-destructive [overflow-wrap:anywhere]"
              >
                {failure.message}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Card>
  );
}
