import {
  createFleetManagedSettingsEtag,
  managedSettingsDocumentSchema,
  managedSettingsPolicyFields,
  maximumManagedSettingsCollectionEntries,
  type FleetManagedSettingsDelivery,
  type FleetManagedSettingsDocument,
  type ManagedSettingsPolicyField,
} from "@machdoch/fleet-protocol";
import {
  isManagedSettingEnforced,
  managedSettingsFieldAccess,
  normalizeManagedItemName,
  toLegacyManagedSettingsDocument,
} from "@machdoch/fleet-protocol/managed-settings";
import { useCallback, useEffect, useRef, useState } from "react";
import { managedMcpServerWarnings } from "../../../../core/fleet-mcp";
import {
  REASONING_MODES,
  RUN_MODES,
  USER_API_PROVIDERS,
  USER_WEB_SEARCH_PROVIDERS,
  type ReasoningMode,
  type RunMode,
} from "../../../../core/runtime-contract.generated";
import {
  captureFleetEnrollmentSettings,
  deleteUserProviderApiKey,
  deleteUserWebSearchApiKey,
  exportFleetLocalSettings,
  fleetEnrollmentCaptureRequired,
  getFleetConnectionStatus,
  getFleetManagedSettings,
  getFleetSettingsSnapshotStatus,
  listInstructions,
  loadUserAgentLimitsSettings,
  loadUserWebSearchSettings,
  mutateInstructions,
  releaseFleetManagedApiKeys,
  reportFleetManagedSettingsApplied,
  reportFleetManagedSettingsFailure,
  saveUserAgentLimitsSettings,
  saveUserWebSearchActiveProvider,
  synchronizeFleetManagedPrompts,
  uploadFleetSettingsSnapshot,
  type FleetManagedSettingsReportIdentity,
  type InstructionMutationInput,
  type InstructionProfileView,
  type UserAgentLimitsSettings,
  type UserApiKeyProvider,
  type UserWebSearchApiKeyProvider,
  type WebSearchProvider,
} from "../../runtime";
import {
  type FleetManagedFieldValue,
  type FleetManagedInstructionOriginal,
  type FleetManagedSettingsState,
  type ShellPersistedState,
} from "../../chat-session.model";
import { type SmartContextPack } from "@machdoch/client-ui/context-packs/model";
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
} from "@machdoch/media-studio/tauri/ui/lib/_helpers/shell-store-storage.helper.js";
import { normalizeReasoningModeForProvider } from "../../reasoning-options";
import {
  registerFleetDeviceSettingsHandler,
  subscribeToFleetManagedSettingsSyncRequests,
} from "./fleet-managed-settings-sync";

const SETTINGS_REFRESH_MS = 30_000;
const MAIN_WINDOW_LABEL = "main";
const MAXIMUM_SYNC_WARNINGS = 32;

interface UseFleetManagedSettingsOptions {
  hasHydrated: boolean;
  shellState: ShellPersistedState;
  applyShellState: (
    update: (current: ShellPersistedState) => ShellPersistedState,
  ) => void;
  /**
   * Not read: limits may not be loaded yet when a sync starts, so managed
   * settings load the stored limits themselves.
   */
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

type ApplyShellState = UseFleetManagedSettingsOptions["applyShellState"];

export const useFleetManagedSettings = (
  options: UseFleetManagedSettingsOptions,
): void => {
  const shellStateRef = useRef(options.shellState);
  const [queue] = useState(createSyncQueue);
  const cachedDeliveryRef = useRef<CachedDelivery | null>(null);
  const lastErrorRef = useRef<string | null>(null);
  const capturedEnrollmentRef = useRef<string | null>(null);
  shellStateRef.current = options.shellState;

  const environment = useCallback(
    (): ManagedEnvironment => ({
      // Later steps must see what earlier steps wrote, not the last render.
      applyShellState: (update) =>
        options.applyShellState((current) => {
          const next = update(current);
          shellStateRef.current = next;
          return next;
        }),
      applyLoadedAgentLimits: options.applyLoadedUserAgentLimitsSettings,
      refreshInstructions: options.refreshInstructions,
      readState: () => shellStateRef.current,
    }),
    [
      options.applyShellState,
      options.applyLoadedUserAgentLimitsSettings,
      options.refreshInstructions,
    ],
  );

  /** Removes another manager's settings; throws while some are not restored. */
  const clear = useCallback(
    async (managerId: string): Promise<void> => {
      const warnings = await applyManagedSettings(
        { managerId, profile: null },
        environment(),
      );
      cachedDeliveryRef.current = null;
      if (currentManaged(shellStateRef.current, managerId)) {
        throw new Error(
          warnings.join(" ") ||
            "Settings from machdoch.cloud could not be removed.",
        );
      }
    },
    [environment],
  );

  const buildSnapshot =
    useCallback(async (): Promise<FleetManagedSettingsDocument> => {
      const initial = shellStateRef.current;
      const workspace =
        initial.sessions.find(
          (session) => session.id === initial.activeSessionId,
        )?.workspace ?? null;
      const [local, appearance, limits] = await Promise.all([
        exportFleetLocalSettings(workspace),
        loadAppearanceSettings(),
        loadUserAgentLimitsSettings(),
      ]);
      return createEnrollmentSettingsDocument(
        local,
        shellStateRef.current,
        appearance,
        limits,
      );
    }, []);

  const uploadSnapshot = useCallback(async (): Promise<boolean> => {
    const status = await getFleetConnectionStatus();
    if (!status.enabled || !status.managerId || !status.instanceId)
      throw new Error("Connect this device to machdoch.cloud first.");
    const document = await buildSnapshot();
    const uploaded = await uploadFleetSettingsSnapshot(
      status.managerId,
      status.instanceId,
      document,
    );
    if (!uploaded) {
      await captureFleetEnrollmentSettings(
        status.managerId,
        status.instanceId,
        toLegacyManagedSettingsDocument(document),
      );
    }
    return uploaded;
  }, [buildSnapshot]);

  const runSync = useCallback(async (): Promise<void> => {
    let reportingManagerId: string | null = null;
    let reportingIdentity: FleetManagedSettingsReportIdentity = {
      profileId: null,
      revision: null,
    };
    try {
      const status = await getFleetConnectionStatus();
      const currentManagerId =
        shellStateRef.current.fleetManagedSettings?.managerId;
      if (!status.enabled || !status.managerId || !status.instanceId) {
        if (currentManagerId) await clear(currentManagerId);
        lastErrorRef.current = null;
        return;
      }
      reportingManagerId = status.managerId;
      if (currentManagerId && currentManagerId !== status.managerId) {
        await clear(currentManagerId);
      }
      const applied = currentManaged(shellStateRef.current, status.managerId);
      if (applied) reportingIdentity = appliedIdentity(applied);

      // Uploading the baseline must never keep managed settings from applying.
      const snapshotWarnings: string[] = [];
      try {
        const snapshot = await getFleetSettingsSnapshotStatus();
        if (snapshot === null) {
          const enrollmentIdentity = `${status.managerId}:${status.instanceId}`;
          if (capturedEnrollmentRef.current !== enrollmentIdentity) {
            if (await fleetEnrollmentCaptureRequired()) {
              await captureFleetEnrollmentSettings(
                status.managerId,
                status.instanceId,
                toLegacyManagedSettingsDocument(await buildSnapshot()),
              );
            }
            capturedEnrollmentRef.current = enrollmentIdentity;
          }
        } else if (snapshot.requested) {
          await uploadFleetSettingsSnapshot(
            status.managerId,
            status.instanceId,
            await buildSnapshot(),
          );
        }
      } catch (error) {
        snapshotWarnings.push(
          `Device settings could not be uploaded: ${errorMessage(error)}`,
        );
      }

      const cached =
        cachedDeliveryRef.current?.delivery.managerId === status.managerId
          ? cachedDeliveryRef.current
          : null;
      if (cached) reportingIdentity = reportIdentity(cached.delivery);
      const fetched = await getFleetManagedSettings(cached?.etag);
      const delivery = fetched ?? cached?.delivery;
      if (!delivery) {
        throw new Error(
          "machdoch.cloud returned no settings for a changed entity tag.",
        );
      }
      if (fetched) {
        cachedDeliveryRef.current = {
          delivery,
          etag: createFleetManagedSettingsEtag(delivery),
        };
      }
      reportingIdentity = reportIdentity(delivery);

      const warnings = await applyManagedSettings(delivery, environment());
      await reportFleetManagedSettingsApplied(
        delivery.managerId,
        reportingIdentity,
        uniqueWarnings([...snapshotWarnings, ...warnings]),
      );
      lastErrorRef.current = null;
    } catch (error) {
      const message = errorMessage(error);
      let reportingError: unknown;
      if (reportingManagerId) {
        try {
          await reportFleetManagedSettingsFailure(
            reportingManagerId,
            reportingIdentity,
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
    }
  }, [buildSnapshot, clear, environment]);

  const sync = useCallback(() => queue.sync(runSync), [queue, runSync]);

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
    const unregister = registerFleetDeviceSettingsHandler({
      uploadSnapshot: () => queue.exclusive(uploadSnapshot),
      exportLocalSettings: () => queue.exclusive(buildSnapshot),
    });
    return () => {
      window.clearInterval(interval);
      unsubscribe();
      unregister();
    };
  }, [buildSnapshot, options.hasHydrated, queue, sync, uploadSnapshot]);
};

/**
 * Runs one task at a time so uploads never read a half-applied profile. A sync
 * requested while another one waits joins it; one requested while a sync runs
 * starts afterwards instead of being dropped.
 */
export function createSyncQueue(): {
  exclusive: <T>(task: () => Promise<T>) => Promise<T>;
  sync: (run: () => Promise<void>) => Promise<void>;
} {
  let tail: Promise<unknown> = Promise.resolve();
  let waiting: Promise<void> | null = null;
  const exclusive = <T>(task: () => Promise<T>): Promise<T> => {
    const result = tail.then(task);
    tail = result.catch(() => undefined);
    return result;
  };
  return {
    exclusive,
    sync: (run) =>
      (waiting ??= exclusive(async () => {
        waiting = null;
        await run();
      })),
  };
}

export interface ManagedEnvironment {
  applyShellState: ApplyShellState;
  applyLoadedAgentLimits: (settings: UserAgentLimitsSettings) => void;
  refreshInstructions: () => Promise<void>;
  readState: () => ShellPersistedState;
}

const reportIdentity = (
  delivery: FleetManagedSettingsDelivery,
): FleetManagedSettingsReportIdentity => ({
  profileId: delivery.profile?.profileId ?? null,
  revision: delivery.profile?.revision ?? null,
  ...(delivery.schemaVersion >= 3 && delivery.profile && delivery.layers?.length
    ? {
        layers: delivery.layers.map((layer) => ({
          profileId: layer.profileId,
          revision: layer.revision,
        })),
      }
    : {}),
});

/** Identity of what this device applied last, for failures before a fetch. */
const appliedIdentity = (
  managed: FleetManagedSettingsState,
): FleetManagedSettingsReportIdentity => ({
  profileId: managed.profileId,
  revision: managed.revision,
  ...(managed.layers?.length
    ? {
        layers: managed.layers.map((layer) => ({
          profileId: layer.profileId,
          revision: layer.revision,
        })),
      }
    : {}),
});

const uniqueWarnings = (warnings: string[]): string[] =>
  [...new Set(warnings)].slice(0, MAXIMUM_SYNC_WARNINGS);

const instructionSchema =
  managedSettingsDocumentSchema.shape.instructions.element;
const contextPackSchema =
  managedSettingsDocumentSchema.shape.contextPacks.element;

/** Keeps the items machdoch.cloud accepts, normalized as it stores them. */
const portableItems = <T>(
  items: T[],
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
): T[] =>
  items
    .flatMap((item) => {
      const parsed = schema.safeParse(item);
      return parsed.success ? [parsed.data as T] : [];
    })
    .slice(0, maximumManagedSettingsCollectionEntries);

/**
 * Builds the device baseline for machdoch.cloud. Items created for the cloud
 * are left out; items the cloud took over are exported with the user's
 * original content, and managed values are replaced by the user's own.
 */
export function createEnrollmentSettingsDocument(
  local: FleetManagedSettingsDocument,
  state: ShellPersistedState,
  appearance: AppearanceSettings,
  limits: UserAgentLimitsSettings,
): FleetManagedSettingsDocument {
  const managed = state.fleetManagedSettings;
  const ownedInstructions = new Set(ownedInstructionIds(managed));
  const instructionOriginals = managed?.instructionOriginals ?? {};
  const ownedPacks = new Set(ownedContextPackIds(managed));
  const packOriginals = managed?.contextPackOriginals ?? {};
  // A value the user changed after machdoch.cloud wrote it is their own.
  const original = (
    field: ManagedSettingsPolicyField,
    current: FleetManagedFieldValue,
  ): FleetManagedFieldValue =>
    managed?.fieldOriginals &&
    field in managed.fieldOriginals &&
    sameValue(current, managed.appliedFields?.[field])
      ? managed.fieldOriginals[field]!
      : current;
  const model = original("model", {
    provider: state.lastSelectedProvider,
    model:
      state.lastSelectedModelByProvider[state.lastSelectedProvider] ?? null,
  });
  const modelValue =
    model !== null &&
    typeof model === "object" &&
    isRuntimeProvider(model.provider)
      ? model
      : null;
  const textField = (field: ManagedSettingsPolicyField, current: unknown) => {
    const value = original(field, (current ?? null) as FleetManagedFieldValue);
    return typeof value === "string" ? value : null;
  };
  const limitField = (field: ManagedSettingsPolicyField, current: unknown) =>
    original(field, current as FleetManagedFieldValue);
  const exportedLimit = (value: FleetManagedFieldValue): number | null =>
    typeof value === "number" && Number.isInteger(value) && value >= 1
      ? value
      : null;
  return {
    ...local,
    defaults: {
      ...local.defaults,
      provider: modelValue?.provider ?? null,
      model: modelValue?.model ?? null,
      mode: textField("mode", state.lastSelectedMode) as RunMode | null,
      reasoning: textField(
        "reasoning",
        state.lastSelectedReasoning,
      ) as ReasoningMode | null,
      webSearchProvider: textField(
        "webSearchProvider",
        local.defaults.webSearchProvider,
      ) as FleetManagedSettingsDocument["defaults"]["webSearchProvider"],
      theme: textField("theme", appearance.theme) as "dark" | "light" | null,
      density: textField("density", appearance.density) as
        | "comfortable"
        | "compact"
        | null,
      accent: textField("accent", appearance.accent) as
        | "sky"
        | "emerald"
        | "violet"
        | "amber"
        | null,
    },
    agentLimits: {
      infinite: (() => {
        const value = limitField("infinite", limits.infinite);
        return typeof value === "boolean" ? value : null;
      })(),
      executorTurns: exportedLimit(
        limitField("executorTurns", limits.executorTurns),
      ),
      autopilotExecutorIterations: exportedLimit(
        limitField(
          "autopilotExecutorIterations",
          limits.autopilotExecutorIterations,
        ),
      ),
    },
    instructions: portableItems(
      local.instructions
        .filter((instruction) => !ownedInstructions.has(instruction.id))
        .map((instruction) => {
          const stored = instructionOriginals[instruction.id];
          return stored ? { ...instruction, ...stored } : instruction;
        }),
      instructionSchema,
    ),
    contextPacks: portableItems(
      state.contextPacks
        .filter((pack) => !ownedPacks.has(pack.id))
        .map((pack) => packOriginals[pack.id] ?? pack)
        .filter(
          (pack) =>
            pack.workspace === null && pack.contextAttachments.length === 0,
        )
        .map(toManagedContextPack),
      contextPackSchema,
    ),
  };
}

const toManagedContextPack = (
  pack: SmartContextPack,
): FleetManagedSettingsDocument["contextPacks"][number] => {
  // machdoch.cloud stores a provider only together with a model.
  const pinned = pack.provider && pack.model ? pack : null;
  return {
    id: pack.id,
    name: pack.name,
    instructions: pack.instructions,
    prompt: pack.prompt,
    provider: pinned?.provider ?? null,
    model: pinned?.model ?? null,
    mode: pack.mode ?? null,
    reasoning: pack.reasoning ?? null,
    ...(pack.contextWindow !== undefined
      ? { contextWindow: pack.contextWindow }
      : {}),
    ...(pack.temporary !== undefined ? { temporary: pack.temporary } : {}),
    ...(pack.useWorkspaceMemory !== undefined
      ? { useWorkspaceMemory: pack.useWorkspaceMemory }
      : {}),
    variables: pack.variables.map((variable) => ({
      name: variable.name,
      defaultValue: variable.defaultValue ?? null,
    })),
    triggerPhrases: pack.trigger.phrases,
    pathPatterns: pack.trigger.pathPatterns,
    promptEnhancementMode: pack.promptEnhancementMode ?? null,
    interviewEnabled: pack.interviewEnabled ?? null,
    sessionMemoryEnabled: pack.sessionMemoryEnabled ?? null,
    useGlobalMemory: pack.useGlobalMemory ?? null,
    uiControlEnabled: pack.uiControlEnabled ?? null,
  };
};

// State written before origin tracking has no originals and only contains
// items the cloud created.
const ownedInstructionIds = (
  managed: FleetManagedSettingsState | undefined,
): string[] =>
  managed?.ownedInstructionIds ??
  (managed?.instructionOriginals
    ? []
    : Object.values(managed?.instructionProfileIds ?? {}));

const ownedContextPackIds = (
  managed: FleetManagedSettingsState | undefined,
): string[] =>
  managed?.ownedContextPackIds ??
  (managed?.contextPackProfileIds ? [] : (managed?.contextPackIds ?? []));

const contextPackMappings = (
  managed: FleetManagedSettingsState | undefined,
  managerId: string,
): Record<string, string> => {
  if (managed?.contextPackProfileIds) return managed.contextPackProfileIds;
  const prefix = `fleet:${managerId}:`;
  return Object.fromEntries(
    (managed?.contextPackIds ?? [])
      .filter((id) => id.startsWith(prefix))
      .map((id) => [id.slice(prefix.length), id]),
  );
};

const tracksItems = (managed: FleetManagedSettingsState): boolean =>
  Object.keys(managed.instructionProfileIds).length > 0 ||
  managed.contextPackIds.length > 0 ||
  Object.keys(managed.appliedFields ?? {}).length > 0;

/**
 * Applies the delivered profile, or removes everything managed when there is
 * none. Problems with single items become warnings; items that could not be
 * restored stay tracked so the next sync tries again.
 */
export async function applyManagedSettings(
  delivery: Pick<
    FleetManagedSettingsDelivery,
    "managerId" | "profile" | "layers"
  >,
  environment: ManagedEnvironment,
): Promise<string[]> {
  const { managerId, profile } = delivery;
  const previous = currentManaged(environment.readState(), managerId);
  const base =
    previous ??
    (profile && {
      managerId,
      profileId: profile.profileId,
      revision: profile.revision,
      appliedAt: Date.now(),
      instructionProfileIds: {},
      contextPackIds: [],
      secretIds: [],
    });
  const warnings: string[] = [];
  try {
    await synchronizeFleetManagedPrompts(
      managerId,
      profile?.document.prompts ?? [],
    );
  } catch (error) {
    // Nothing else tracks prompt files, so their removal must be retried.
    if (!profile) throw error;
    warnings.push(`Prompts could not be applied: ${errorMessage(error)}`);
  }
  if (!base) return warnings;
  const document = profile
    ? supportedDocument(profile.document, warnings)
    : null;

  const instructions = await synchronizeInstructions(
    document?.instructions ?? [],
    previous,
  );
  warnings.push(...instructions.warnings);
  const instructionTracking = {
    instructionProfileIds: instructions.mappings,
    ownedInstructionIds: instructions.owned,
    instructionOriginals: instructions.originals,
  };
  // Record created and taken-over profiles before a later step can fail.
  environment.applyShellState((state) => {
    const next = {
      ...(currentManaged(state, managerId) ?? base),
      ...instructionTracking,
    };
    return recordsEqual(state.fleetManagedSettings, next)
      ? state
      : { ...state, fleetManagedSettings: next };
  });
  if (instructions.changed) await environment.refreshInstructions();
  await migrateLegacySecrets(previous, profile?.secrets ?? {});
  const fields = await synchronizeFields(document, previous, environment);
  warnings.push(...fields.warnings);
  if (profile) warnings.push(...managedMcpServerWarnings(profile));

  const identity = {
    managerId,
    profileId: profile?.profileId ?? base.profileId,
    revision: profile?.revision ?? base.revision,
  };
  const appliedAt =
    previous?.profileId === identity.profileId &&
    previous.revision === identity.revision
      ? previous.appliedAt
      : Date.now();
  let packWarnings: string[] = [];
  environment.applyShellState((state) => {
    const plan = planManagedContextPacks(
      document,
      state.contextPacks,
      managerId,
      currentManaged(state, managerId),
    );
    packWarnings = plan.warnings;
    const metadata: FleetManagedSettingsState = {
      ...identity,
      appliedAt,
      ...instructionTracking,
      contextPackIds: Object.values(plan.mappings),
      contextPackProfileIds: plan.mappings,
      ownedContextPackIds: plan.owned,
      contextPackOriginals: plan.originals,
      secretIds: [],
      fieldOriginals: fields.fieldOriginals,
      appliedFields: fields.appliedFields,
      ...(profile && delivery.layers?.length
        ? { layers: delivery.layers }
        : {}),
    };
    const next = applyManagedShellSettings(
      state,
      plan.contextPacks,
      fields.shellWrites,
      metadata,
    );
    if (profile || tracksItems(metadata)) return next;
    const cleared = { ...next };
    delete cleared.fleetManagedSettings;
    return cleared;
  });
  return [...warnings, ...packWarnings];
}

const currentManaged = (
  state: ShellPersistedState,
  managerId: string,
): FleetManagedSettingsState | undefined =>
  state.fleetManagedSettings?.managerId === managerId
    ? state.fleetManagedSettings
    : undefined;

const fieldLabels: Record<ManagedSettingsPolicyField, string> = {
  model: "The model",
  mode: "The mode",
  reasoning: "The reasoning level",
  webSearchProvider: "The web search provider",
  theme: "The theme",
  density: "The density",
  accent: "The accent color",
  infinite: "Unlimited agent turns",
  executorTurns: "The executor turn limit",
  autopilotExecutorIterations: "The autopilot iteration limit",
};

/**
 * Leaves out what this version of machdoch cannot apply, with a warning for
 * each, so newer settings never block the rest of the profile.
 */
function supportedDocument(
  document: FleetManagedSettingsDocument,
  warnings: string[],
): FleetManagedSettingsDocument {
  for (const field of managedSettingsPolicyFields) {
    if (
      managedSettingsFieldAccess[field].isSet(document) &&
      managedFieldValue(document, field) === undefined
    ) {
      warnings.push(
        `${fieldLabels[field]} from machdoch.cloud is not supported by this version of machdoch.`,
      );
    }
  }
  const contextPacks = document.contextPacks.filter((pack) => {
    const supported =
      (pack.provider === null || isRuntimeProvider(pack.provider)) &&
      (pack.provider === null) === (pack.model === null) &&
      (pack.mode === null || isRunMode(pack.mode)) &&
      (pack.reasoning === null || isReasoningMode(pack.reasoning)) &&
      (pack.promptEnhancementMode === null ||
        (["off", "simple", "web-search"] as readonly string[]).includes(
          pack.promptEnhancementMode,
        ));
    if (!supported) {
      warnings.push(
        `Context pack "${pack.name}" uses settings this version of machdoch does not support.`,
      );
    }
    return supported;
  });
  return contextPacks.length === document.contextPacks.length
    ? document
    : { ...document, contextPacks };
}

/**
 * Keys used to be copied into the user config. They are now layered on at read
 * time, so copies that still hold the managed value are removed. Copies of keys
 * the cloud no longer delivers are removed as before.
 */
async function migrateLegacySecrets(
  previous: FleetManagedSettingsState | undefined,
  secrets: Record<string, string>,
): Promise<void> {
  const legacy = previous?.secretIds ?? [];
  if (!legacy.length) return;
  const delivered = Object.fromEntries(
    legacy.flatMap((id) =>
      secrets[id] === undefined ? [] : [[id, secrets[id]!] as const],
    ),
  );
  await releaseFleetManagedApiKeys(delivered);
  for (const id of legacy.filter(
    (candidate) => secrets[candidate] === undefined,
  )) {
    if (USER_API_PROVIDERS.includes(id as UserApiKeyProvider)) {
      await deleteUserProviderApiKey(id as UserApiKeyProvider);
    } else if (
      USER_WEB_SEARCH_PROVIDERS.includes(id as UserWebSearchApiKeyProvider)
    ) {
      await deleteUserWebSearchApiKey(id as UserWebSearchApiKeyProvider);
    }
  }
}

/** The name itself, or the first free "<name> (n)" when another item uses it. */
const availableName = (name: string, taken: Iterable<string>): string => {
  const used = new Set([...taken].map(normalizeManagedItemName));
  for (let copy = 1; ; copy += 1) {
    const candidate = copy === 1 ? name : `${name} (${copy})`;
    if (!used.has(normalizeManagedItemName(candidate))) return candidate;
  }
};

interface InstructionSynchronization {
  mappings: Record<string, string>;
  owned: string[];
  originals: Record<string, FleetManagedInstructionOriginal>;
  changed: boolean;
  warnings: string[];
}

/**
 * Applies managed instructions to the local library. A local profile with the
 * same id or name is linked when identical and otherwise taken over with its
 * original content kept for restoration. Removal deletes only profiles created
 * for the cloud. A failing item becomes a warning instead of failing the sync.
 */
export async function synchronizeInstructions(
  instructions: FleetManagedSettingsDocument["instructions"],
  previous: FleetManagedSettingsState | undefined,
): Promise<InstructionSynchronization> {
  const registry = await listInstructions(null);
  if (registry.libraryError) throw new Error(registry.libraryError);
  let revision = registry.revision;
  let changed = false;
  const warnings: string[] = [];
  const previousMappings = previous?.instructionProfileIds ?? {};
  const previouslyMapped = new Set(Object.values(previousMappings));
  const owned = new Set(ownedInstructionIds(previous));
  const originals = { ...(previous?.instructionOriginals ?? {}) };
  const mappings: Record<string, string> = {};
  const profilesById = new Map(
    registry.profiles.map((profile) => [profile.id, profile]),
  );
  // Current names, including this sync's own changes.
  let names = new Map(
    registry.profiles.map((profile) => [profile.id, profile.name]),
  );
  const write = async (
    operation: "profile-create" | "profile-edit" | "profile-delete",
    profileId: string,
    content?: FleetManagedInstructionOriginal,
  ): Promise<string> => {
    try {
      const result = await mutateInstructions(null, {
        operation,
        profileId,
        ...content,
        expectedRevision: revision,
      } as InstructionMutationInput);
      revision = result.library?.revision ?? revision + 1;
      changed = true;
      const id = result.profile?.id ?? profileId;
      if (content) names.set(id, content.name);
      else names.delete(id);
      return id;
    } catch (error) {
      // Keep later items working with the library's current revision.
      const current = await listInstructions(null);
      revision = current.revision;
      names = new Map(
        current.profiles.map((profile) => [profile.id, profile.name]),
      );
      throw error;
    }
  };
  const claimed = new Set<string>();

  for (const instruction of instructions) {
    const content: FleetManagedInstructionOriginal = {
      name: instruction.name,
      body: instruction.body,
      enabled: instruction.enabled,
      global: instruction.global,
      tags: instruction.tags,
    };
    try {
      const mappedId = previousMappings[instruction.id];
      const mapped = mappedId ? profilesById.get(mappedId) : undefined;
      const target =
        mapped ??
        [
          profilesById.get(instruction.id),
          registry.profiles.find(
            (profile) =>
              normalizeManagedItemName(profile.name) ===
              normalizeManagedItemName(instruction.name),
          ),
        ].find(
          (candidate): candidate is InstructionProfileView =>
            candidate !== undefined &&
            !claimed.has(candidate.id) &&
            !previouslyMapped.has(candidate.id),
        );
      if (!target) {
        const createdId = await write(
          "profile-create",
          profilesById.has(instruction.id)
            ? crypto.randomUUID()
            : instruction.id,
          content,
        );
        mappings[instruction.id] = createdId;
        owned.add(createdId);
        claimed.add(createdId);
        continue;
      }
      claimed.add(target.id);
      mappings[instruction.id] = target.id;
      if (!instructionMatchesProfile(instruction, target)) {
        const original = owned.has(target.id)
          ? undefined
          : (originals[target.id] ?? profileContent(target));
        await write("profile-edit", target.id, content);
        if (original) originals[target.id] = original;
      }
      if (originals[target.id])
        warnings.push(
          `Instruction "${originals[target.id]!.name}" uses the machdoch.cloud version; your version returns when the profile no longer includes it.`,
        );
    } catch (error) {
      warnings.push(
        `Instruction "${instruction.name}" could not be applied: ${errorMessage(error)}`,
      );
    }
  }

  const retained = new Set(Object.values(mappings));
  for (const [managedId, localId] of Object.entries(previousMappings)) {
    if (retained.has(localId)) continue;
    const created = owned.has(localId);
    try {
      if (created) {
        if (names.has(localId)) await write("profile-delete", localId);
        owned.delete(localId);
      } else if (originals[localId]) {
        const original = originals[localId]!;
        if (names.has(localId)) {
          // The user may have created another profile with the original name.
          const others = [...names]
            .filter(([id]) => id !== localId)
            .map(([, name]) => name);
          await write("profile-edit", localId, {
            ...original,
            name: availableName(original.name, others),
          });
        }
        delete originals[localId];
      }
    } catch (error) {
      // Keep tracking the profile so the next sync tries again.
      mappings[managedId] ??= localId;
      warnings.push(
        `Instruction "${names.get(localId) ?? localId}" could not be ${created ? "removed" : "restored"}: ${errorMessage(error)}`,
      );
    }
  }
  const tracked = new Set(Object.values(mappings));
  for (const id of [...owned]) if (!tracked.has(id)) owned.delete(id);
  for (const id of Object.keys(originals))
    if (!tracked.has(id)) delete originals[id];
  return {
    mappings,
    owned: [...owned],
    originals,
    changed,
    warnings,
  };
}

const profileContent = (
  profile: InstructionProfileView,
): FleetManagedInstructionOriginal => ({
  name: profile.name,
  body: profile.body ?? "",
  enabled: profile.enabled,
  global: profile.global,
  tags: [...profile.tags],
});

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

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

interface ContextPackPlan {
  contextPacks: SmartContextPack[];
  mappings: Record<string, string>;
  owned: string[];
  originals: Record<string, SmartContextPack>;
  warnings: string[];
}

/**
 * Plans the context pack list. Managed packs link to identical global local
 * packs with the same name, take over different ones (keeping the original
 * for restoration), and are otherwise created as `fleet:<manager>:<id>`.
 */
export function planManagedContextPacks(
  document: FleetManagedSettingsDocument | null,
  currentPacks: SmartContextPack[],
  managerId: string,
  previous: FleetManagedSettingsState | undefined,
): ContextPackPlan {
  const previousMappings = contextPackMappings(previous, managerId);
  const owned = new Set(ownedContextPackIds(previous));
  const originals = { ...(previous?.contextPackOriginals ?? {}) };
  const byId = new Map(currentPacks.map((pack) => [pack.id, pack]));
  const replaced = new Map<string, SmartContextPack>();
  const managedOrder: string[] = [];
  const mappings: Record<string, string> = {};
  const warnings: string[] = [];
  const claimed = new Set<string>();
  const previouslyMapped = new Set(Object.values(previousMappings));
  const timestamp = Date.now();
  const eligible = (pack: SmartContextPack): boolean =>
    pack.workspace === null && pack.contextAttachments.length === 0;

  for (const [index, pack] of (document?.contextPacks ?? []).entries()) {
    const ownedId = `fleet:${managerId}:${pack.id}`;
    const mappedId = previousMappings[pack.id];
    let target = mappedId ? byId.get(mappedId) : undefined;
    if (!target) {
      target = [
        byId.get(pack.id),
        currentPacks.find(
          (candidate) =>
            normalizeManagedItemName(candidate.name) ===
            normalizeManagedItemName(pack.name),
        ),
      ].find(
        (candidate): candidate is SmartContextPack =>
          candidate !== undefined &&
          eligible(candidate) &&
          !claimed.has(candidate.id) &&
          !previouslyMapped.has(candidate.id),
      );
    }
    if (!target && byId.has(ownedId) && !owned.has(ownedId)) {
      warnings.push(
        `Context pack "${pack.name}" could not be applied because a local pack uses its id.`,
      );
      continue;
    }
    const id = target?.id ?? ownedId;
    if (!target) owned.add(id);
    claimed.add(id);
    mappings[pack.id] = id;
    managedOrder.push(id);
    const existing = target ?? byId.get(id);
    const desired = createManagedContextPack(
      pack,
      id,
      existing,
      timestamp + index,
    );
    const matches =
      existing !== undefined && managedPackContentMatches(existing, desired);
    if (existing && !matches && !owned.has(id) && !originals[id])
      originals[id] = existing;
    if (originals[id])
      warnings.push(
        `Context pack "${originals[id]!.name}" uses the machdoch.cloud version; your version returns when the profile no longer includes it.`,
      );
    replaced.set(id, matches ? existing : desired);
  }

  const retained = new Set(Object.values(mappings));
  const removed = new Set<string>();
  const restored = new Set<string>();
  for (const id of previouslyMapped) {
    if (retained.has(id)) continue;
    if (owned.has(id)) {
      removed.add(id);
      owned.delete(id);
    } else if (originals[id]) {
      replaced.set(id, originals[id]!);
      restored.add(id);
      delete originals[id];
    }
  }
  for (const id of [...owned]) if (!retained.has(id)) owned.delete(id);
  for (const id of Object.keys(originals))
    if (!retained.has(id)) delete originals[id];

  const managedPacks = managedOrder.map((id) => replaced.get(id)!);
  const managedIds = new Set(managedOrder);
  const combined = [
    ...managedPacks,
    ...currentPacks
      .filter((pack) => !managedIds.has(pack.id) && !removed.has(pack.id))
      .map((pack) => replaced.get(pack.id) ?? pack),
  ];
  // The user may have created another pack with a restored pack's name.
  const contextPacks = combined.map((pack) => {
    if (!restored.has(pack.id)) return pack;
    const name = availableName(
      pack.name,
      combined
        .filter((other) => other.id !== pack.id)
        .map((other) => other.name),
    );
    return name === pack.name ? pack : { ...pack, name };
  });
  return {
    contextPacks:
      contextPacks.length === currentPacks.length &&
      contextPacks.every((pack, index) => pack === currentPacks[index])
        ? currentPacks
        : contextPacks,
    mappings,
    owned: [...owned],
    originals,
    warnings,
  };
}

function createManagedContextPack(
  pack: FleetManagedSettingsDocument["contextPacks"][number],
  id: string,
  current: SmartContextPack | undefined,
  timestamp: number,
): SmartContextPack {
  const provider = isRuntimeProvider(pack.provider) ? pack.provider : null;
  const mode = isRunMode(pack.mode) ? pack.mode : null;
  const reasoning = isReasoningMode(pack.reasoning) ? pack.reasoning : null;
  return {
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
    createdAt: current?.createdAt ?? timestamp,
    updatedAt: timestamp,
    ...(current?.lastUsedAt === undefined
      ? {}
      : { lastUsedAt: current.lastUsedAt }),
    useCount: current?.useCount ?? 0,
    ...(provider ? { provider } : {}),
    ...(pack.model ? { model: pack.model } : {}),
    ...(mode ? { mode } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(pack.contextWindow !== undefined
      ? { contextWindow: pack.contextWindow }
      : {}),
    ...(pack.temporary !== undefined ? { temporary: pack.temporary } : {}),
    ...(pack.useWorkspaceMemory !== undefined
      ? { useWorkspaceMemory: pack.useWorkspaceMemory }
      : {}),
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
}

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
  current.contextWindow === desired.contextWindow &&
  current.temporary === desired.temporary &&
  current.useWorkspaceMemory === desired.useWorkspaceMemory &&
  current.promptEnhancementMode === desired.promptEnhancementMode &&
  current.interviewEnabled === desired.interviewEnabled &&
  current.sessionMemoryEnabled === desired.sessionMemoryEnabled &&
  current.useGlobalMemory === desired.useGlobalMemory &&
  current.uiControlEnabled === desired.uiControlEnabled;

type ShellField = "model" | "mode" | "reasoning";
type ShellWrites = Partial<Record<ShellField, FleetManagedFieldValue>>;

export interface FieldSnapshot {
  state: ShellPersistedState;
  appearance: AppearanceSettings;
  webSearchProvider: WebSearchProvider;
  agentLimits: UserAgentLimitsSettings;
}

export interface FieldPlan {
  writes: Partial<Record<ManagedSettingsPolicyField, FleetManagedFieldValue>>;
  fieldOriginals: Record<string, FleetManagedFieldValue>;
  appliedFields: Record<string, FleetManagedFieldValue>;
}

const readLocalField = (
  field: ManagedSettingsPolicyField,
  snapshot: FieldSnapshot,
): FleetManagedFieldValue => {
  const { state } = snapshot;
  switch (field) {
    case "model":
      return {
        provider: state.lastSelectedProvider,
        model:
          state.lastSelectedModelByProvider[state.lastSelectedProvider] ?? null,
      };
    case "mode":
      return state.lastSelectedMode ?? null;
    case "reasoning":
      return state.lastSelectedReasoning ?? null;
    case "webSearchProvider":
      return snapshot.webSearchProvider;
    case "theme":
    case "density":
    case "accent":
      return snapshot.appearance[field];
    case "infinite":
    case "executorTurns":
    case "autopilotExecutorIterations":
      return snapshot.agentLimits[field];
  }
};

const managedFieldValue = (
  document: FleetManagedSettingsDocument,
  field: ManagedSettingsPolicyField,
): FleetManagedFieldValue | undefined => {
  const { defaults, agentLimits } = document;
  switch (field) {
    case "model":
      return isRuntimeProvider(defaults.provider)
        ? { provider: defaults.provider, model: defaults.model ?? null }
        : undefined;
    case "mode":
      return isRunMode(defaults.mode) ? defaults.mode : undefined;
    case "reasoning":
      return isReasoningMode(defaults.reasoning)
        ? defaults.reasoning
        : undefined;
    case "webSearchProvider":
      return defaults.webSearchProvider !== null &&
        ["none", ...USER_WEB_SEARCH_PROVIDERS].includes(
          defaults.webSearchProvider,
        )
        ? defaults.webSearchProvider
        : undefined;
    case "theme":
      return defaults.theme === "dark" || defaults.theme === "light"
        ? defaults.theme
        : undefined;
    case "density":
      return defaults.density === "comfortable" ||
        defaults.density === "compact"
        ? defaults.density
        : undefined;
    case "accent":
      return defaults.accent === "sky" ||
        defaults.accent === "emerald" ||
        defaults.accent === "violet" ||
        defaults.accent === "amber"
        ? defaults.accent
        : undefined;
    case "infinite":
    case "executorTurns":
    case "autopilotExecutorIterations":
      return agentLimits[field] ?? undefined;
  }
};

const sameValue = (
  left: FleetManagedFieldValue | undefined,
  right: FleetManagedFieldValue | undefined,
): boolean => {
  if (
    left !== null &&
    right !== null &&
    typeof left === "object" &&
    typeof right === "object"
  ) {
    // A managed provider without a model accepts any local model.
    return (
      left.provider === right.provider &&
      (left.model === right.model || right.model === null)
    );
  }
  return JSON.stringify(left) === JSON.stringify(right);
};

/**
 * Decides which scalar settings to write. Enforced values are restored every
 * sync; defaults are written only when the managed value changes, so local
 * choices stick. The user's value before the first write is kept and restored
 * when the field stops being managed, unless the user changed it since.
 */
export function planManagedFields(
  document: FleetManagedSettingsDocument | null,
  snapshot: FieldSnapshot,
  previous: FleetManagedSettingsState | undefined,
): FieldPlan {
  const fieldOriginals = { ...(previous?.fieldOriginals ?? {}) };
  const appliedFields = { ...(previous?.appliedFields ?? {}) };
  const writes: FieldPlan["writes"] = {};
  for (const field of managedSettingsPolicyFields) {
    const managed = document ? managedFieldValue(document, field) : undefined;
    const current = readLocalField(field, snapshot);
    if (managed !== undefined) {
      const enforced = isManagedSettingEnforced(document!, field);
      const changedUpstream = !(field in appliedFields)
        ? true
        : !sameValue(appliedFields[field], managed);
      if (!sameValue(current, managed) && (enforced || changedUpstream)) {
        if (!(field in fieldOriginals)) fieldOriginals[field] = current;
        writes[field] = managed;
      }
      appliedFields[field] = managed;
      continue;
    }
    if (field in appliedFields) {
      if (field in fieldOriginals && sameValue(current, appliedFields[field])) {
        writes[field] = fieldOriginals[field]!;
      }
      delete appliedFields[field];
      delete fieldOriginals[field];
    }
  }
  return { writes, fieldOriginals, appliedFields };
}

const restoreEntry = <T>(
  target: Record<string, T>,
  source: Record<string, T> | undefined,
  key: string,
): void => {
  if (source && key in source) target[key] = source[key]!;
  else delete target[key];
};

async function synchronizeFields(
  document: FleetManagedSettingsDocument | null,
  previous: FleetManagedSettingsState | undefined,
  environment: ManagedEnvironment,
): Promise<FieldPlan & { shellWrites: ShellWrites; warnings: string[] }> {
  const [appearance, webSearch, agentLimits] = await Promise.all([
    loadAppearanceSettings(),
    loadUserWebSearchSettings(),
    loadUserAgentLimitsSettings(),
  ]);
  const plan = planManagedFields(
    document,
    {
      state: environment.readState(),
      appearance,
      webSearchProvider: webSearch.activeProvider,
      agentLimits,
    },
    previous,
  );
  const { writes } = plan;
  const warnings: string[] = [];
  const attempt = async (
    label: string,
    fields: readonly ManagedSettingsPolicyField[],
    save: () => Promise<void>,
  ): Promise<void> => {
    if (!fields.some((field) => field in writes)) return;
    try {
      await save();
    } catch (error) {
      warnings.push(`${label} could not be applied: ${errorMessage(error)}`);
      // Unchanged tracking makes the next sync try again.
      for (const field of fields) {
        restoreEntry(plan.fieldOriginals, previous?.fieldOriginals, field);
        restoreEntry(plan.appliedFields, previous?.appliedFields, field);
      }
    }
  };
  await attempt(
    "Appearance settings",
    ["theme", "density", "accent"],
    async () => {
      const next = { ...appearance };
      for (const field of ["theme", "density", "accent"] as const) {
        if (typeof writes[field] === "string")
          Object.assign(next, { [field]: writes[field] });
      }
      if (!recordsEqual(next, appearance))
        await saveAppearanceSettings(next, appearance);
    },
  );
  await attempt("The web search provider", ["webSearchProvider"], async () => {
    const provider = writes.webSearchProvider;
    if (typeof provider === "string" && provider !== webSearch.activeProvider)
      await saveUserWebSearchActiveProvider(provider as WebSearchProvider);
  });
  await attempt(
    "Agent limits",
    ["infinite", "executorTurns", "autopilotExecutorIterations"],
    async () => {
      const next = { ...agentLimits };
      if (typeof writes.infinite === "boolean") next.infinite = writes.infinite;
      for (const field of [
        "executorTurns",
        "autopilotExecutorIterations",
      ] as const)
        if (typeof writes[field] === "number")
          next[field] = writes[field] as number;
      if (!recordsEqual(next, agentLimits))
        environment.applyLoadedAgentLimits(
          await saveUserAgentLimitsSettings(next),
        );
    },
  );
  const shellWrites: ShellWrites = {};
  for (const field of ["model", "mode", "reasoning"] as const)
    if (field in writes) shellWrites[field] = writes[field]!;
  return { ...plan, shellWrites, warnings };
}

export function applyManagedShellSettings(
  state: ShellPersistedState,
  contextPacks: SmartContextPack[],
  writes: ShellWrites,
  metadata: FleetManagedSettingsState | undefined,
): ShellPersistedState {
  const next: ShellPersistedState = {
    ...state,
    contextPacks,
    ...(metadata ? { fleetManagedSettings: metadata } : {}),
  };
  const model = writes.model;
  if (
    model !== null &&
    typeof model === "object" &&
    isRuntimeProvider(model.provider)
  ) {
    next.lastSelectedProvider = model.provider;
    if (
      model.model &&
      next.lastSelectedModelByProvider[model.provider] !== model.model
    ) {
      next.lastSelectedModelByProvider = {
        ...next.lastSelectedModelByProvider,
        [model.provider]: model.model,
      };
    }
  }
  if ("mode" in writes) {
    if (isRunMode(writes.mode ?? null))
      next.lastSelectedMode = writes.mode as RunMode;
    else delete next.lastSelectedMode;
  }
  if ("reasoning" in writes) {
    if (isReasoningMode(writes.reasoning ?? null)) {
      next.lastSelectedReasoning = normalizeReasoningModeForProvider(
        writes.reasoning as ReasoningMode,
        next.lastSelectedProvider,
        next.lastSelectedModelByProvider[next.lastSelectedProvider],
      );
    } else {
      delete next.lastSelectedReasoning;
    }
  }
  return shellManagedStateMatches(state, next) ? state : next;
}

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

const isRunMode = (value: unknown): value is RunMode =>
  typeof value === "string" && RUN_MODES.includes(value as RunMode);

const isReasoningMode = (value: unknown): value is ReasoningMode =>
  typeof value === "string" && REASONING_MODES.includes(value as ReasoningMode);
