import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve, join } from "node:path";
import { Connection } from "@temporalio/client";
import { assertEventually } from "./cloud-browser-fixture.mjs";

export async function cloudTemporalFixture(directory) {
  const binary =
    process.env.TEMPORAL_SERVER_PATH ??
    resolve(
      "../../.tmp/cloud-temporal/1.32.1/distribution/temporal-server.exe",
    );
  await mkdir(directory, { recursive: true });
  const reservations = [];
  const ports = [];
  try {
    for (let index = 0; index < 8; index++) {
      const server = createServer();
      reservations.push(server);
      await new Promise((done, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", done);
      });
      ports.push(server.address().port);
    }
  } finally {
    for (const server of reservations)
      await new Promise((done) => server.close(done));
  }
  const sql = (name) => ({
    sql: {
      pluginName: "sqlite",
      databaseName: join(directory, name).replaceAll("\\", "/"),
      connectAddr: "127.0.0.1",
      connectProtocol: "tcp",
      connectAttributes: {
        setup: "true",
        cache: "private",
        journal_mode: "wal",
        synchronous: "2",
      },
      maxConns: 1,
      maxIdleConns: 1,
      maxConnLifetime: "1h",
    },
  });
  const configuration = {
    log: { stdout: true, level: "error" },
    persistence: {
      defaultStore: "default",
      visibilityStore: "visibility",
      numHistoryShards: 1,
      datastores: {
        default: sql("history.sqlite"),
        visibility: sql("visibility.sqlite"),
      },
    },
    global: {
      membership: { maxJoinDuration: "10s", broadcastAddress: "127.0.0.1" },
    },
    services: Object.fromEntries(
      ["frontend", "history", "matching", "worker"].map((name, index) => [
        name,
        {
          rpc: {
            grpcPort: ports[index * 2],
            membershipPort: ports[index * 2 + 1],
            bindOnLocalHost: true,
          },
        },
      ]),
    ),
    clusterMetadata: {
      enableGlobalNamespace: false,
      failoverVersionIncrement: 10,
      masterClusterName: "active",
      currentClusterName: "active",
      clusterInformation: {
        active: {
          enabled: true,
          initialFailoverVersion: 1,
          rpcName: "frontend",
          rpcAddress: `127.0.0.1:${ports[0]}`,
        },
      },
    },
    dcRedirectionPolicy: { policy: "noop" },
  };
  const config = join(directory, "server.json");
  await writeFile(config, JSON.stringify(configuration));
  let child, connection;
  let logs = "";
  const start = async () => {
    child = spawn(
      binary,
      ["--config-file", config, "--allow-no-auth", "start"],
      { cwd: directory, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.on("data", (data) => {
      logs = (logs + data).slice(-20000);
    });
    child.stderr.on("data", (data) => {
      logs = (logs + data).slice(-20000);
    });
    child.finished = new Promise((done, reject) => {
      child.once("error", reject);
      child.once("exit", done);
    });
    await assertEventually(
      async () => {
        if (child.exitCode !== null)
          throw new Error(`Temporal exited. ${logs}`);
        try {
          connection = await Connection.connect({
            address: `127.0.0.1:${ports[0]}`,
            connectTimeout: "1 second",
          });
          return true;
        } catch {
          return false;
        }
      },
      () => `Temporal did not start. ${logs}`,
      60000,
    );
  };
  const stop = async () => {
    await connection?.close();
    connection = undefined;
    if (child?.exitCode === null) child.kill();
    await child?.finished;
  };
  try {
    await start();
    const namespace = "cloud-verification";
    await connection.workflowService.registerNamespace({
      namespace,
      workflowExecutionRetentionPeriod: { seconds: 86400 },
    });
    return {
      address: `127.0.0.1:${ports[0]}`,
      namespace,
      close: stop,
      restart: async () => {
        await stop();
        await start();
      },
      logs: () => logs,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
