import {
  createFleetManagedSettingsEtag,
  type FleetManagedSettingsDelivery,
  type FleetManagedSettingsDocument,
} from "@machdoch/fleet-protocol";
import { useCallback, useEffect, useRef } from "react";
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
  loadUserProviderApiKeys,
  loadUserWebSearchSettings,
  mutateInstructions,
  reportFleetManagedSettingsApplied,
  reportFleetManagedSettingsFailure,
  saveUserAgentLimitsSettings,
  saveUserProviderApiKey,
  saveUserWebSearchActiveProvider,
  saveUserWebSearchApiKey,
  synchronizeFleetManagedPrompts,
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
import { subscribeToFleetManagedSettingsSyncRequests } from "./fleet-managed-settings-sync";

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

interface CachedDelivery {
  etag: string;
  delivery: FleetManagedSettingsDelivery;
}

export const useFleetManagedSettings = (
  options: UseFleetManagedSettingsOptions,
): void => {
  const shellStateRef = useRef(options.shellState);
  const agentLimitsRef = useRef(options.userAgentLimitsSettings);
  const syncInFlightRef = useRef(false);
  const cachedDeliveryRef = useRef<CachedDelivery | null>(null);
  const lastErrorRef = useRef<string | null>(null);
  shellStateRef.current = options.shellState;
  agentLimitsRef.current = options.userAgentLimitsSettings;

  const clear = useCallback(
    async (managerId: string): Promise<void> => {
      await clearManagedCollections(
        shellStateRef.current,
        managerId,
        options.applyShellState,
        options.refreshInstructions,
      );
      cachedDeliveryRef.current = null;
    },
    [options.applyShellState, options.refreshInstructions],
  );

  const sync = useCallback(async (): Promise<void> => {
    if (syncInFlightRef.current) return;
    syncInFlightRef.current = true;
    let reportingManagerId: string | null = null;
    let reportingProfileId: string | null = null;
    let reportingRevision: number | null = null;
    try {
      const status = await getFleetConnectionStatus();
      const currentManagedSettings = shellStateRef.current.fleetManagedSettings;
      const currentManagerId = currentManagedSettings?.managerId;
      if (!status.enabled || !status.managerId) {
        if (currentManagerId) await clear(currentManagerId);
        lastErrorRef.current = null;
        return;
      }
      reportingManagerId = status.managerId;
      if (currentManagedSettings?.managerId === status.managerId) {
        reportingProfileId = currentManagedSettings.profileId;
        reportingRevision = currentManagedSettings.revision;
      }
      if (currentManagerId && currentManagerId !== status.managerId) {
        await clear(currentManagerId);
      }

      const cached =
        cachedDeliveryRef.current?.delivery.managerId === status.managerId
          ? cachedDeliveryRef.current
          : null;
      if (cached) {
        reportingProfileId = cached.delivery.profile?.profileId ?? null;
        reportingRevision = cached.delivery.profile?.revision ?? null;
      }
      const fetched = await getFleetManagedSettings(cached?.etag);
      const delivery = fetched ?? cached?.delivery;
      if (!delivery) {
        throw new Error(
          "Fleet Manager returned no settings for a changed entity tag.",
        );
      }
      if (fetched) {
        cachedDeliveryRef.current = {
          delivery,
          etag: createFleetManagedSettingsEtag(delivery),
        };
      }
      reportingProfileId = delivery.profile?.profileId ?? null;
      reportingRevision = delivery.profile?.revision ?? null;

      if (!delivery.profile) {
        await clearManagedCollections(
          shellStateRef.current,
          delivery.managerId,
          options.applyShellState,
          options.refreshInstructions,
        );
        await reportFleetManagedSettingsApplied(delivery.managerId, null, null);
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
      await reportFleetManagedSettingsApplied(
        delivery.managerId,
        delivery.profile.profileId,
        delivery.profile.revision,
      );
      lastErrorRef.current = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      let reportingError: unknown;
      if (reportingManagerId) {
        try {
          await reportFleetManagedSettingsFailure(
            reportingManagerId,
            reportingProfileId,
            reportingRevision,
            message,
          );
        } catch (failure) {
          reportingError = failure;
        }
      }
      if (lastErrorRef.current !== message) {
        console.error("Fleet managed settings synchronization failed", error);
        if (reportingError) {
          console.error(
            "Fleet managed settings failure could not be reported",
            reportingError,
          );
        }
        lastErrorRef.current = message;
      }
    } finally {
      syncInFlightRef.current = false;
    }
  }, [
    clear,
    options.applyLoadedUserAgentLimitsSettings,
    options.applyShellState,
    options.refreshInstructions,
  ]);

  useEffect(() => {
    if (
      !options.hasHydrated ||
      !canUseTauriStore() ||
      getCurrentShellWindowLabel() !== MAIN_WINDOW_LABEL
    ) {
      return;
    }
    void sync();
    const interval = window.setInterval(() => void sync(), SETTINGS_REFRESH_MS);
    const unsubscribe = subscribeToFleetManagedSettingsSyncRequests(
      () => void sync(),
    );
    return () => {
      window.clearInterval(interval);
      unsubscribe();
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
  validateDelivery(profile);
  const previousManaged = currentState.fleetManagedSettings;
  const instructions = await synchronizeInstructions(
    profile.document.instructions,
    previousManaged?.instructionProfileIds ?? {},
  );
  if (instructions.changed) await refreshInstructions();
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
  await synchronizeFleetManagedPrompts(managerId, profile.document.prompts);
  const contextPacks = createManagedContextPacks(
    profile.document,
    currentState.contextPacks,
    managerId,
    previousManaged?.contextPackIds ?? [],
  );
  const sameRevision =
    previousManaged?.managerId === managerId &&
    previousManaged.profileId === profile.profileId &&
    previousManaged.revision === profile.revision;
  const metadata: FleetManagedSettingsState = {
    managerId,
    profileId: profile.profileId,
    revision: profile.revision,
    instructionProfileIds: instructions.mappings,
    contextPackIds: contextPacks.map((pack) => pack.id),
    secretIds,
    appliedAt: sameRevision ? previousManaged.appliedAt : Date.now(),
  };
  applyShellState((state) =>
    applyManagedShellSettings(state, profile.document, contextPacks, metadata),
  );
}

function validateDelivery(
  profile: NonNullable<FleetManagedSettingsDelivery["profile"]>,
): void {
  const { defaults, contextPacks } = profile.document;
  if (
    (defaults.provider !== null && !isRuntimeProvider(defaults.provider)) ||
    (defaults.model !== null && defaults.provider === null) ||
    (defaults.mode !== null && !isRunMode(defaults.mode)) ||
    (defaults.reasoning !== null && !isReasoningMode(defaults.reasoning)) ||
    (defaults.webSearchProvider !== null &&
      !["none", ...USER_WEB_SEARCH_PROVIDERS].includes(
        defaults.webSearchProvider,
      )) ||
    (defaults.theme !== null && !["dark", "light"].includes(defaults.theme)) ||
    (defaults.density !== null &&
      !["comfortable", "compact"].includes(defaults.density)) ||
    (defaults.accent !== null &&
      !["sky", "emerald", "violet", "amber"].includes(defaults.accent))
  ) {
    throw new Error("Fleet Manager returned unsupported managed defaults.");
  }
  for (const pack of contextPacks) {
    if (
      (pack.provider !== null && !isRuntimeProvider(pack.provider)) ||
      (pack.provider === null) !== (pack.model === null) ||
      (pack.mode !== null && !isRunMode(pack.mode)) ||
      (pack.reasoning !== null && !isReasoningMode(pack.reasoning)) ||
      (pack.promptEnhancementMode !== null &&
        !(["off", "simple", "web-search"] as readonly string[]).includes(
          pack.promptEnhancementMode,
        ))
    ) {
      throw new Error(
        "Fleet Manager returned unsupported context pack settings.",
      );
    }
  }
  const supportedSecrets = new Set<string>([
    ...USER_API_PROVIDERS,
    ...USER_WEB_SEARCH_PROVIDERS,
  ]);
  if (Object.keys(profile.secrets).some((id) => !supportedSecrets.has(id))) {
    throw new Error("Fleet Manager returned an unsupported managed secret.");
  }
}

async function clearManagedCollections(
  currentState: ShellPersistedState,
  managerId: string,
  applyShellState: UseFleetManagedSettingsOptions["applyShellState"],
  refreshInstructions: () => Promise<void>,
): Promise<void> {
  const managed = currentState.fleetManagedSettings;
  await synchronizeFleetManagedPrompts(managerId, []);
  if (!managed || managed.managerId !== managerId) return;
  await synchronizeSecrets({}, managed.secretIds);
  const instructions = await synchronizeInstructions(
    [],
    managed.instructionProfileIds,
  );
  const managedPackIds = new Set(managed.contextPackIds);
  applyShellState((state) => {
    const contextPacks = state.contextPacks.filter(
      (pack) => !managedPackIds.has(pack.id),
    );
    const next = { ...state, contextPacks };
    delete next.fleetManagedSettings;
    return next;
  });
  if (instructions.changed) await refreshInstructions();
}

async function synchronizeInstructions(
  instructions: FleetManagedSettingsDocument["instructions"],
  previousMappings: Record<string, string>,
): Promise<{ mappings: Record<string, string>; changed: boolean }> {
  const registry = await listInstructions(null);
  if (registry.libraryError) throw new Error(registry.libraryError);
  let revision = registry.revision;
  let changed = false;
  const profilesById = new Map(
    registry.profiles.map((profile) => [profile.id, profile]),
  );
  const mappings: Record<string, string> = {};

  for (const instruction of instructions) {
    const profile = profilesById.get(instruction.id);
    if (profile) {
      if (!instructionMatchesProfile(instruction, profile)) {
        if (previousMappings[instruction.id] !== profile.id) {
          throw new Error(
            `Managed instruction id ${instruction.id} conflicts with a local profile.`,
          );
        }
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
        changed = true;
      }
      mappings[instruction.id] = profile.id;
      continue;
    }
    const result = await mutateInstructions(null, {
      operation: "profile-create",
      profileId: instruction.id,
      name: instruction.name,
      body: instruction.body,
      enabled: instruction.enabled,
      global: instruction.global,
      tags: instruction.tags,
      expectedRevision: revision,
    });
    if (result.profile?.id !== instruction.id) {
      throw new Error(
        "Fleet instruction synchronization returned an invalid profile.",
      );
    }
    revision = result.library?.revision ?? revision + 1;
    mappings[instruction.id] = instruction.id;
    changed = true;
  }

  const retainedProfileIds = new Set(Object.values(mappings));
  for (const profileId of new Set(Object.values(previousMappings))) {
    if (!retainedProfileIds.has(profileId) && profilesById.has(profileId)) {
      const result = await mutateInstructions(null, {
        operation: "profile-delete",
        profileId,
        expectedRevision: revision,
      });
      revision = result.library?.revision ?? revision + 1;
      changed = true;
    }
  }
  return { mappings, changed };
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
    arraysEqual(profile.tags, instruction.tags)
  );
}

export async function synchronizeSecrets(
  secrets: Record<string, string>,
  previousSecretIds: string[],
): Promise<string[]> {
  const [providerKeys, webSearch] = await Promise.all([
    loadUserProviderApiKeys(),
    loadUserWebSearchSettings(),
  ]);
  const secretIds: string[] = [];
  for (const [id, value] of Object.entries(secrets)) {
    if (USER_API_PROVIDERS.includes(id as UserApiKeyProvider)) {
      if (providerKeys[id as UserApiKeyProvider] !== value) {
        await saveUserProviderApiKey(id as UserApiKeyProvider, value);
      }
      secretIds.push(id);
    } else if (
      USER_WEB_SEARCH_PROVIDERS.includes(id as UserWebSearchApiKeyProvider)
    ) {
      if (webSearch.apiKeys[id as UserWebSearchApiKeyProvider] !== value) {
        await saveUserWebSearchApiKey(id as UserWebSearchApiKeyProvider, value);
      }
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
  if (!recordsEqual(next, current)) {
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
  return recordsEqual(next, current) ? null : saveUserAgentLimitsSettings(next);
}

async function synchronizeWebSearch(
  document: FleetManagedSettingsDocument,
): Promise<void> {
  const provider = document.defaults.webSearchProvider;
  if (!provider || !["none", ...USER_WEB_SEARCH_PROVIDERS].includes(provider)) {
    return;
  }
  const current = await loadUserWebSearchSettings();
  if (current.activeProvider !== provider) {
    await saveUserWebSearchActiveProvider(provider as WebSearchProvider);
  }
}

export function createManagedContextPacks(
  document: FleetManagedSettingsDocument,
  currentPacks: SmartContextPack[],
  managerId: string,
  previouslyManagedIds: string[] = [],
): SmartContextPack[] {
  const currentById = new Map(currentPacks.map((pack) => [pack.id, pack]));
  const ownedIds = new Set(previouslyManagedIds);
  const timestamp = Date.now();
  return document.contextPacks.map((pack, index) => {
    const id = managedContextPackId(managerId, pack.id);
    const current = currentById.get(id);
    if (current && !ownedIds.has(id)) {
      throw new Error(
        `Managed context pack id ${id} conflicts with a local pack.`,
      );
    }
    const provider = isRuntimeProvider(pack.provider) ? pack.provider : null;
    const mode = isRunMode(pack.mode) ? pack.mode : null;
    const reasoning = isReasoningMode(pack.reasoning) ? pack.reasoning : null;
    const desired: SmartContextPack = {
      id,
      workspace: null,
      name: pack.name,
      instructions: pack.instructions,
      prompt: pack.prompt,
      contextAttachments: [],
      variables: pack.variables.map((variable) => ({
        name: variable.name,
        ...(variable.defaultValue === null
          ? {}
          : { defaultValue: variable.defaultValue }),
      })),
      trigger: {
        phrases: pack.triggerPhrases,
        pathPatterns: pack.pathPatterns,
      },
      createdAt: current?.createdAt ?? timestamp + index,
      updatedAt: timestamp + index,
      ...(current?.lastUsedAt === undefined
        ? {}
        : { lastUsedAt: current.lastUsedAt }),
      useCount: current?.useCount ?? 0,
      ...(provider ? { provider } : {}),
      ...(pack.model ? { model: pack.model } : {}),
      ...(mode ? { mode } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(pack.promptEnhancementMode === null
        ? {}
        : { promptEnhancementMode: pack.promptEnhancementMode }),
      ...(pack.interviewEnabled === null
        ? {}
        : { interviewEnabled: pack.interviewEnabled }),
      ...(pack.sessionMemoryEnabled === null
        ? {}
        : { sessionMemoryEnabled: pack.sessionMemoryEnabled }),
      ...(pack.useGlobalMemory === null
        ? {}
        : { useGlobalMemory: pack.useGlobalMemory }),
      ...(pack.uiControlEnabled === null
        ? {}
        : { uiControlEnabled: pack.uiControlEnabled }),
    };
    return current && managedPackContentMatches(current, desired)
      ? current
      : desired;
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
  const contextPacks = [
    ...managedPacks,
    ...state.contextPacks.filter((pack) => !managedPackIds.has(pack.id)),
  ];
  const next: ShellPersistedState = {
    ...state,
    contextPacks,
    fleetManagedSettings: metadata,
  };
  const providerCandidate = document.defaults.provider;
  if (isRuntimeProvider(providerCandidate)) {
    next.lastSelectedProvider = providerCandidate;
    if (
      document.defaults.model &&
      next.lastSelectedModelByProvider[providerCandidate] !==
        document.defaults.model
    ) {
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
  return shellManagedStateMatches(state, next) ? state : next;
}

const managedContextPackId = (managerId: string, packId: string): string =>
  `fleet:${managerId}:${packId}`;

const managedPackContentMatches = (
  current: SmartContextPack,
  desired: SmartContextPack,
): boolean =>
  current.id === desired.id &&
  current.workspace === null &&
  current.name === desired.name &&
  current.instructions === desired.instructions &&
  current.prompt === desired.prompt &&
  current.contextAttachments.length === 0 &&
  recordsEqual(current.variables, desired.variables) &&
  recordsEqual(current.trigger, desired.trigger) &&
  current.provider === desired.provider &&
  current.model === desired.model &&
  current.mode === desired.mode &&
  current.reasoning === desired.reasoning &&
  current.promptEnhancementMode === desired.promptEnhancementMode &&
  current.interviewEnabled === desired.interviewEnabled &&
  current.sessionMemoryEnabled === desired.sessionMemoryEnabled &&
  current.useGlobalMemory === desired.useGlobalMemory &&
  current.uiControlEnabled === desired.uiControlEnabled;

const shellManagedStateMatches = (
  current: ShellPersistedState,
  next: ShellPersistedState,
): boolean =>
  current.contextPacks.length === next.contextPacks.length &&
  current.contextPacks.every(
    (pack, index) => pack === next.contextPacks[index],
  ) &&
  recordsEqual(current.fleetManagedSettings, next.fleetManagedSettings) &&
  current.lastSelectedProvider === next.lastSelectedProvider &&
  current.lastSelectedModelByProvider === next.lastSelectedModelByProvider &&
  current.lastSelectedMode === next.lastSelectedMode &&
  current.lastSelectedReasoning === next.lastSelectedReasoning;

const arraysEqual = <T>(left: T[], right: T[]): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const recordsEqual = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const isRuntimeProvider = (value: string | null): value is RuntimeProvider =>
  value !== null && SUPPORTED_PROVIDER_ORDER.includes(value as RuntimeProvider);

const isRunMode = (value: string | null): value is RunMode =>
  value !== null && RUN_MODES.includes(value as RunMode);

const isReasoningMode = (value: string | null): value is ReasoningMode =>
  value !== null && REASONING_MODES.includes(value as ReasoningMode);
