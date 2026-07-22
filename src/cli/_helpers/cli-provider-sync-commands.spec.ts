import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadProviderEnrollmentConfig: vi.fn(),
  setPersistentProviderSyncEnabled: vi.fn(),
  getProviderSyncDaemonPid: vi.fn(),
  requestProviderSyncRefresh: vi.fn(),
  runProviderSyncDaemon: vi.fn(),
  createProviderSyncPlan: vi.fn(),
  doctorProviderSync: vi.fn(),
  loadProviderSyncStatus: vi.fn(),
  reconcileProviderSync: vi.fn(),
  registerProviderSyncWorkspace: vi.fn(),
  uninstallProviderSyncTargets: vi.fn(),
  installProviderSyncAutostart: vi.fn(),
  isProviderSyncAutostartInstalled: vi.fn(),
  removeProviderSyncAutostart: vi.fn(),
  cleanupProviderNativeState: vi.fn(),
}));

vi.mock("../../core/provider-enrollment/config.js", () => ({
  loadProviderEnrollmentConfig: mocks.loadProviderEnrollmentConfig,
  setPersistentProviderSyncEnabled: mocks.setPersistentProviderSyncEnabled,
}));

vi.mock("../../core/provider-enrollment/sync-daemon.js", () => ({
  getProviderSyncDaemonPid: mocks.getProviderSyncDaemonPid,
  requestProviderSyncRefresh: mocks.requestProviderSyncRefresh,
  runProviderSyncDaemon: mocks.runProviderSyncDaemon,
}));

vi.mock("../../core/provider-enrollment/sync-coordinator.js", () => ({
  createProviderSyncPlan: mocks.createProviderSyncPlan,
  doctorProviderSync: mocks.doctorProviderSync,
  loadProviderSyncStatus: mocks.loadProviderSyncStatus,
  reconcileProviderSync: mocks.reconcileProviderSync,
  registerProviderSyncWorkspace: mocks.registerProviderSyncWorkspace,
  uninstallProviderSyncTargets: mocks.uninstallProviderSyncTargets,
}));

vi.mock("../../core/provider-enrollment/platform-autostart.js", () => ({
  installProviderSyncAutostart: mocks.installProviderSyncAutostart,
  isProviderSyncAutostartInstalled: mocks.isProviderSyncAutostartInstalled,
  removeProviderSyncAutostart: mocks.removeProviderSyncAutostart,
}));

vi.mock("../../core/provider-enrollment/provider-native-cleanup.js", () => ({
  cleanupProviderNativeState: mocks.cleanupProviderNativeState,
}));

import {
  ensureAutomaticProviderSync,
  printProviderSyncSummary,
} from "./cli-provider-sync-commands.ts";
import type { ParsedCliArgs } from "./cli-args.js";

const createConfig = (watch: boolean) => ({
  schemaVersion: 1,
  enabled: true,
  instructions: {
    mode: "native-when-available",
    unmanagedNative: "adopt",
    strictConflicts: false,
    fallback: "automatic",
    failOnTruncation: false,
  },
  mcp: {
    mode: "direct-native",
    fallback: "per-server-stdio-proxy",
    compatibilityServerName: "machdoch-compat",
    unmanagedNative: "allow",
    approvals: "never",
    progressiveDiscoveryThresholdPercent: 3,
  },
  persistentSync: {
    enabled: true,
    watch,
    daemonAtLogin: false,
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
});

describe("automatic provider sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isProviderSyncAutostartInstalled.mockResolvedValue(false);
    mocks.requestProviderSyncRefresh.mockResolvedValue(undefined);
    mocks.reconcileProviderSync.mockResolvedValue({});
    mocks.registerProviderSyncWorkspace.mockResolvedValue(undefined);
    mocks.uninstallProviderSyncTargets.mockResolvedValue([]);
    mocks.cleanupProviderNativeState.mockResolvedValue({
      removedInstructionFiles: [],
      cleanedMcpFiles: [],
      backupFiles: [],
    });
    mocks.removeProviderSyncAutostart.mockResolvedValue(undefined);
  });

  it("does not reconcile or start services while persistent sync is disabled", async () => {
    const config = createConfig(true);
    mocks.loadProviderEnrollmentConfig.mockResolvedValue({
      ...config,
      persistentSync: { ...config.persistentSync, enabled: false },
    });

    await ensureAutomaticProviderSync("C:\\workspace");

    expect(mocks.reconcileProviderSync).not.toHaveBeenCalled();
    expect(mocks.registerProviderSyncWorkspace).not.toHaveBeenCalled();
    expect(mocks.requestProviderSyncRefresh).not.toHaveBeenCalled();
  });

  it("delegates refresh to a running daemon instead of reconciling concurrently", async () => {
    mocks.loadProviderEnrollmentConfig.mockResolvedValue(createConfig(true));
    mocks.getProviderSyncDaemonPid.mockResolvedValue(4321);

    await ensureAutomaticProviderSync("C:\\workspace");

    expect(mocks.requestProviderSyncRefresh).toHaveBeenCalledOnce();
    expect(mocks.registerProviderSyncWorkspace).toHaveBeenCalledWith(
      "C:\\workspace",
    );
    expect(mocks.reconcileProviderSync).not.toHaveBeenCalled();
  });

  it("reconciles directly when persistent watching is disabled", async () => {
    mocks.loadProviderEnrollmentConfig.mockResolvedValue(createConfig(false));

    await ensureAutomaticProviderSync("C:\\workspace");

    expect(mocks.getProviderSyncDaemonPid).not.toHaveBeenCalled();
    expect(mocks.requestProviderSyncRefresh).not.toHaveBeenCalled();
    expect(mocks.reconcileProviderSync).toHaveBeenCalledWith("C:\\workspace");
  });

  it("cleans provider-native state before the first enabled reconciliation", async () => {
    const disabledConfig = createConfig(false);
    disabledConfig.persistentSync.enabled = false;
    const enabledConfig = createConfig(false);
    mocks.loadProviderEnrollmentConfig.mockResolvedValue(disabledConfig);
    mocks.setPersistentProviderSyncEnabled.mockResolvedValue(enabledConfig);
    mocks.reconcileProviderSync.mockResolvedValue({
      schemaVersion: 1,
      enabled: true,
      daemon: { running: false, autostartInstalled: false },
      workspaceRoot: "C:\\workspace",
      targets: [],
    });

    await printProviderSyncSummary({
      command: "provider-sync",
      workspaceRoot: "C:\\workspace",
      json: true,
      providerSync: { action: "enable" },
    } as ParsedCliArgs);

    expect(mocks.uninstallProviderSyncTargets).toHaveBeenCalledOnce();
    expect(mocks.cleanupProviderNativeState).toHaveBeenCalledWith("C:\\workspace");
    expect(mocks.setPersistentProviderSyncEnabled).toHaveBeenCalledWith(true);
    expect(mocks.reconcileProviderSync).toHaveBeenCalledWith("C:\\workspace");
    expect(
      mocks.cleanupProviderNativeState.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.reconcileProviderSync.mock.invocationCallOrder[0]!);
  });
});
