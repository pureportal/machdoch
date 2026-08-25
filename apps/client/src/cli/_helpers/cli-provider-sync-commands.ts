import { spawn } from "node:child_process";
import process from "node:process";
import {
  loadProviderEnrollmentConfig,
  setPersistentProviderSyncEnabled,
} from "../../core/provider-enrollment/config.js";
import {
  getCurrentProviderSyncDaemonPid,
  getProviderSyncDaemonPid,
  requestProviderSyncRefresh,
  runProviderSyncDaemon,
  stopProviderSyncDaemon,
} from "../../core/provider-enrollment/sync-daemon.js";
import {
  createProviderSyncPlan,
  doctorProviderSync,
  loadProviderSyncStatus,
  reconcileProviderSync,
  registerProviderSyncWorkspace,
  uninstallProviderSyncTargets,
} from "../../core/provider-enrollment/sync-coordinator.js";
import {
  installProviderSyncAutostart,
  isProviderSyncAutostartInstalled,
  removeProviderSyncAutostart,
} from "../../core/provider-enrollment/platform-autostart.js";
import { resolveMachdochCliLaunch } from "../../core/provider-enrollment/machdoch-cli-launch.js";
import type { ParsedCliArgs, ProviderSyncCliOptions } from "./cli-args.js";
import { writeStdoutLine } from "./cli-io.js";

const fail = (message: string): never => {
  throw new Error(message);
};

const printJson = (value: unknown): void => {
  writeStdoutLine(JSON.stringify(value, null, 2));
};

const startDaemon = async (
  workspaceRoot: string,
): Promise<number | undefined> => {
  await stopProviderSyncDaemon({ onlyIfRuntimeMismatch: true });
  const existing = await getCurrentProviderSyncDaemonPid();
  if (existing) return existing;
  const launch = resolveMachdochCliLaunch();
  const daemonArgs = [
    ...launch.args,
    "provider-sync",
    "daemon",
    "--cwd",
    workspaceRoot,
  ];
  const child = spawn(launch.command, daemonArgs, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    cwd: launch.cwd,
    env: { ...process.env, ...launch.environment },
  });
  try {
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once("spawn", resolveSpawn);
      child.once("error", rejectSpawn);
    });
  } catch (error) {
    throw new Error(
      `Machdoch could not launch the provider-sync daemon with ${launch.command}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (child.pid === undefined) {
    throw new Error(
      `Machdoch launched the provider-sync daemon with ${launch.command}, but no process identifier was reported.`,
    );
  }
  child.unref();
  return child.pid;
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
    for (const warning of target.warnings)
      writeStdoutLine(`  warning: ${warning}`);
    if (target.error) writeStdoutLine(`  error: ${target.error}`);
  }
};

export const ensureAutomaticProviderSync = async (
  workspaceRoot: string,
): Promise<void> => {
  const config = await loadProviderEnrollmentConfig();
  if (!config.enabled || !config.persistentSync.enabled) {
    const [daemonPid, autostartInstalled] = await Promise.all([
      getProviderSyncDaemonPid(),
      isProviderSyncAutostartInstalled(),
    ]);
    if (!daemonPid && !autostartInstalled) return;
    if (daemonPid) await stopProviderSyncDaemon();
    if (autostartInstalled) await removeProviderSyncAutostart();
    return;
  }
  const autostartInstalled = await isProviderSyncAutostartInstalled();
  if (config.persistentSync.daemonAtLogin) {
    await installProviderSyncAutostart(workspaceRoot);
  } else if (autostartInstalled) {
    await removeProviderSyncAutostart();
  }
  if (config.persistentSync.watch) {
    await stopProviderSyncDaemon({ onlyIfRuntimeMismatch: true });
    if (await getCurrentProviderSyncDaemonPid()) {
      // The daemon owns reconciliation while it is available. Asking it to
      // refresh avoids making every foreground Machdoch command contend for the
      // same global provider-enrollment lock.
      await registerProviderSyncWorkspace(workspaceRoot);
      await requestProviderSyncRefresh();
      return;
    }
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
      const existingConfig = await loadProviderEnrollmentConfig();
      const wasEnabled =
        existingConfig.enabled && existingConfig.persistentSync.enabled;
      if (wasEnabled) {
        await stopProviderSyncDaemon({ onlyIfRuntimeMismatch: true });
      } else {
        await stopProviderSyncDaemon();
      }
      const uninstallWarnings = wasEnabled
        ? []
        : await uninstallProviderSyncTargets();
      const config = await setPersistentProviderSyncEnabled(true);
      let status: Awaited<ReturnType<typeof reconcileProviderSync>>;
      let autostartPath: string | undefined;
      let daemonPid: number | undefined;
      try {
        status = await reconcileProviderSync(args.workspaceRoot);
        autostartPath = config.persistentSync.daemonAtLogin
          ? await installProviderSyncAutostart(args.workspaceRoot)
          : undefined;
        daemonPid = config.persistentSync.watch
          ? await startDaemon(args.workspaceRoot)
          : undefined;
      } catch (error) {
        if (!wasEnabled) {
          await setPersistentProviderSyncEnabled(false).catch(() => undefined);
          await removeProviderSyncAutostart().catch(() => undefined);
          await reconcileProviderSync(args.workspaceRoot).catch(
            () => undefined,
          );
        }
        throw error;
      }
      const result = {
        ...status,
        daemonStartPid: daemonPid ?? null,
        autostartPath: autostartPath ?? null,
        ...(uninstallWarnings.length > 0 ? { uninstallWarnings } : {}),
      };
      if (args.json) printJson(result);
      else
        printStatusLines({
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
      await stopProviderSyncDaemon();
      await removeProviderSyncAutostart();
      const status = await reconcileProviderSync(args.workspaceRoot);
      const result = { ...status, enabled: false };
      if (args.json) printJson(result);
      else printStatusLines({ ...status, enabled: false });
      return;
    }
    case "refresh": {
      const config = await loadProviderEnrollmentConfig();
      await stopProviderSyncDaemon({ onlyIfRuntimeMismatch: true });
      if (
        config.enabled &&
        config.persistentSync.enabled &&
        config.persistentSync.daemonAtLogin
      ) {
        await installProviderSyncAutostart(args.workspaceRoot);
      }
      if (await getCurrentProviderSyncDaemonPid()) {
        await requestProviderSyncRefresh();
      }
      const status = await reconcileProviderSync(args.workspaceRoot);
      if (
        config.enabled &&
        config.persistentSync.enabled &&
        config.persistentSync.watch
      ) {
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
        writeStdoutLine(
          `provider sync doctor: ${doctor.healthy ? "healthy" : "degraded"}`,
        );
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
