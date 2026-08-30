import { useCallback, useEffect, useRef } from "react";
import type {
  FleetManagedSettingsDelivery,
  FleetManagedSettingsDocument,
} from "@machdoch/fleet-protocol";
import {
  REASONING_MODES,
  RUN_MODES,
  USER_API_PROVIDERS,
  USER_WEB_SEARCH_PROVIDERS,
  type ReasoningMode,
  type RunMode,
} from "../../../../core/runtime-contract.generated";
import {
  deleteUserProviderApiKey,
  deleteUserWebSearchApiKey,
  getFleetConnectionStatus,
  getFleetManagedSettings,
  listInstructions,
  mutateInstructions,
  saveUserAgentLimitsSettings,
  saveUserProviderApiKey,
  saveUserWebSearchActiveProvider,
  saveUserWebSearchApiKey,
  type InstructionProfileView,
  type UserAgentLimitsSettings,
  type UserApiKeyProvider,
  type UserWebSearchApiKeyProvider,
  type WebSearchProvider,
} from "../../runtime";
import {
  type FleetManagedSettingsState,
  type ShellPersistedState,
  type SmartContextPack,
} from "../../chat-session.model";
import {
  SUPPORTED_PROVIDER_ORDER,
  type RuntimeProvider,
} from "../../model-catalog";
import {
  loadAppearanceSettings,
  saveAppearanceSettings,
  type AppearanceSettings,
} from "../../lib/shell-store";
import {
  canUseTauriStore,
  getCurrentShellWindowLabel,
} from "../../lib/_helpers/shell-store-storage.helper";
import { normalizeReasoningModeForProvider } from "../../reasoning-options";

const SETTINGS_REFRESH_MS = 30_000;
const MAIN_WINDOW_LABEL = "main";

interface UseFleetManagedSettingsOptions {
  hasHydrated: boolean;
  shellState: ShellPersistedState;
  applyShellState: (
    update: (current: ShellPersistedState) => ShellPersistedState,
  ) => void;
  userAgentLimitsSettings: UserAgentLimitsSettings;
  applyLoadedUserAgentLimitsSettings: (
    settings: UserAgentLimitsSettings,
  ) => void;
  refreshInstructions: () => Promise<void>;
}

export const useFleetManagedSettings = (
  options: UseFleetManagedSettingsOptions,
): void => {
  const shellStateRef = useRef(options.shellState);
  const agentLimitsRef = useRef(options.userAgentLimitsSettings);
  const syncInFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const lastErrorRef = useRef<string | null>(null);
  shellStateRef.current = options.shellState;
  agentLimitsRef.current = options.userAgentLimitsSettings;

  const sync = useCallback(async (): Promise<void> => {
    if (syncInFlightRef.current) return;
    syncInFlightRef.current = true;
    try {
      const status = await getFleetConnectionStatus();
      if (
        status.phase !== "connected" ||
        !status.enabled ||
        !status.managerId
      ) {
        return;
      }
      const delivery = await getFleetManagedSettings();
      if (!delivery.assigned || !delivery.profile || !delivery.managerId) {
        await clearManagedCollections(
          shellStateRef.current,
          status.managerId,
          options.applyShellState,
          options.refreshInstructions,
        );
        lastErrorRef.current = null;
        return;
      }
      const current = shellStateRef.current.fleetManagedSettings;
      if (
        current?.managerId === delivery.managerId &&
        current.profileId === delivery.profile.profileId &&
        current.revision === delivery.profile.revision
      ) {
        lastErrorRef.current = null;
        return;
      }
      await applyDelivery({
        managerId: delivery.managerId,
        profile: delivery.profile,
        currentState: shellStateRef.current,
        currentAgentLimits: agentLimitsRef.current,
        applyShellState: options.applyShellState,
        applyLoadedAgentLimits: options.applyLoadedUserAgentLimitsSettings,
        refreshInstructions: options.refreshInstructions,
      });
      lastErrorRef.current = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (lastErrorRef.current !== message) {
        console.error("Fleet managed settings synchronization failed", error);
        lastErrorRef.current = message;
      }
    } finally {
      syncInFlightRef.current = false;
    }
  }, [
    options.applyLoadedUserAgentLimitsSettings,
    options.applyShellState,
    options.refreshInstructions,
  ]);

  useEffect(() => {
    mountedRef.current = true;
    if (
      !options.hasHydrated ||
      !canUseTauriStore() ||
      getCurrentShellWindowLabel() !== MAIN_WINDOW_LABEL
    ) {
      return;
    }
    void sync();
    const interval = window.setInterval(() => {
      if (mountedRef.current) void sync();
    }, SETTINGS_REFRESH_MS);
    return () => {
      mountedRef.current = false;
      window.clearInterval(interval);
    };
  }, [options.hasHydrated, sync]);
};

async function applyDelivery({
  managerId,
  profile,
  currentState,
  currentAgentLimits,
  applyShellState,
  applyLoadedAgentLimits,
  refreshInstructions,
}: {
  managerId: string;
  profile: NonNullable<FleetManagedSettingsDelivery["profile"]>;
  currentState: ShellPersistedState;
  currentAgentLimits: UserAgentLimitsSettings;
  applyShellState: UseFleetManagedSettingsOptions["applyShellState"];
  applyLoadedAgentLimits: UseFleetManagedSettingsOptions["applyLoadedUserAgentLimitsSettings"];
  refreshInstructions: () => Promise<void>;
}): Promise<void> {
  const previousManaged = currentState.fleetManagedSettings;
  const instructionProfileIds = await synchronizeInstructions(
    profile.document.instructions,
    previousManaged?.instructionProfileIds ?? {},
  );
  const secretIds = await synchronizeSecrets(
    profile.secrets,
    previousManaged?.secretIds ?? [],
  );
  await synchronizeAppearance(profile.document);
  const agentLimits = await synchronizeAgentLimits(
    profile.document,
    currentAgentLimits,
  );
  if (agentLimits) applyLoadedAgentLimits(agentLimits);
  await synchronizeWebSearch(profile.document);
  const contextPacks = createManagedContextPacks(
    profile.document,
    currentState.contextPacks,
  );
  const metadata: FleetManagedSettingsState = {
    managerId,
    profileId: profile.profileId,
    revision: profile.revision,
    instructionProfileIds,
    contextPackIds: contextPacks.map((pack) => pack.id),
    secretIds,
    appliedAt: Date.now(),
  };
  applyShellState((state) =>
    applyManagedShellSettings(state, profile.document, contextPacks, metadata),
  );
  await refreshInstructions();
}

async function clearManagedCollections(
  currentState: ShellPersistedState,
  managerId: string,
  applyShellState: UseFleetManagedSettingsOptions["applyShellState"],
  refreshInstructions: () => Promise<void>,
): Promise<void> {
  const managed = currentState.fleetManagedSettings;
  if (!managed || managed.managerId !== managerId) return;
  await synchronizeSecrets({}, managed.secretIds);
  await synchronizeInstructions([], managed.instructionProfileIds);
  const managedPackIds = new Set(managed.contextPackIds);
  applyShellState((state) => {
    const next = {
      ...state,
      contextPacks: state.contextPacks.filter(
        (pack) => !managedPackIds.has(pack.id),
      ),
    };
    delete next.fleetManagedSettings;
    return next;
  });
  await refreshInstructions();
}

async function synchronizeInstructions(
  instructions: FleetManagedSettingsDocument["instructions"],
  previousMappings: Record<string, string>,
): Promise<Record<string, string>> {
  const registry = await listInstructions(null);
  if (registry.libraryError) throw new Error(registry.libraryError);
  let revision = registry.revision;
  const profilesById = new Map(
    registry.profiles.map((profile) => [profile.id, profile]),
  );
  const mappings: Record<string, string> = {};

  for (const instruction of instructions) {
    const mapped = previousMappings[instruction.id];
    const profile = mapped ? profilesById.get(mapped) : undefined;
    if (profile) {
      if (!instructionMatchesProfile(instruction, profile)) {
        const result = await mutateInstructions(null, {
          operation: "profile-edit",
          profileId: profile.id,
          name: instruction.name,
          body: instruction.body,
          enabled: instruction.enabled,
          global: instruction.global,
          tags: instruction.tags,
          expectedRevision: revision,
        });
        revision = result.library?.revision ?? revision + 1;
      }
      mappings[instruction.id] = profile.id;
      continue;
    }
    const result = await mutateInstructions(null, {
      operation: "profile-create",
      name: instruction.name,
      body: instruction.body,
      enabled: instruction.enabled,
      global: instruction.global,
      tags: instruction.tags,
      expectedRevision: revision,
    });
    const profileId = result.profile?.id;
    if (!profileId) {
      throw new Error("Fleet instruction synchronization returned no profile.");
    }
    revision = result.library?.revision ?? revision + 1;
    mappings[instruction.id] = profileId;
  }

  const retainedProfileIds = new Set(Object.values(mappings));
  for (const profileId of Object.values(previousMappings)) {
    if (!retainedProfileIds.has(profileId) && profilesById.has(profileId)) {
      const result = await mutateInstructions(null, {
        operation: "profile-delete",
        profileId,
        expectedRevision: revision,
      });
      revision = result.library?.revision ?? revision + 1;
    }
  }
  return mappings;
}

function instructionMatchesProfile(
  instruction: FleetManagedSettingsDocument["instructions"][number],
  profile: InstructionProfileView,
): boolean {
  return (
    profile.name === instruction.name &&
    profile.body === instruction.body &&
    profile.enabled === instruction.enabled &&
    profile.global === instruction.global &&
    JSON.stringify(profile.tags) === JSON.stringify(instruction.tags)
  );
}

export async function synchronizeSecrets(
  secrets: Record<string, string>,
  previousSecretIds: string[],
): Promise<string[]> {
  const secretIds: string[] = [];
  for (const [id, value] of Object.entries(secrets)) {
    if (USER_API_PROVIDERS.includes(id as UserApiKeyProvider)) {
      await saveUserProviderApiKey(id as UserApiKeyProvider, value);
      secretIds.push(id);
    } else if (
      USER_WEB_SEARCH_PROVIDERS.includes(id as UserWebSearchApiKeyProvider)
    ) {
      await saveUserWebSearchApiKey(id as UserWebSearchApiKeyProvider, value);
      secretIds.push(id);
    }
  }
  const retainedSecretIds = new Set(secretIds);
  for (const id of previousSecretIds) {
    if (retainedSecretIds.has(id)) continue;
    if (USER_API_PROVIDERS.includes(id as UserApiKeyProvider)) {
      await deleteUserProviderApiKey(id as UserApiKeyProvider);
    } else if (
      USER_WEB_SEARCH_PROVIDERS.includes(id as UserWebSearchApiKeyProvider)
    ) {
      await deleteUserWebSearchApiKey(id as UserWebSearchApiKeyProvider);
    }
  }
  return secretIds;
}

async function synchronizeAppearance(
  document: FleetManagedSettingsDocument,
): Promise<void> {
  const { theme, density, accent } = document.defaults;
  if (!theme && !density && !accent) return;
  const current = await loadAppearanceSettings();
  const next: AppearanceSettings = {
    ...current,
    ...(theme === "dark" || theme === "light" ? { theme } : {}),
    ...(density === "comfortable" || density === "compact" ? { density } : {}),
    ...(accent === "sky" ||
    accent === "emerald" ||
    accent === "violet" ||
    accent === "amber"
      ? { accent }
      : {}),
  };
  if (JSON.stringify(next) !== JSON.stringify(current)) {
    await saveAppearanceSettings(next, current);
  }
}

async function synchronizeAgentLimits(
  document: FleetManagedSettingsDocument,
  current: UserAgentLimitsSettings,
): Promise<UserAgentLimitsSettings | null> {
  const managed = document.agentLimits;
  const next: UserAgentLimitsSettings = {
    infinite: managed.infinite ?? current.infinite,
    executorTurns: managed.executorTurns ?? current.executorTurns,
    autopilotExecutorIterations:
      managed.autopilotExecutorIterations ??
      current.autopilotExecutorIterations,
  };
  return JSON.stringify(next) === JSON.stringify(current)
    ? null
    : saveUserAgentLimitsSettings(next);
}

async function synchronizeWebSearch(
  document: FleetManagedSettingsDocument,
): Promise<void> {
  const provider = document.defaults.webSearchProvider;
  if (provider && ["none", ...USER_WEB_SEARCH_PROVIDERS].includes(provider)) {
    await saveUserWebSearchActiveProvider(provider as WebSearchProvider);
  }
}

export function createManagedContextPacks(
  document: FleetManagedSettingsDocument,
  currentPacks: SmartContextPack[],
): SmartContextPack[] {
  const currentById = new Map(currentPacks.map((pack) => [pack.id, pack]));
  const timestamp = Date.now();
  return document.contextPacks.map((pack, index) => {
    const current = currentById.get(pack.id);
    const provider = isRuntimeProvider(pack.provider) ? pack.provider : null;
    const mode = isRunMode(pack.mode) ? pack.mode : null;
    const reasoning = isReasoningMode(pack.reasoning) ? pack.reasoning : null;
    return {
      id: pack.id,
      workspace: null,
      name: pack.name,
      instructions: pack.instructions,
      prompt: pack.prompt,
      contextAttachments: [],
      variables: pack.variables.map((name) => ({ name })),
      trigger: {
        phrases: pack.triggerPhrases,
        pathPatterns: pack.pathPatterns,
      },
      createdAt: current?.createdAt ?? timestamp + index,
      updatedAt: timestamp + index,
      ...(current?.lastUsedAt ? { lastUsedAt: current.lastUsedAt } : {}),
      useCount: current?.useCount ?? 0,
      ...(provider && pack.model ? { provider, model: pack.model } : {}),
      ...(mode ? { mode } : {}),
      ...(reasoning ? { reasoning } : {}),
    };
  });
}

export function applyManagedShellSettings(
  state: ShellPersistedState,
  document: FleetManagedSettingsDocument,
  managedPacks: SmartContextPack[],
  metadata: FleetManagedSettingsState,
): ShellPersistedState {
  const managedPackIds = new Set([
    ...(state.fleetManagedSettings?.contextPackIds ?? []),
    ...managedPacks.map((pack) => pack.id),
  ]);
  const next: ShellPersistedState = {
    ...state,
    contextPacks: [
      ...managedPacks,
      ...state.contextPacks.filter((pack) => !managedPackIds.has(pack.id)),
    ],
    fleetManagedSettings: metadata,
  };
  const providerCandidate =
    document.defaults.preferredToolingAgent ?? document.defaults.provider;
  if (isRuntimeProvider(providerCandidate)) {
    next.lastSelectedProvider = providerCandidate;
    if (document.defaults.model) {
      next.lastSelectedModelByProvider = {
        ...next.lastSelectedModelByProvider,
        [providerCandidate]: document.defaults.model,
      };
    }
  }
  if (isRunMode(document.defaults.mode)) {
    next.lastSelectedMode = document.defaults.mode;
  }
  if (isReasoningMode(document.defaults.reasoning)) {
    const provider = isRuntimeProvider(providerCandidate)
      ? providerCandidate
      : next.lastSelectedProvider;
    const model =
      document.defaults.model ?? next.lastSelectedModelByProvider[provider];
    next.lastSelectedReasoning = normalizeReasoningModeForProvider(
      document.defaults.reasoning,
      provider,
      model,
    );
  }
  return next;
}

const isRuntimeProvider = (value: string | null): value is RuntimeProvider =>
  value !== null && SUPPORTED_PROVIDER_ORDER.includes(value as RuntimeProvider);

const isRunMode = (value: string | null): value is RunMode =>
  value !== null && RUN_MODES.includes(value as RunMode);

const isReasoningMode = (value: string | null): value is ReasoningMode =>
  value !== null && REASONING_MODES.includes(value as ReasoningMode);
