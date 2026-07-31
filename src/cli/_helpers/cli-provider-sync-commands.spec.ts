import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadProviderEnrollmentConfig: vi.fn(),
  setPersistentProviderSyncEnabled: vi.fn(),
  getCurrentProviderSyncDaemonPid: vi.fn(),
  getProviderSyncDaemonPid: vi.fn(),
  requestProviderSyncRefresh: vi.fn(),
  runProviderSyncDaemon: vi.fn(),
  stopProviderSyncDaemon: vi.fn(),
  createProviderSyncPlan: vi.fn(),
  doctorProviderSync: vi.fn(),
  loadProviderSyncStatus: vi.fn(),
  reconcileProviderSync: vi.fn(),
  registerProviderSyncWorkspace: vi.fn(),
  uninstallProviderSyncTargets: vi.fn(),
  installProviderSyncAutostart: vi.fn(),
  isProviderSyncAutostartInstalled: vi.fn(),
  removeProviderSyncAutostart: vi.fn(),
}));

vi.mock("../../core/provider-enrollment/config.js", () => ({
  loadProviderEnrollmentConfig: mocks.loadProviderEnrollmentConfig,
  setPersistentProviderSyncEnabled: mocks.setPersistentProviderSyncEnabled,
}));

vi.mock("../../core/provider-enrollment/sync-daemon.js", () => ({
  getCurrentProviderSyncDaemonPid:
    mocks.getCurrentProviderSyncDaemonPid,
  getProviderSyncDaemonPid: mocks.getProviderSyncDaemonPid,
  requestProviderSyncRefresh: mocks.requestProviderSyncRefresh,
  runProviderSyncDaemon: mocks.runProviderSyncDaemon,
  stopProviderSyncDaemon: mocks.stopProviderSyncDaemon,
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

import {
  ensureAutomaticProviderSync,
  printProviderSyncSummary,
} from "./cli-provider-sync-commands.ts";
import type { ParsedCliArgs } from "./cli-args.js";

const createConfig = (watch: boolean) => ({
  schemaVersion: 1,
  enabled: true,
  mcp: {
    unmanagedNative: "allow",
    approvals: "never",
  },
  persistentSync: {
    enabled: true,
    watch,
    daemonAtLogin: false,
    debounceMs: 500,
    fullRescanIntervalMs: 600_000,
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
    mocks.getCurrentProviderSyncDaemonPid.mockResolvedValue(undefined);
    mocks.getProviderSyncDaemonPid.mockResolvedValue(undefined);
    mocks.requestProviderSyncRefresh.mockResolvedValue(undefined);
    mocks.reconcileProviderSync.mockResolvedValue({});
    mocks.registerProviderSyncWorkspace.mockResolvedValue(undefined);
    mocks.uninstallProviderSyncTargets.mockResolvedValue([]);
    mocks.removeProviderSyncAutostart.mockResolvedValue(undefined);
    mocks.stopProviderSyncDaemon.mockResolvedValue(false);
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

  it("stops a stale daemon while persistent sync is disabled", async () => {
    const config = createConfig(true);
    mocks.loadProviderEnrollmentConfig.mockResolvedValue({
      ...config,
      persistentSync: { ...config.persistentSync, enabled: false },
    });
    mocks.getProviderSyncDaemonPid.mockResolvedValue(4321);
    mocks.isProviderSyncAutostartInstalled.mockResolvedValue(true);
    mocks.stopProviderSyncDaemon.mockResolvedValue(true);

    await ensureAutomaticProviderSync("C:\\workspace");

    expect(mocks.stopProviderSyncDaemon).toHaveBeenCalledOnce();
    expect(mocks.removeProviderSyncAutostart).toHaveBeenCalledOnce();
    expect(mocks.reconcileProviderSync).not.toHaveBeenCalled();
  });

  it("delegates refresh to a running daemon instead of reconciling concurrently", async () => {
    mocks.loadProviderEnrollmentConfig.mockResolvedValue(createConfig(true));
    mocks.getCurrentProviderSyncDaemonPid.mockResolvedValue(4321);

    await ensureAutomaticProviderSync("C:\\workspace");

    expect(mocks.stopProviderSyncDaemon).toHaveBeenCalledWith({
      onlyIfRuntimeMismatch: true,
    });
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

  it("enables MCP reconciliation without filename-based instruction cleanup", async () => {
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
    expect(mocks.setPersistentProviderSyncEnabled).toHaveBeenCalledWith(true);
    expect(mocks.reconcileProviderSync).toHaveBeenCalledWith("C:\\workspace");
    expect(
      mocks.setPersistentProviderSyncEnabled.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.reconcileProviderSync.mock.invocationCallOrder[0]!);
  });
});
