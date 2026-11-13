"use client";

import { useEffect, useState } from "react";
import type { CloudProviderSettings } from "@machdoch/fleet-protocol/cloud-providers";
import { cloudRequest } from "./api-client";

export interface AgentModelChoice {
  value: string;
  providerId: string;
  model: string;
  label: string;
}

const storageKey = "machdoch.cloud.agent.model";

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

export function storedAgentModel(): string | null {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(storageKey) ?? "null",
    );
    return value &&
      typeof value === "object" &&
      "providerId" in value &&
      "model" in value &&
      typeof value.providerId === "string" &&
      typeof value.model === "string"
      ? agentModelValue(value.providerId, value.model)
      : null;
  } catch {
    return null;
  }
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
    cloudRequest<CloudProviderSettings>("ai-providers", {
      signal: abort.signal,
    })
      .then((settings) => {
        const choices = settings.providers
          .filter((provider) => provider.enabled)
          .flatMap((provider) =>
            provider.models.map((model) => ({
              value: agentModelValue(provider.id, model),
              providerId: provider.id,
              model,
              label: `${provider.name} · ${model}`,
            })),
          );
        const stored = storedAgentModel();
        setState({
          choices,
          preferred:
            choices.find((choice) => choice.value === stored)?.value ??
            choices[0]?.value ??
            "",
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
