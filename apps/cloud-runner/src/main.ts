import { parseArgs } from "node:util";
import {
  readRunnerLaunch,
  receiveRunnerLaunch,
  RunnerJournal,
  CloudRunner,
  runWorkerLoop,
} from "@machdoch/cloud-client/worker";
import { RunnerConnection } from "@machdoch/cloud-client";

const { values } = parseArgs({
  options: {
    config: { type: "string" },
    managed: { type: "boolean", default: false },
    once: { type: "boolean", default: false },
  },
});
if (!values.config && !values.managed)
  throw new Error("Provide --config with the runner configuration path");
const { token, ...configuration } = values.managed
  ? await receiveRunnerLaunch()
  : await readRunnerLaunch(values.config!);
process.channel?.unref();
const connection = new RunnerConnection(configuration.origin, token, fetch, {
  allowLoopbackHttp: true,
});
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
process.once("disconnect", stop);
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
  process.removeListener("disconnect", stop);
  journal.close();
}
