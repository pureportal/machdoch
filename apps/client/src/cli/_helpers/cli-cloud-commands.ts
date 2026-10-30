import { ClientCloudBindings } from "../../core/cloud/bindings.js";
import type { ParsedCliArgs } from "./cli-args-types.js";
import { writeStdoutLine } from "./cli-io.js";
import { CliConfigurationError } from "./cli-error.js";
import { readTaskFromStdin } from "./cli-task-stdin.js";
import { executeCloudWorkspaceRequest } from "../../core/cloud/desktop.js";
import { createClientCloudWorker } from "../../core/cloud/worker.js";
import { runWorkerLoop } from "@machdoch/cloud-client/worker";
import { resolve } from "node:path";

export async function runCloudCommand(args: ParsedCliArgs): Promise<void> {
  const options = args.cloud;
  if (!options) throw new CliConfigurationError("Select a cloud command.");
  const bindings = new ClientCloudBindings();
  if (options.action === "run") {
    const worker = await createClientCloudWorker(
      options.id,
      options.runtime && resolve(options.runtime),
      bindings,
    );
    const controller = new AbortController();
    const stop = () => controller.abort(new Error("Client execution stopped"));
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      const succeeded = await runWorkerLoop(worker.runner, worker.journal, {
        signal: controller.signal,
        once: options.once,
        pollIntervalMs: worker.pollIntervalMs,
        onResult: (result) =>
          writeStdoutLine(
            args.json
              ? JSON.stringify(result)
              : `${result.runId}: ${result.state}`,
          ),
        onError: (message) => process.stderr.write(message + "\n"),
      });
      if (!succeeded) process.exitCode = 1;
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      worker.journal.close();
    }
    return;
  }
  if (options.action === "request") {
    let input: unknown;
    try {
      input = JSON.parse(await readTaskFromStdin(process.stdin, 65536));
    } catch {
      writeStdoutLine(
        JSON.stringify({
          ok: false,
          error: "The cloud request is invalid or exceeds 64 KiB.",
        }),
      );
      return;
    }
    writeStdoutLine(
      JSON.stringify(await executeCloudWorkspaceRequest(input, bindings)),
    );
    return;
  }
  if (options.action === "connect") {
    const token = process.env.MACHDOCH_CLOUD_RUNNER_TOKEN;
    if (!token)
      throw new CliConfigurationError(
        "Set MACHDOCH_CLOUD_RUNNER_TOKEN to the enrolled client runner token before connecting.",
      );
    const connection = await bindings.connect(
      options.origin,
      token,
      args.workspaceRoot,
      options.name,
    );
    writeStdoutLine(
      args.json
        ? JSON.stringify(connection)
        : `${connection.binding.name} linked to ${connection.registration.projectName}.\nConnection: ${connection.id}`,
    );
    return;
  }
  if (options.action === "disconnect") {
    await bindings.disconnect(options.id);
    writeStdoutLine(
      args.json
        ? JSON.stringify({ id: options.id, status: "disconnected" })
        : "Workspace disconnected.",
    );
    return;
  }
  const connections = await bindings.list();
  writeStdoutLine(
    args.json
      ? JSON.stringify({ connections })
      : connections.length
        ? connections
            .map(
              (connection) =>
                `${connection.id}  ${connection.binding.name}  ${connection.registration.projectName}  ${connection.status}`,
            )
            .join("\n")
        : "No cloud workspaces linked.",
  );
}
