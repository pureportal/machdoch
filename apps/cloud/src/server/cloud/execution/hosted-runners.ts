import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { machdochDataDirectory } from "@machdoch/cloud-client/sandbox-installation";
import type { HostedRunnerStatus } from "@machdoch/fleet-protocol/cloud-execution";
import { createSecret, hashSecret } from "../../crypto";
import type { SettingsCipher } from "../../settings-crypto";
import type { CloudDatabase, CloudSql } from "../database";
import { CloudPeriodicLoop } from "../periodic-loop";
import { lockExecution } from "./records";
import type { CloudSandboxRuntime, HostedSandbox } from "./sandbox-runtime";

const restartDelayMs = 30_000;
const maximumRestartDelayMs = 10 * 60_000;
const stableRunMs = 5 * 60_000;
const stopGraceMs = 30_000;
const hostedRunnerName = "This server";
const errorLimit = 300;

interface HostedWorker {
  organizationId: string;
  id: string;
  token: string;
}

interface HostedProcess {
  child: ChildProcess;
  token: string;
  stderr: string;
  stopping: boolean;
  startedAt: number;
  failures: number;
  exited: Promise<unknown>;
}

interface HostedFailure {
  error: string;
  failedAt: number;
  failures: number;
}

export function hostedRestartDelay(failures: number): number {
  return Math.min(
    maximumRestartDelayMs,
    restartDelayMs * 2 ** Math.max(0, failures - 1),
  );
}

function lastLine(output: string): string {
  const line = output.trim().split(/\r?\n/).at(-1) ?? "";
  return line.slice(0, errorLimit) || "The runner stopped unexpectedly.";
}

export function hostedTokenContext(
  organizationId: string,
  workerId: string,
): Buffer {
  return Buffer.from(`cloud.runner.hosted/${organizationId}/${workerId}`);
}

export function hostedRunnerOrigin(address: string, port: number): string {
  if (address === "::1") return `http://[::1]:${port}`;
  if (["", "0.0.0.0", "::", "127.0.0.1", "localhost"].includes(address))
    return `http://127.0.0.1:${port}`;
  return `http://${address.includes(":") ? `[${address}]` : address}:${port}`;
}

export class CloudHostedRunners {
  private readonly processes = new Map<string, HostedProcess>();
  private readonly failures = new Map<string, HostedFailure>();
  private loop: CloudPeriodicLoop | null = null;
  private origin = "";

  constructor(
    private readonly database: CloudDatabase,
    private readonly cipher: SettingsCipher | null,
    private readonly sandbox: CloudSandboxRuntime,
  ) {}

  get localOrigin(): string {
    return this.origin;
  }

  start(origin: string): void {
    this.origin = origin;
    this.loop = new CloudPeriodicLoop("Hosted runners", () => this.tick(), 1);
    this.loop.start();
  }

  wake(): void {
    this.loop?.wake();
  }

  async close(): Promise<void> {
    await this.loop?.close();
    await Promise.all([...this.processes.keys()].map((id) => this.stop(id)));
  }

  status(workerId: string): HostedRunnerStatus {
    if (this.processes.has(workerId)) return { state: "running", error: null };
    const failure = this.failures.get(workerId);
    return failure
      ? { state: "failed", error: failure.error }
      : { state: "stopped", error: null };
  }

  private async provision(
    sql: CloudSql,
    cipher: SettingsCipher,
    organizationId: string,
  ): Promise<void> {
    const profiles = (
      await sql.query<{ id: string; revision: number }>(
        `SELECT p.id,p.revision FROM cloud_execution_profiles p
        WHERE p.organization_id=$1 AND p.enabled AND p.definition->>'target'='cloud'
        AND NOT EXISTS (SELECT 1 FROM cloud_execution_workers w WHERE w.organization_id=p.organization_id AND w.profile_id=p.id AND w.hosted_token IS NOT NULL)`,
        [organizationId],
      )
    ).rows;
    for (const profile of profiles) {
      const id = randomUUID();
      const token = createSecret("mch_cloud_worker");
      await sql.query(
        "INSERT INTO cloud_execution_workers (organization_id,id,profile_id,profile_revision,name,token_hash,hosted_token) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [
          organizationId,
          id,
          profile.id,
          profile.revision,
          hostedRunnerName,
          hashSecret(token),
          cipher.encrypt(
            Buffer.from(token),
            hostedTokenContext(organizationId, id),
          ),
        ],
      );
    }
  }

  private async desiredWorkers(sandboxReady: boolean): Promise<HostedWorker[]> {
    if (!this.cipher) return [];
    const cipher = this.cipher;
    return this.database.transaction(async (sql) => {
      const organizationId = (
        await sql.query<{ organization_id: string }>(
          "SELECT organization_id FROM cloud_installation WHERE id=1 AND organization_id IS NOT NULL",
        )
      ).rows[0]?.organization_id;
      if (!organizationId) return [];
      await lockExecution(sql, organizationId);
      if (sandboxReady) await this.provision(sql, cipher, organizationId);
      await sql.query(
        `UPDATE cloud_execution_workers SET expires_at=clock_timestamp()+interval '30 days'
        WHERE organization_id=$1 AND hosted_token IS NOT NULL AND enabled AND expires_at<clock_timestamp()+interval '29 days'`,
        [organizationId],
      );
      await sql.query(
        `UPDATE cloud_execution_workers w SET profile_revision=p.revision FROM cloud_execution_profiles p
        WHERE w.organization_id=$1 AND p.organization_id=w.organization_id AND p.id=w.profile_id
        AND w.hosted_token IS NOT NULL AND w.enabled AND w.profile_revision<>p.revision
        AND NOT EXISTS (SELECT 1 FROM cloud_run_attempts a WHERE a.organization_id=w.organization_id AND a.worker_id=w.id AND a.state<>'stopped')`,
        [organizationId],
      );
      const rows = (
        await sql.query<{ id: string; hosted_token: Uint8Array }>(
          `SELECT w.id,w.hosted_token FROM cloud_execution_workers w
          JOIN cloud_execution_profiles p ON p.organization_id=w.organization_id AND p.id=w.profile_id
          WHERE w.organization_id=$1 AND w.hosted_token IS NOT NULL AND w.enabled AND p.enabled AND p.definition->>'target'='cloud'`,
          [organizationId],
        )
      ).rows;
      return rows.map((row) => ({
        organizationId,
        id: row.id,
        token: cipher
          .decrypt(
            Buffer.from(row.hosted_token),
            hostedTokenContext(organizationId, row.id),
          )
          .toString("utf8"),
      }));
    });
  }

  async tick(): Promise<number> {
    if (!this.origin) return 0;
    const sandbox = await this.sandbox.current();
    const desired = new Map(
      (await this.desiredWorkers(sandbox !== null)).map((worker) => [
        worker.id,
        worker,
      ]),
    );
    for (const [id, running] of this.processes)
      if (desired.get(id)?.token !== running.token) await this.stop(id);
    for (const id of this.failures.keys())
      if (!desired.has(id)) this.failures.delete(id);
    let started = 0;
    for (const worker of desired.values()) {
      if (this.processes.has(worker.id)) continue;
      const failure = this.failures.get(worker.id);
      if (
        failure &&
        Date.now() - failure.failedAt < hostedRestartDelay(failure.failures)
      )
        continue;
      if (!sandbox) {
        this.failures.set(worker.id, {
          error: "The sandbox on this server is unavailable.",
          failedAt: Date.now(),
          failures: failure?.failures ?? 1,
        });
        continue;
      }
      await this.launch(worker, sandbox, failure?.failures ?? 0);
      started += 1;
    }
    return started;
  }

  private async launch(
    worker: HostedWorker,
    sandbox: HostedSandbox,
    previousFailures: number,
  ): Promise<void> {
    const stateDirectory = join(machdochDataDirectory, "runners", worker.id);
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const { cgroupRoot, ...artifacts } = sandbox;
    const configuration = {
      origin: this.origin,
      token: worker.token,
      stateDirectory,
      sandbox: cgroupRoot
        ? { backend: "kvm", cgroupRoot, ...artifacts }
        : { backend: "whpx", ...artifacts },
    };
    const runnerPackage = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../../cloud-runner",
    );
    const child = spawn(
      process.execPath,
      [
        "--import",
        "@oxc-node/core/register",
        join(runnerPackage, "src/main.ts"),
        "--managed",
      ],
      {
        cwd: runnerPackage,
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        env: {
          NODE_ENV: process.env.NODE_ENV,
          ...(process.env.SystemRoot
            ? { SystemRoot: process.env.SystemRoot }
            : {}),
        },
      },
    );
    const running: HostedProcess = {
      child,
      token: worker.token,
      stderr: "",
      stopping: false,
      startedAt: Date.now(),
      failures: previousFailures,
      exited: once(child, "exit").catch(() => undefined),
    };
    this.processes.set(worker.id, running);
    this.failures.delete(worker.id);
    const record = (output: string) => {
      running.stderr = (running.stderr + output).slice(-4000);
    };
    const finish = () => {
      if (this.processes.get(worker.id) !== running) return;
      this.processes.delete(worker.id);
      if (running.stopping) return;
      const failedAt = Date.now();
      this.failures.set(worker.id, {
        error: lastLine(running.stderr),
        failedAt,
        failures:
          failedAt - running.startedAt >= stableRunMs
            ? 1
            : running.failures + 1,
      });
    };
    child.stderr?.on("data", (bytes: Buffer) => record(bytes.toString("utf8")));
    child.once("error", (error) => {
      record(`\n${error.message}`);
      finish();
    });
    child.once("exit", finish);
    child.send(configuration, (error) => {
      if (error) record(`\n${error.message}`);
    });
  }

  private async stop(id: string): Promise<void> {
    const running = this.processes.get(id);
    if (!running) return;
    running.stopping = true;
    if (running.child.exitCode === null && running.child.signalCode === null) {
      running.child.kill();
      const forced = setTimeout(() => running.child.kill("SIGKILL"), stopGraceMs);
      await running.exited;
      clearTimeout(forced);
    }
    this.processes.delete(id);
  }
}
