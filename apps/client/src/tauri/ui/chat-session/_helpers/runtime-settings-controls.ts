import type { ChatSessionRuntimeController } from "./use-chat-session-runtime";
import type { SettingsControlsProps } from "../components/settings-dialog";
import type { MemorySourceSession } from "../../components/memory-management-entries";

export function createRuntimeSettingsControls(
  runtime: ChatSessionRuntimeController,
  memorySourceSessions: MemorySourceSession[],
): Omit<SettingsControlsProps, "appearanceSetup" | "voiceSetup"> {
  return {
    providerSetup: {
      provider: runtime.providerSetupProvider,
      providerAvailability: runtime.globalProviders ?? [],
      keyValue: runtime.providerSetupKey,
      loading: runtime.providerSetupLoading,
      saving: runtime.providerSetupSaving,
      message: runtime.providerSetupMessage,
      onProviderChange: runtime.handleProviderSetupProviderChange,
      onOpenProviderPortal: runtime.handleProviderSetupPortalOpen,
      onKeyChange: runtime.handleProviderSetupKeyChange,
      onSave: runtime.handleProviderSetupSave,
    },
    webSearchSetup: {
      activeProvider: runtime.webSearchActiveProvider,
      providerAvailability: runtime.webSearchProviderAvailability,
      provider: runtime.webSearchSetupProvider,
      keyValue: runtime.webSearchSetupKey,
      loading: runtime.webSearchSetupLoading,
      saving: runtime.webSearchSetupSaving,
      message: runtime.webSearchSetupMessage,
      onActiveProviderChange: runtime.handleWebSearchActiveProviderSave,
      onProviderChange: runtime.handleWebSearchSetupProviderChange,
      onKeyChange: runtime.handleWebSearchSetupKeyChange,
      onSave: runtime.handleWebSearchSetupSave,
    },
    memorySetup: {
      settings: runtime.userMemorySettings,
      sourceSessions: memorySourceSessions,
      saving: runtime.memorySetupSaving,
      message: runtime.memorySetupMessage,
      onGlobalEnabledChange: runtime.handleGlobalMemoryEnabledSave,
      onWorkspaceDefaultEnabledChange:
        runtime.handleWorkspaceMemoryDefaultEnabledSave,
      onForgetGlobal: runtime.handleGlobalMemoryForget,
    },
    desktopSetup: {
      settings: runtime.userDesktopSettings,
      saving: runtime.desktopSetupSaving,
      message: runtime.desktopSetupMessage,
      onSave: runtime.handleDesktopSettingsSave,
    },
    workspaceRunSetup: {
      settings: runtime.userWorkspaceRunSettings,
      saving: runtime.workspaceRunSetupSaving,
      message: runtime.workspaceRunSetupMessage,
      onSave: runtime.handleWorkspaceRunSettingsSave,
    },
    agentLimitsSetup: {
      settings: runtime.userAgentLimitsSettings,
      reviewModelSettings: runtime.userReviewModelSettings,
      providerAvailability: runtime.globalProviders ?? [],
      saving: runtime.agentLimitsSetupSaving,
      message: runtime.agentLimitsSetupMessage,
      onSave: runtime.handleAgentLimitsSettingsSave,
      onReviewModelSave: runtime.handleReviewModelSettingsSave,
    },
  };
}
