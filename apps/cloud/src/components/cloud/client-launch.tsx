"use client";

import { Command } from "cmdk";
import {
  FolderGit2,
  GitBranchPlus,
  LoaderCircle,
  Play,
  Target,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { Popover } from "radix-ui";
import { useEffect, useState, type ReactNode } from "react";
import { workspaceRequestSchema } from "@machdoch/fleet-protocol";
import type {
  WorkspaceGitOverview,
  WorkspaceGitRepositoryDiscovery,
} from "@machdoch/fleet-protocol/workspace-contract";
import { createFleetOperationTransport } from "@machdoch/product-ui";
import { api, jsonBody } from "@machdoch/product-ui/fleet-api";
import {
  canOpenSessions,
  fleetSessionRouteSchema,
  type FleetSessionTarget,
} from "@/lib/fleet-session-routing";
import type { FleetDeviceStatus, FleetStatus } from "@/lib/fleet-status";
import { createInstanceRuntime } from "@/lib/instance-runtime";
import {
  issueWorktreeRepository,
  matchingWorkspaceRoot,
  worktreePathForBranch,
} from "@/lib/issue-worktree";
import { Button } from "@/components/ui/button";
import { useToast } from "./toast";

export interface ClientSessionDraft {
  title: string;
  prompt: string;
}

async function openSession(
  target: FleetSessionTarget,
  draft: ClientSessionDraft,
  mode: { start: boolean; goal: boolean },
): Promise<string> {
  const route = fleetSessionRouteSchema.parse(
    await api("/api/fleet/sessions", {
      method: "POST",
      body: jsonBody({ commandId: crypto.randomUUID(), targets: [target] }),
    }),
  );
  const client = createInstanceRuntime(route.instanceId);
  await client.execute({
    kind: "rename-session",
    sessionId: route.sessionId,
    title: draft.title,
  });
  await client.execute(
    mode.start
      ? {
          kind: "submit-message",
          sessionId: route.sessionId,
          prompt: draft.prompt,
          promptEnhancementMode: "off",
          interviewEnabled: false,
          ...(mode.goal ? { goalObjective: draft.prompt.slice(0, 4_000) } : {}),
        }
      : {
          kind: "update-draft",
          sessionId: route.sessionId,
          prompt: draft.prompt,
        },
  );
  return `/instances/${encodeURIComponent(route.instanceId)}?session=${encodeURIComponent(route.sessionId)}`;
}

async function prepareWorktree(
  branchName: string,
  instanceId: string,
  workspaceRoot: string,
): Promise<string> {
  const workspace = createFleetOperationTransport((request) =>
    api(`/api/instances/${encodeURIComponent(instanceId)}/product/workspace`, {
      method: "POST",
      body: jsonBody(workspaceRequestSchema.parse(request)),
    }),
  );
  const request = {
    workspaceRoot,
    repositoryRoot: issueWorktreeRepository(
      await workspace.invoke<WorkspaceGitRepositoryDiscovery>(
        "discover_workspace_git_repositories",
        { workspaceRoot },
      ),
    ),
  };
  const existing = worktreePathForBranch(
    await workspace.invoke<WorkspaceGitOverview>("get_workspace_git_overview", {
      request,
    }),
    branchName,
  );
  if (existing) return existing;
  const created = worktreePathForBranch(
    await workspace.invoke<WorkspaceGitOverview>("run_workspace_git_action", {
      request: { ...request, action: "add-worktree", branchName },
    }),
    branchName,
  );
  if (!created) throw new Error("The worktree could not be created.");
  return created;
}

async function registeredWorkspace(
  instanceId: string,
  path: string,
): Promise<string> {
  const deadline = Date.now() + 20_000;
  let requested = false;
  for (;;) {
    const status = await api<FleetStatus>("/api/fleet/status");
    const device = status.devices.find(
      (entry) => entry.instanceId === instanceId,
    );
    const root = device && matchingWorkspaceRoot(device.workspaces, path);
    if (root) return root;
    if (!requested) {
      await createInstanceRuntime(instanceId).execute({
        kind: "add-workspace",
        workspace: path,
      });
      requested = true;
    } else if (Date.now() > deadline) {
      throw new Error(
        "The device did not open the worktree. Open it on the device and try again.",
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
  }
}

export function ClientLaunch({
  label,
  icon,
  variant = "ghost",
  branch,
  worktreeByDefault = false,
  startByDefault = false,
  draft,
}: {
  label: string;
  icon: ReactNode;
  variant?: "ghost" | "outline";
  branch: string;
  worktreeByDefault?: boolean;
  startByDefault?: boolean;
  draft: () => ClientSessionDraft;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState<FleetDeviceStatus[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [worktree, setWorktree] = useState(worktreeByDefault);
  const [startNow, setStartNow] = useState(startByDefault);
  const [goal, setGoal] = useState(false);
  const worktreeAvailable = devices?.some((device) => device.workspaceTools);
  const listed =
    worktree && devices
      ? devices.filter((device) => device.workspaceTools)
      : devices;
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    setFailure(null);
    api<FleetStatus>("/api/fleet/status", { signal: abort.signal })
      .then((status) => setDevices(status.devices.filter(canOpenSessions)))
      .catch((reason: Error) => {
        if (!abort.signal.aborted) setFailure(reason.message);
      });
    return () => abort.abort();
  }, [open]);
  async function start(target: FleetSessionTarget) {
    setOpen(false);
    setStarting(true);
    try {
      const workspace = worktree
        ? await registeredWorkspace(
            target.instanceId,
            await prepareWorktree(branch, target.instanceId, target.workspace),
          )
        : target.workspace;
      router.push(
        await openSession({ ...target, workspace }, draft(), {
          start: startNow,
          goal: startNow && goal,
        }),
      );
    } catch (reason) {
      toast((reason as Error).message, "error");
      setStarting(false);
    }
  }
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button variant={variant} size="sm" disabled={starting}>
          {starting ? <LoaderCircle className="animate-spin" /> : icon}
          {label}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="cloud-menu"
          align="end"
          sideOffset={4}
          collisionPadding={12}
        >
          {worktreeAvailable ? (
            <label className="cloud-menu-check">
              <input
                type="checkbox"
                checked={worktree}
                onChange={(event) => setWorktree(event.target.checked)}
              />
              <GitBranchPlus size={14} aria-hidden="true" />
              <span>New worktree</span>
              <code title={branch}>{branch}</code>
            </label>
          ) : null}
          <label className="cloud-menu-check">
            <input
              type="checkbox"
              checked={startNow}
              onChange={(event) => setStartNow(event.target.checked)}
            />
            <Play size={14} aria-hidden="true" />
            <span>Start now</span>
          </label>
          {startNow && (
            <label className="cloud-menu-check">
              <input
                type="checkbox"
                checked={goal}
                onChange={(event) => setGoal(event.target.checked)}
              />
              <Target size={14} aria-hidden="true" />
              <span>Goal mode</span>
            </label>
          )}
          <Command label={label} loop>
            <Command.List className="cloud-menu-list">
              {failure ? (
                <p className="cloud-menu-empty" role="alert">
                  {failure}
                </p>
              ) : listed === null ? (
                <Command.Loading>
                  <p className="cloud-menu-empty">Loading…</p>
                </Command.Loading>
              ) : listed.length === 0 ? (
                <p className="cloud-menu-empty">No client is online.</p>
              ) : (
                listed.map((device) => (
                  <Command.Group
                    key={device.instanceId}
                    heading={device.displayName}
                  >
                    {device.workspaces.map((workspace) => (
                      <Command.Item
                        key={workspace.root}
                        value={`${device.instanceId} ${workspace.root}`}
                        onSelect={() =>
                          void start({
                            instanceId: device.instanceId,
                            workspace: workspace.root,
                          })
                        }
                      >
                        <FolderGit2 size={14} aria-hidden="true" />
                        <span
                          className="cloud-menu-label"
                          title={workspace.root}
                        >
                          {workspace.label}
                        </span>
                      </Command.Item>
                    ))}
                  </Command.Group>
                ))
              )}
            </Command.List>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
