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
  const config =
    (await loadFleetConnectionConfig()) ??
    fail(
      "Enroll this CLI with a Fleet Manager before starting the Fleet service.",
    );
  if (!config.enabled) {
    fail(
      "Fleet is disabled. Set fleet.enabled to on before starting the service.",
    );
  }
  const workspaceRoot = await resolveServiceWorkspace(args.workspaceRoot);

  const controller = new AbortController();
  const stop = (): void => controller.abort("Fleet service stopped.");
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let runtime: FleetCliProductRuntime | undefined;
  try {
    await withCooperativeFileLock(
      `${getFleetConnectionPath()}.cli-service`,
      async () => {
        const fleetRuntime = await FleetCliProductRuntime.create(workspaceRoot);
        runtime = fleetRuntime;
        const result = await runFleetGatewayService({
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
        if (args.json) {
          writeStdoutLine(
            JSON.stringify({ type: "fleetServiceStopped", ...result }),
          );
        }
      },
      {
        timeoutMs: 100,
        staleLockAgeMs: 0,
        ownerDescription: "Fleet CLI service",
      },
    );
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await runtime?.shutdown("Fleet CLI service stopped.");
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
      await runService(args);
      return;
  }
};
