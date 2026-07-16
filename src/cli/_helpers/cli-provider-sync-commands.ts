import { spawn } from "node:child_process";
import process from "node:process";
import {
  loadProviderEnrollmentConfig,
  setPersistentProviderSyncEnabled,
} from "../../core/provider-enrollment/config.js";
import {
  getProviderSyncDaemonPid,
  requestProviderSyncRefresh,
  runProviderSyncDaemon,
} from "../../core/provider-enrollment/sync-daemon.js";
import {
  createProviderSyncPlan,
  doctorProviderSync,
  loadProviderSyncStatus,
  reconcileProviderSync,
  uninstallProviderSyncTargets,
} from "../../core/provider-enrollment/sync-coordinator.js";
import {
  installProviderSyncAutostart,
  isProviderSyncAutostartInstalled,
  removeProviderSyncAutostart,
} from "../../core/provider-enrollment/platform-autostart.js";
import type { ParsedCliArgs, ProviderSyncCliOptions } from "./cli-args.js";
import { writeStdoutLine } from "./cli-io.js";

const fail = (message: string): never => {
  throw new Error(message);
};

const printJson = (value: unknown): void => {
  writeStdoutLine(JSON.stringify(value, null, 2));
};

const startDaemon = async (workspaceRoot: string): Promise<number | undefined> => {
  const existing = await getProviderSyncDaemonPid();
  if (existing) return existing;
  const script = process.argv[1];
  if (!script) return undefined;
  const child = spawn(
    process.execPath,
    [
      ...process.execArgv,
      script,
      "provider-sync",
      "daemon",
      "--cwd",
      workspaceRoot,
    ],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: process.env,
    },
  );
  child.unref();
  return child.pid;
};

const stopDaemon = async (): Promise<void> => {
  const pid = await getProviderSyncDaemonPid();
  if (!pid || pid === process.pid) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // A daemon that exited between the status read and signal is already stopped.
  }
};

const printStatusLines = (
  status: Awaited<ReturnType<typeof loadProviderSyncStatus>>,
): void => {
  writeStdoutLine(`provider sync: ${status.enabled ? "enabled" : "disabled"}`);
  writeStdoutLine(
    `daemon: ${status.daemon.running ? `running pid=${status.daemon.pid ?? "unknown"}` : "stopped"}`,
  );
  writeStdoutLine(
    `autostart: ${status.daemon.autostartInstalled ? "installed" : "not installed"}`,
  );
  if (status.lastReconciledAt) {
    writeStdoutLine(`last reconciled: ${status.lastReconciledAt}`);
  }
  for (const target of status.targets) {
    writeStdoutLine(
      `- ${target.provider} ${target.scope}: ${target.state}${target.bundleDigest ? ` bundle=${target.bundleDigest}` : ""}`,
    );
    for (const warning of target.warnings) writeStdoutLine(`  warning: ${warning}`);
    if (target.error) writeStdoutLine(`  error: ${target.error}`);
  }
};

export const ensureAutomaticProviderSync = async (
  workspaceRoot: string,
): Promise<void> => {
  const config = await loadProviderEnrollmentConfig();
  if (!config.enabled || !config.persistentSync.enabled) return;
  if (
    config.persistentSync.daemonAtLogin &&
    !(await isProviderSyncAutostartInstalled())
  ) {
    await installProviderSyncAutostart(workspaceRoot);
  }
  await reconcileProviderSync(workspaceRoot);
  if (config.persistentSync.watch) {
    await startDaemon(workspaceRoot);
  }
};

export const printProviderSyncSummary = async (
  args: ParsedCliArgs,
): Promise<void> => {
  const options: ProviderSyncCliOptions =
    args.providerSync ?? fail("No provider-sync action was provided.");

  switch (options.action) {
    case "daemon":
      await runProviderSyncDaemon(args.workspaceRoot);
      return;
    case "plan": {
      const plan = await createProviderSyncPlan(
        args.workspaceRoot,
        options.provider,
      );
      if (args.json) {
        printJson(plan);
      } else {
        writeStdoutLine("provider sync plan:");
        writeStdoutLine(JSON.stringify(plan, null, 2));
      }
      return;
    }
    case "enable": {
      const config = await setPersistentProviderSyncEnabled(true);
      const autostartPath = config.persistentSync.daemonAtLogin
        ? await installProviderSyncAutostart(args.workspaceRoot)
        : undefined;
      const status = await reconcileProviderSync(args.workspaceRoot);
      const daemonPid = config.persistentSync.watch
        ? await startDaemon(args.workspaceRoot)
        : undefined;
      const result = {
        ...status,
        daemonStartPid: daemonPid ?? null,
        autostartPath: autostartPath ?? null,
      };
      if (args.json) printJson(result);
      else printStatusLines({
        ...status,
        daemon: {
          ...status.daemon,
          running: daemonPid !== undefined || status.daemon.running,
          ...(daemonPid ? { pid: daemonPid } : {}),
        },
      });
      return;
    }
    case "disable": {
      await setPersistentProviderSyncEnabled(false);
      await stopDaemon();
      await removeProviderSyncAutostart();
      const warnings = await uninstallProviderSyncTargets();
      const status = await loadProviderSyncStatus(args.workspaceRoot);
      const result = { ...status, enabled: false, uninstallWarnings: warnings };
      if (args.json) printJson(result);
      else {
        printStatusLines({ ...status, enabled: false });
        for (const warning of warnings) writeStdoutLine(`warning: ${warning}`);
      }
      return;
    }
    case "refresh": {
      const config = await loadProviderEnrollmentConfig();
      if (
        config.enabled &&
        config.persistentSync.enabled &&
        config.persistentSync.daemonAtLogin
      ) {
        await installProviderSyncAutostart(args.workspaceRoot);
      }
      if (await getProviderSyncDaemonPid()) {
        await requestProviderSyncRefresh();
      }
      const status = await reconcileProviderSync(args.workspaceRoot);
      if (config.enabled && config.persistentSync.enabled && config.persistentSync.watch) {
        await startDaemon(args.workspaceRoot);
      }
      if (args.json) printJson(status);
      else printStatusLines(status);
      return;
    }
    case "doctor": {
      const doctor = await doctorProviderSync(args.workspaceRoot);
      if (args.json) printJson(doctor);
      else {
        writeStdoutLine(`provider sync doctor: ${doctor.healthy ? "healthy" : "degraded"}`);
        writeStdoutLine(JSON.stringify(doctor, null, 2));
      }
      return;
    }
    case "status": {
      const status = await loadProviderSyncStatus(args.workspaceRoot);
      if (args.json) printJson(status);
      else printStatusLines(status);
      return;
    }
  }
};
