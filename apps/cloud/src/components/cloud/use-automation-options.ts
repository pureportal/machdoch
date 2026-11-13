"use client";

import { holderCan } from "@/lib/cloud-permissions";
import { useEffect, useState } from "react";
import type { ExecutionProfile } from "@machdoch/fleet-protocol/cloud-execution";
import type { CloudProviderSettings } from "@machdoch/fleet-protocol/cloud-providers";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import type { GitRepositoryOption } from "@/lib/cloud-git-contract";
import type { CloudLabel } from "@/lib/cloud-label-contract";
import type { CloudProduct } from "@/lib/cloud-release-contract";
import { api } from "@machdoch/product-ui/fleet-api";
import { canOpenSessions } from "@/lib/fleet-session-routing";
import type { FleetStatus } from "@/lib/fleet-status";
import { cloudRequest } from "./api-client";

export interface AgentModelOption {
  providerId: string;
  model: string;
  label: string;
}

export interface ClientTarget {
  instanceId: string;
  workspace: string;
  label: string;
}

export interface AutomationOptions {
  clients: ClientTarget[];
  labels: CloudLabel[];
  models: AgentModelOption[];
  profiles: ExecutionProfile[];
  products: CloudProduct[];
  repositories: GitRepositoryOption[];
  loaded: boolean;
  error: string;
}

export function useAutomationOptions(
  workspace: CloudWorkspace,
): AutomationOptions {
  const [options, setOptions] = useState<AutomationOptions>({
    clients: [],
    labels: [],
    models: [],
    profiles: [],
    products: [],
    repositories: [],
    loaded: false,
    error: "",
  });
  const teamIds = workspace.teams.map((team) => team.id).join(",");
  const administrator = holderCan(workspace.actor, "clients.manage");
  const releases = holderCan(workspace.actor, "releases.view");
  const git = workspace.gitProviders.length > 0;
  useEffect(() => {
    const abort = new AbortController();
    const signal = abort.signal;
    Promise.all([
      Promise.all(
        teamIds
          .split(",")
          .filter(Boolean)
          .map((teamId) =>
            cloudRequest<{ labels: CloudLabel[] }>(`teams/${teamId}/labels`, {
              signal,
            }).then((result) => result.labels),
          ),
      ),
      cloudRequest<CloudProviderSettings>("ai-providers", { signal }),
      cloudRequest<{ profiles: ExecutionProfile[] }>("execution-profiles", {
        signal,
      }),
      releases
        ? cloudRequest<CloudProduct[]>("products", { signal })
        : Promise.resolve([]),
      administrator
        ? api<FleetStatus>("/api/fleet/status", { signal })
        : Promise.resolve(null),
      git
        ? cloudRequest<GitRepositoryOption[]>("git/repositories", { signal })
        : Promise.resolve([]),
    ])
      .then(([labels, providers, profiles, products, fleet, repositories]) =>
        setOptions({
          clients: (fleet?.devices ?? [])
            .filter(canOpenSessions)
            .flatMap((device) =>
              device.workspaces.map((entry) => ({
                instanceId: device.instanceId,
                workspace: entry.root,
                label: `${device.displayName} · ${entry.label}`,
              })),
            ),
          labels: labels.flat().filter((label) => !label.archived),
          models: providers.providers
            .filter((provider) => provider.enabled)
            .flatMap((provider) =>
              provider.models.map((model) => ({
                providerId: provider.id,
                model,
                label: `${provider.name} · ${model}`,
              })),
            ),
          profiles: profiles.profiles.filter((profile) => profile.enabled),
          products,
          repositories,
          loaded: true,
          error: "",
        }),
      )
      .catch((reason: Error) => {
        if (signal.aborted) return;
        setOptions((current) => ({
          ...current,
          loaded: true,
          error: reason.message,
        }));
      });
    return () => abort.abort();
  }, [teamIds, administrator, releases, git]);
  return options;
}
