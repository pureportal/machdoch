import { realpath, stat } from "node:fs/promises";
import { gatewayProtocolVersion } from "@machdoch/fleet-protocol";
import {
  enrollFleetConnection,
  getFleetConnectionPath,
  loadFleetConnectionConfig,
  loadFleetConnectionStatus,
  resetFleetConnection,
  setFleetConnectionEnabled,
} from "../../core/fleet-connection.js";
import { withCooperativeFileLock } from "../../core/_helpers/with-cooperative-file-lock.helper.js";
import type { FleetCliOptions, ParsedCliArgs } from "./cli-args.js";
import { runFleetGatewayService } from "./cli-fleet-gateway.js";
import { FleetCliProductRuntime } from "./cli-fleet-product.js";
import { writeStdoutLine } from "./cli-io.js";
import { CliConfigurationError } from "./cli-error.js";
import { manageFleetService } from "../../core/fleet-service.js";

const fail = (message: string): never => {
  throw new Error(message);
};

const resolveProductVersion = (): string => {
  const injected = (globalThis as { __MACHDOCH_PRODUCT_VERSION__?: unknown })
    .__MACHDOCH_PRODUCT_VERSION__;
  if (typeof injected === "string" && injected.trim()) return injected.trim();
  return process.env.npm_package_version?.trim() || "development";
};

const printJson = (value: unknown): void => {
  writeStdoutLine(JSON.stringify(value, null, 2));
};

const printStatus = async (json: boolean): Promise<void> => {
  const status = await loadFleetConnectionStatus();
  if (json) {
    printJson(status);
    return;
  }
  writeStdoutLine(
    `fleet: ${status.configured ? (status.enabled ? "enabled" : "disabled") : "not enrolled"}`,
  );
  if (status.managerUrl) writeStdoutLine(`manager: ${status.managerUrl}`);
  if (status.displayName) writeStdoutLine(`instance: ${status.displayName}`);
  writeStdoutLine(`config: ${status.configPath}`);
};

const resolveServiceWorkspace = async (
  workspaceRoot: string,
): Promise<string> => {
  let resolved: string;
  let isDirectory: boolean;
  try {
    resolved = await realpath(workspaceRoot);
    isDirectory = (await stat(resolved)).isDirectory();
  } catch (error) {
    throw new Error(
      `Fleet service workspace is unavailable: ${workspaceRoot}`,
      {
        cause: error,
      },
    );
  }
  if (!isDirectory) fail("The Fleet service workspace must be a directory.");
  return resolved;
};

const runService = async (args: ParsedCliArgs): Promise<void> => {
  let workspaceRoot: string;
  try {
    const config = await loadFleetConnectionConfig();
    if (!config)
      throw new Error(
        "Enroll this CLI with a Fleet Manager before starting the Fleet service.",
      );
    if (!config.enabled)
      throw new Error(
        "Fleet is disabled. Enable it before starting the service.",
      );
    workspaceRoot = await resolveServiceWorkspace(args.workspaceRoot);
  } catch (error) {
    throw new CliConfigurationError(
      error instanceof Error
        ? error.message
        : "Fleet service configuration is invalid.",
    );
  }

  const controller = new AbortController();
  let shutdownDeadline: NodeJS.Timeout | undefined;
  const stop = (): void => {
    if (controller.signal.aborted) return;
    controller.abort("Fleet service stopped.");
    // systemd additionally kills the entire control group after TimeoutStopSec.
    shutdownDeadline = setTimeout(() => {
      process.stderr.write("Fleet service shutdown timed out.\n");
      process.exit(1);
    }, 30_000);
    shutdownDeadline.unref();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await withCooperativeFileLock(
      `${getFleetConnectionPath()}.cli-service`,
      async () => {
        if (controller.signal.aborted) return;
        let fleetRuntime: FleetCliProductRuntime;
        try {
          fleetRuntime = await FleetCliProductRuntime.create(workspaceRoot);
        } catch (error) {
          throw new CliConfigurationError(
            `Fleet service could not initialize: ${error instanceof Error ? error.message : "Check the host configuration and project library."}`,
          );
        }
        let result: Awaited<ReturnType<typeof runFleetGatewayService>>;
        try {
          result = await runFleetGatewayService({
            signal: controller.signal,
            productVersion: resolveProductVersion(),
            handleRequest: (request) => fleetRuntime.handleRequest(request),
            onStatus: (event) => {
              if (args.json) {
                writeStdoutLine(
                  JSON.stringify({ type: "fleetStatus", ...event }),
                );
                return;
              }
              writeStdoutLine(
                `fleet service: ${event.phase}${event.message ? ` - ${event.message}` : ""}`,
              );
            },
          });
        } finally {
          stop();
          // Retain the ownership lock until task cancellation and persistence finish.
          await fleetRuntime.shutdown("Fleet CLI service stopped.");
        }
        if (args.json) {
          writeStdoutLine(
            JSON.stringify({ type: "fleetServiceStopped", ...result }),
          );
        }
      },
      {
        timeoutMs: 100,
        recoverDeadOwnerImmediately: true,
        ownerDescription: "Fleet CLI service",
      },
    );
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    if (shutdownDeadline) clearTimeout(shutdownDeadline);
  }
};

export const printFleetSummary = async (args: ParsedCliArgs): Promise<void> => {
  const options: FleetCliOptions =
    args.fleet ?? fail("No Fleet action was provided.");

  switch (options.action) {
    case "status":
      await printStatus(args.json);
      return;
    case "enroll":
      await enrollFleetConnection({
        managerUrl:
          options.managerUrl ?? fail("No Fleet Manager URL was provided."),
        enrollmentKey:
          options.enrollmentKey ??
          fail("No Fleet enrollment key was provided."),
        displayName:
          options.displayName ?? fail("No Fleet instance name was provided."),
        productVersion: resolveProductVersion(),
        protocolVersion: gatewayProtocolVersion,
      });
      await printStatus(args.json);
      return;
    case "enable":
      await setFleetConnectionEnabled(true);
      await printStatus(args.json);
      return;
    case "disable":
      await setFleetConnectionEnabled(false);
      await printStatus(args.json);
      return;
    case "reset":
      await resetFleetConnection();
      await printStatus(args.json);
      return;
    case "service":
      if (!options.serviceAction || options.serviceAction === "run") {
        await runService(args);
      } else {
        const result = await manageFleetService(
          options.serviceAction,
          args.workspaceRoot,
        );
        if (options.serviceAction === "unit" && !args.json)
          writeStdoutLine(String(result.unit).trimEnd());
        else printJson(result);
      }
      return;
  }
};
