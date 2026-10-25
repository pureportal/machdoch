import { parseArgs } from "node:util";
import {
  readRunnerConfiguration,
  RunnerJournal,
  CloudRunner,
  runWorkerLoop,
} from "@machdoch/cloud-client/worker";
import { RunnerConnection } from "@machdoch/cloud-client";

const { values } = parseArgs({
  options: {
    config: { type: "string" },
    once: { type: "boolean", default: false },
  },
});
if (!values.config)
  throw new Error("Provide --config with the runner configuration path");
const configuration = await readRunnerConfiguration(values.config);
const token = process.env.MACHDOCH_CLOUD_RUNNER_TOKEN;
if (!token) throw new Error("Configure MACHDOCH_CLOUD_RUNNER_TOKEN");
const connection = new RunnerConnection(configuration.origin, token);
const journal = new RunnerJournal(
  configuration.stateDirectory,
  connection.origin,
);
const runner = new CloudRunner(configuration, connection, journal, {
  kind: "cloud",
});
const controller = new AbortController();
const stop = () => controller.abort(new Error("Runner shutdown requested"));
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  const succeeded = await runWorkerLoop(runner, journal, {
    signal: controller.signal,
    once: values.once,
    pollIntervalMs: configuration.pollIntervalMs,
    onResult: (result) => process.stdout.write(JSON.stringify(result) + "\n"),
    onError: (message) => process.stderr.write(message + "\n"),
  });
  if (!succeeded) process.exitCode = 1;
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Runner failed"}\n`,
  );
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  journal.close();
}
