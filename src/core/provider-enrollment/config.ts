import { readFile } from "node:fs/promises";
import { getUserConfigPath } from "../env.js";
import { withCooperativeFileLock } from "../_helpers/with-cooperative-file-lock.helper.js";
import { writeJsonAtomically } from "../_helpers/write-file-atomically.helper.js";
import type {
  ProviderEnrollmentConfigFile,
  UserConfigFile,
} from "../runtime-contract.generated.js";
import {
  PROVIDER_ENROLLMENT_SCHEMA_VERSION,
  type ProviderEnrollmentConfig,
} from "./types.js";

export const DEFAULT_PROVIDER_ENROLLMENT_CONFIG: ProviderEnrollmentConfig = {
  schemaVersion: PROVIDER_ENROLLMENT_SCHEMA_VERSION,
  enabled: true,
  mcp: {
    mode: "direct-native",
    fallback: "per-server-stdio-proxy",
    compatibilityServerName: "machdoch-compat",
    unmanagedNative: "allow",
    approvals: "never",
    progressiveDiscoveryThresholdPercent: 3,
  },
  persistentSync: {
    enabled: false,
    watch: true,
    daemonAtLogin: true,
    debounceMs: 500,
    filesystemConvergenceTargetMs: 2_000,
    fullRescanIntervalMs: 600_000,
    autoReloadOwnedSessions: true,
  },
  providers: {
    "codex-cli": { enabled: true },
    "claude-cli": { enabled: true },
    "copilot-cli": { enabled: true },
  },
};

const clampInteger = (
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
};

export const normalizeProviderEnrollmentConfig = (
  value: ProviderEnrollmentConfigFile | undefined,
): ProviderEnrollmentConfig => ({
  schemaVersion: PROVIDER_ENROLLMENT_SCHEMA_VERSION,
  enabled: value?.enabled ?? DEFAULT_PROVIDER_ENROLLMENT_CONFIG.enabled,
  mcp: {
    mode: "direct-native",
    fallback: "per-server-stdio-proxy",
    compatibilityServerName:
      value?.mcp?.compatibilityServerName?.trim() ||
      DEFAULT_PROVIDER_ENROLLMENT_CONFIG.mcp.compatibilityServerName,
    unmanagedNative:
      value?.mcp?.unmanagedNative ??
      DEFAULT_PROVIDER_ENROLLMENT_CONFIG.mcp.unmanagedNative,
    approvals: "never",
    progressiveDiscoveryThresholdPercent: clampInteger(
      value?.mcp?.progressiveDiscoveryThresholdPercent,
      DEFAULT_PROVIDER_ENROLLMENT_CONFIG.mcp
        .progressiveDiscoveryThresholdPercent,
      1,
      5,
    ),
  },
  persistentSync: {
    enabled:
      value?.persistentSync?.enabled ??
      DEFAULT_PROVIDER_ENROLLMENT_CONFIG.persistentSync.enabled,
    watch:
      value?.persistentSync?.watch ??
      DEFAULT_PROVIDER_ENROLLMENT_CONFIG.persistentSync.watch,
    daemonAtLogin:
      value?.persistentSync?.daemonAtLogin ??
      DEFAULT_PROVIDER_ENROLLMENT_CONFIG.persistentSync.daemonAtLogin,
    debounceMs: clampInteger(
      value?.persistentSync?.debounceMs,
      DEFAULT_PROVIDER_ENROLLMENT_CONFIG.persistentSync.debounceMs,
      50,
      60_000,
    ),
    filesystemConvergenceTargetMs: clampInteger(
      value?.persistentSync?.filesystemConvergenceTargetMs,
      DEFAULT_PROVIDER_ENROLLMENT_CONFIG.persistentSync
        .filesystemConvergenceTargetMs,
      100,
      60_000,
    ),
    fullRescanIntervalMs: clampInteger(
      value?.persistentSync?.fullRescanIntervalMs,
      DEFAULT_PROVIDER_ENROLLMENT_CONFIG.persistentSync.fullRescanIntervalMs,
      10_000,
      86_400_000,
    ),
    autoReloadOwnedSessions:
      value?.persistentSync?.autoReloadOwnedSessions ??
      DEFAULT_PROVIDER_ENROLLMENT_CONFIG.persistentSync.autoReloadOwnedSessions,
  },
  providers: {
    "codex-cli": {
      enabled:
        value?.providers?.["codex-cli"]?.enabled ??
        DEFAULT_PROVIDER_ENROLLMENT_CONFIG.providers["codex-cli"].enabled,
    },
    "claude-cli": {
      enabled:
        value?.providers?.["claude-cli"]?.enabled ??
        DEFAULT_PROVIDER_ENROLLMENT_CONFIG.providers["claude-cli"].enabled,
    },
    "copilot-cli": {
      enabled:
        value?.providers?.["copilot-cli"]?.enabled ??
        DEFAULT_PROVIDER_ENROLLMENT_CONFIG.providers["copilot-cli"].enabled,
    },
  },
});

const loadUserConfig = async (): Promise<UserConfigFile> => {
  try {
    return JSON.parse(
      await readFile(getUserConfigPath(), "utf8"),
    ) as UserConfigFile;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return {};
    }
    throw error;
  }
};

export const loadProviderEnrollmentConfig =
  async (): Promise<ProviderEnrollmentConfig> => {
    const userConfig = await loadUserConfig();
    return normalizeProviderEnrollmentConfig(userConfig.providerEnrollment);
  };

export const saveProviderEnrollmentConfig = async (
  config: ProviderEnrollmentConfig,
): Promise<string> => {
  const path = getUserConfigPath();
  await withCooperativeFileLock(path, async () => {
    const userConfig = await loadUserConfig();
    await writeJsonAtomically(path, {
      ...userConfig,
      providerEnrollment: config,
    } satisfies UserConfigFile);
  });
  return path;
};

export const setPersistentProviderSyncEnabled = async (
  enabled: boolean,
): Promise<ProviderEnrollmentConfig> => {
  const path = getUserConfigPath();
  let updated: ProviderEnrollmentConfig | undefined;
  await withCooperativeFileLock(path, async () => {
    const userConfig = await loadUserConfig();
    const config = normalizeProviderEnrollmentConfig(
      userConfig.providerEnrollment,
    );
    updated = {
      ...config,
      enabled: enabled ? true : config.enabled,
      persistentSync: {
        ...config.persistentSync,
        enabled,
      },
    };
    await writeJsonAtomically(path, {
      ...userConfig,
      providerEnrollment: updated,
    } satisfies UserConfigFile);
  });
  if (!updated) {
    throw new Error("Provider sync configuration update did not complete.");
  }
  return updated;
};
