import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  ModelProvider,
  ToolName,
  WorkspaceCompatibilityConfig,
} from "../../core/types.js";

export interface RuntimeProviderAvailability {
  provider: Exclude<ModelProvider, "unconfigured">;
  configured: boolean;
}

export interface RuntimeProfileSummary {
  name: string;
  description?: string;
}

export interface RuntimeSnapshot {
  workspaceRoot: string;
  workspaceConfigPath?: string;
  activeProfile?: string;
  availableProfiles: RuntimeProfileSummary[];
  mode: "safe" | "ask" | "auto";
  enabledTools: ToolName[];
  provider: ModelProvider;
  model: string;
  offline: boolean;
  compatibility: WorkspaceCompatibilityConfig;
  providerAvailability: RuntimeProviderAvailability[];
}

export const loadWorkspaceRuntimeSnapshot = async (
  workspaceRoot: string,
): Promise<RuntimeSnapshot | null> => {
  if (!isTauri()) {
    return null;
  }

  try {
    return await invoke<RuntimeSnapshot>("get_runtime_snapshot", {
      workspaceRoot,
    });
  } catch (error) {
    console.error("Failed to load runtime snapshot", error);
    return null;
  }
};

export const loadGlobalProviderAvailability = async (): Promise<
  RuntimeProviderAvailability[]
> => {
  if (!isTauri()) {
    return [];
  }
  try {
    return await invoke<RuntimeProviderAvailability[]>(
      "get_global_provider_availability",
    );
  } catch (error) {
    console.error("Failed to load global provider availability", error);
    return [];
  }
};

export const saveUserProviderApiKey = async (
  provider: RuntimeProviderAvailability["provider"],
  apiKey: string,
): Promise<RuntimeProviderAvailability[]> => {
  if (!isTauri()) {
    return [];
  }

  return invoke<RuntimeProviderAvailability[]>("set_user_api_key", {
    provider,
    apiKey,
  });
};
