"use client";

import { useEffect, useState } from "react";
import type { CloudProviderSettings } from "@machdoch/fleet-protocol/cloud-providers";
import {
  defaultAgentModel,
  type AgentModelPreference,
} from "@/lib/agent-personalization";
import { cloudRequest } from "./api-client";

export interface AgentModelChoice {
  value: string;
  providerId: string;
  model: string;
  label: string;
}

export function agentModelValue(providerId: string, model: string): string {
  return `${providerId}::${model}`;
}

export function parseAgentModelValue(
  value: string,
): { providerId: string; model: string } | null {
  const [providerId, ...rest] = value.split("::");
  const model = rest.join("::");
  return providerId && model ? { providerId, model } : null;
}

export async function fetchAgentModelPreference(
  signal?: AbortSignal,
): Promise<AgentModelPreference | null> {
  const settings = await cloudRequest<{
    personal: { "agent.model"?: AgentModelPreference | null };
  }>("settings", { signal });
  return settings.personal["agent.model"] ?? null;
}

export function useAgentModels(enabled: boolean): {
  choices: AgentModelChoice[];
  preferred: string;
  loaded: boolean;
  error: string;
} {
  const [state, setState] = useState({
    choices: [] as AgentModelChoice[],
    preferred: "",
    loaded: false,
    error: "",
  });
  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    Promise.all([
      cloudRequest<CloudProviderSettings>("ai-providers", {
        signal: abort.signal,
      }),
      fetchAgentModelPreference(abort.signal),
    ])
      .then(([settings, preference]) => {
        const providers = settings.providers.filter(
          (provider) => provider.enabled,
        );
        const preferred = defaultAgentModel(providers, preference);
        const choices = providers.flatMap((provider) =>
          provider.models.map((model) => ({
            value: agentModelValue(provider.id, model),
            providerId: provider.id,
            model,
            label: `${provider.name} · ${model}`,
          })),
        );
        setState({
          choices,
          preferred: preferred
            ? agentModelValue(preferred.providerId, preferred.model)
            : "",
          loaded: true,
          error: "",
        });
      })
      .catch((reason: Error) => {
        if (!abort.signal.aborted)
          setState((current) => ({
            ...current,
            loaded: true,
            error: reason.message,
          }));
      });
    return () => abort.abort();
  }, [enabled]);
  return state;
}
