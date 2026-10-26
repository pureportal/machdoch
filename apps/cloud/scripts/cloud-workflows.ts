import { fileURLToPath } from "node:url";
import {
  Client,
  Connection,
  WorkflowExecutionAlreadyStartedError,
} from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { initializeCloudRuntime } from "../src/server/cloud/runtime";
import { createPersistentCloudRuntime } from "../src/server/cloud/startup";

const address = process.env.MACHDOCH_CLOUD_TEMPORAL_ADDRESS;
const namespace = process.env.MACHDOCH_CLOUD_TEMPORAL_NAMESPACE;
const installationId = process.env.MACHDOCH_CLOUD_INSTALLATION_ID;
if (
  !address ||
  !namespace ||
  !installationId ||
  !/^[a-zA-Z0-9_-]{1,80}$/.test(installationId)
)
  throw new Error(
    "Set MACHDOCH_CLOUD_TEMPORAL_ADDRESS, MACHDOCH_CLOUD_TEMPORAL_NAMESPACE and MACHDOCH_CLOUD_INSTALLATION_ID (letters, numbers, underscores or hyphens).",
  );
const taskQueue = `machdoch-cloud-${installationId}`;
if (
  process.env.MACHDOCH_CLOUD_TEMPORAL_TLS &&
  !["true", "false"].includes(process.env.MACHDOCH_CLOUD_TEMPORAL_TLS)
)
  throw new Error("MACHDOCH_CLOUD_TEMPORAL_TLS must be true or false.");
if (
  process.env.MACHDOCH_CLOUD_TEMPORAL_API_KEY &&
  process.env.MACHDOCH_CLOUD_TEMPORAL_TLS !== "true"
)
  throw new Error("Temporal API keys require TLS.");
const connectionOptions = {
  address,
  tls: process.env.MACHDOCH_CLOUD_TEMPORAL_TLS === "true",
  apiKey: process.env.MACHDOCH_CLOUD_TEMPORAL_API_KEY,
};
const runtime = await initializeCloudRuntime(createPersistentCloudRuntime);
let connection: Connection | undefined;
let native: NativeConnection | undefined;
try {
  connection = await Connection.connect(connectionOptions);
  native = await NativeConnection.connect(connectionOptions);
  const client = new Client({ connection, namespace });
  try {
    await client.workflow.start("scheduleCoordinator", {
      workflowId: `${taskQueue}-schedules`,
      taskQueue,
    });
  } catch (error) {
    if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
  }
  const worker = await Worker.create({
    connection: native,
    namespace,
    taskQueue,
    workflowBundle: {
      codePath: fileURLToPath(
        new URL("../dist/cloud-workflows.cjs", import.meta.url),
      ),
    },
    activities: { tickSchedules: () => runtime.scheduleDispatcher.tick() },
    maxConcurrentActivityTaskExecutions: 2,
    maxConcurrentWorkflowTaskExecutions: 2,
    shutdownGraceTime: "65 seconds",
  });
  await worker.run();
} finally {
  await native?.close();
  await connection?.close();
  await runtime.database.close();
}
