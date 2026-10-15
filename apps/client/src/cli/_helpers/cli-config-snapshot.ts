import {
  loadRuntimeConfig,
  loadWorkspaceConfigFile,
} from "../../core/config.js";
import { loadFleetConnectionStatus } from "../../core/fleet-connection.js";
import {
  loadChatDefaults,
  type ChatDefaults,
} from "../../core/chat-defaults.js";
import {
  loadUserAgentCliPaths,
  loadUserConfigFile,
  loadUserMemorySettings,
  loadUserReviewModelSettings,
  loadUserWorkspaceRunSettings,
  loadRuntimeEnvironment,
} from "../../core/env.js";
import type {
  UserConfigFile,
  WorkspaceConfigFile,
} from "../../core/runtime-contract.generated.js";

export interface ConfigSnapshot {
  runtime: Awaited<ReturnType<typeof loadRuntimeConfig>>;
  workspaceConfig: WorkspaceConfigFile;
  userConfig: UserConfigFile;
  env: Record<string, string>;
  memory: Awaited<ReturnType<typeof loadUserMemorySettings>>;
  reviewModel: Awaited<ReturnType<typeof loadUserReviewModelSettings>>;
  agentCliPaths: Awaited<ReturnType<typeof loadUserAgentCliPaths>>;
  workspaceRun: Awaited<ReturnType<typeof loadUserWorkspaceRunSettings>>;
  fleet: Awaited<ReturnType<typeof loadFleetConnectionStatus>>;
  chatDefaults: ChatDefaults;
}

export const loadConfigSnapshot = async (
  workspaceRoot: string,
): Promise<ConfigSnapshot> => {
  const [
    runtime,
    workspace,
    user,
    env,
    memory,
    reviewModel,
    agentCliPaths,
    workspaceRun,
    fleet,
    chatDefaults,
  ] = await Promise.all([
    loadRuntimeConfig(workspaceRoot),
    loadWorkspaceConfigFile(workspaceRoot),
    loadUserConfigFile(),
    loadRuntimeEnvironment(),
    loadUserMemorySettings(),
    loadUserReviewModelSettings(),
    loadUserAgentCliPaths(),
    loadUserWorkspaceRunSettings(),
    loadFleetConnectionStatus(),
    loadChatDefaults(),
  ]);

  return {
    runtime,
    workspaceConfig: workspace.config,
    userConfig: user.config,
    env,
    memory,
    reviewModel,
    agentCliPaths,
    workspaceRun,
    fleet,
    chatDefaults,
  };
};
