import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { setMaxListeners } from "node:events";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { cpus, freemem, platform, totalmem, uptime } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";
import {
  redactedRunValue,
  runDocumentSchema,
  type PreviewTarget,
  type RunCommand,
  type RunDocument,
  type RunSnapshot,
  type RunTask,
} from "@machdoch/fleet-protocol";
import { terminateProcessTree } from "./_helpers/process-tree.js";
import { writeFileAtomically } from "./_helpers/write-file-atomically.helper.js";
import { withCooperativeFileLock } from "./_helpers/with-cooperative-file-lock.helper.js";

type Status = RunSnapshot["statuses"][number];
interface Run {
  workspace: string;
  config: RunTask;
  status: Status;
  child?: ChildProcess | undefined;
  desired: boolean;
  generation: number;
  restarts: number[];
  restartAt?: number | undefined;
  checking: boolean;
  checkedAt: number;
  failures: number;
  done?: Promise<void>;
  termination?: Promise<void> | undefined;
  abort: AbortController;
  disconnects: Set<() => void>;
  sequence: number;
  logBytes: number;
}
interface DocumentState {
  document: RunDocument;
  revision: string;
}
const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const emptyDocument = (): RunDocument => ({
  schemaVersion: 2,
  configurations: [],
});
const active = (run: Run): boolean => run.desired || Boolean(run.child);
const cpuTotals = (): { idle: number; total: number } =>
  cpus().reduce(
    (acc, cpu) => ({
      idle: acc.idle + cpu.times.idle,
      total: acc.total + Object.values(cpu.times).reduce((a, b) => a + b, 0),
    }),
    { idle: 0, total: 0 },
  );

// A bounded supervisor for headless hosts. Project commands are owner-authorized code,
// not an OS sandbox. No command runs merely because a repository contains run.json.
export class FleetRunManager {
  private readonly runs = new Map<string, Run>();
  private readonly documents = new Map<string, DocumentState>();
  private readonly receipts = new Map<string, string>();
  private readonly sequences = new Map<string, AbortController>();
  private readonly sequenceSettlements = new Set<Promise<void>>();
  private tail: Promise<unknown> = Promise.resolve();
  private stopping = false;
  private readonly timer: NodeJS.Timeout;
  private cpu = cpuTotals();
  private cpuPercent: number | null = null;

  constructor(
    private readonly authorize: (workspace: string) => Promise<string>,
  ) {
    this.timer = setInterval(() => this.tick(), 5000);
    this.timer.unref();
  }

  isInUse(workspace: string): boolean {
    return [...this.runs.values()].some(
      (r) => r.workspace === workspace && active(r),
    );
  }

  async snapshot(workspace: string, includeLogs = true): Promise<RunSnapshot> {
    const root = await this.root(workspace);
    const state = this.isInUse(root)
      ? (this.documents.get(root) ?? (await this.load(root)))
      : await this.load(root);
    const document = structuredClone(state.document);
    for (const c of document.configurations)
      if (c.kind === "task") {
        for (const key of Object.keys(c.environment))
          c.environment[key] = redactedRunValue;
      }
    return {
      workspace: root,
      revision: state.revision,
      document,
      statuses: document.configurations.map((c) => {
        if (c.kind === "task") {
          const status =
            this.runs.get(this.key(root, c.id))?.status ?? this.newStatus(c.id);
          return structuredClone(
            includeLogs ? status : { ...status, logs: [] },
          );
        }
        const children = c.children.map(
          (id) => this.runs.get(this.key(root, id))?.status.state ?? "stopped",
        );
        const state = this.sequences.has(this.key(root, c.id))
          ? "starting"
          : children.includes("stopping")
            ? "stopping"
            : children.includes("crashed")
              ? "crashed"
              : children.includes("unhealthy")
                ? "unhealthy"
                : children.includes("restarting")
                  ? "restarting"
                  : children.includes("starting")
                    ? "starting"
                    : children.includes("running")
                      ? "running"
                      : "stopped";
        return { ...this.newStatus(c.id), state };
      }),
      host: {
        platform: platform(),
        uptimeSeconds: uptime(),
        cpuPercent: this.cpuPercent,
        totalMemory: totalmem(),
        freeMemory: freemem(),
        serviceMemory: process.memoryUsage().rss,
      },
    };
  }

  async execute(workspace: string, command: RunCommand): Promise<boolean> {
    return await this.serialize(async () => {
      if (this.stopping) throw new Error("Fleet service is stopping.");
      const root = await this.root(workspace);
      const fingerprint = digest(JSON.stringify({ root, command }));
      const receipt = this.receipts.get(command.commandId);
      if (receipt) {
        if (receipt !== fingerprint)
          throw new Error("Command id was already used for another operation.");
        return true;
      }
      if (command.action === "save") {
        if (
          this.isInUse(root) ||
          [...this.sequences.keys()].some((key) => key.startsWith(`${root}\0`))
        )
          throw new Error(
            "Stop all project services before editing their configuration.",
          );
        const path = await this.configPath(root, true);
        await withCooperativeFileLock(path, async () => {
          const previous = await this.load(root);
          if (previous.revision !== command.expectedRevision)
            throw new Error(
              "Run configuration changed. Reload it before saving.",
            );
          const document = runDocumentSchema.parse(
            structuredClone(command.document),
          );
          for (const c of document.configurations)
            if (c.kind === "task") {
              await this.cwd(root, c.workingDirectory);
              const old = previous.document.configurations.find(
                (entry) => entry.id === c.id,
              );
              for (const [key, value] of Object.entries(c.environment))
                if (value === redactedRunValue) {
                  if (
                    old?.kind !== "task" ||
                    old.environment[key] === undefined
                  )
                    throw new Error(
                      "A redacted environment variable has no stored value.",
                    );
                  c.environment[key] = old.environment[key];
                }
            }
          const content = JSON.stringify(document, null, 2) + "\n";
          if (Buffer.byteLength(content) > 1024 * 1024)
            throw new Error("Run configuration exceeds 1 MiB.");
          await writeFileAtomically(path, content, "utf8", {
            mode: 0o600,
            beforeCommit: async () => {
              await this.configPath(root, true);
              if ((await this.load(root)).revision !== previous.revision)
                throw new Error("Run configuration changed during save.");
            },
          });
          this.documents.set(root, { document, revision: digest(content) });
          for (const [key, run] of this.runs)
            if (run.workspace === root) this.runs.delete(key);
        });
      } else {
        const { document } = this.isInUse(root)
          ? this.documents.get(root)!
          : await this.load(root);
        const config = document.configurations.find(
          (c) => c.id === command.configurationId,
        );
        if (!config) throw new Error("Run configuration was not found.");
        const tasks =
          config.kind === "task"
            ? [config]
            : config.children.map((id) =>
                document.configurations.find(
                  (c): c is RunTask => c.kind === "task" && c.id === id,
                )!,
              );
        if (command.action !== "start") {
          for (const [key, controller] of this.sequences)
            if (key.startsWith(`${root}\0`)) controller.abort();
          await Promise.all(
            tasks.map(async (task) => {
              const run = this.runs.get(this.key(root, task.id));
              if (run) await this.stop(run);
            }),
          );
        }
        if (command.action !== "stop") {
          // Validate the entire group before any child starts.
          for (const task of tasks) await this.cwd(root, task.workingDirectory);
          if (config.kind === "composite" && config.startOrder === "sequence") {
            const key = this.key(root, config.id);
            if (
              !this.sequences.has(key) ||
              this.sequences.get(key)!.signal.aborted
            ) {
              const controller = new AbortController();
              this.sequences.set(key, controller);
              const settled = this.startSequence(
                root,
                tasks,
                controller,
              ).finally(() => {
                if (this.sequences.get(key) === controller)
                  this.sequences.delete(key);
                this.sequenceSettlements.delete(settled);
              });
              this.sequenceSettlements.add(settled);
            }
          } else {
            const started: Run[] = [];
            try {
              for (const task of tasks) {
                const run = this.runs.get(this.key(root, task.id));
                if (!run || !active(run))
                  started.push(await this.start(root, task, true));
              }
            } catch (error) {
              await Promise.all(started.map((run) => this.stop(run)));
              throw error;
            }
          }
        }
      }
      this.receipts.set(command.commandId, fingerprint);
      if (this.receipts.size > 128)
        this.receipts.delete(this.receipts.keys().next().value!);
      return false;
    });
  }

  async previewTarget(target: PreviewTarget): Promise<{
    host: string;
    port: number;
    signal: AbortSignal;
    track: (close: () => void) => () => void;
  }> {
    const root = await this.root(target.workspace);
    const run = this.runs.get(this.key(root, target.configurationId));
    if (
      !run?.child ||
      !["running", "unhealthy"].includes(run.status.state) ||
      !run.config.ports.includes(target.port)
    )
      throw new Error(
        "Preview requires a running service with this port declared in run.json.",
      );
    const url = run.config.urls
      .map((value) => new URL(value))
      .find((value) => Number(value.port) === target.port);
    return {
      host: url?.hostname === "[::1]" ? "::1" : "127.0.0.1",
      port: target.port,
      signal: run.abort.signal,
      track: (close) => {
        run.disconnects.add(close);
        return () => run.disconnects.delete(close);
      },
    };
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    for (const controller of this.sequences.values()) controller.abort();
    await this.tail;
    await Promise.allSettled(this.sequenceSettlements);
    await Promise.all([...this.runs.values()].map((run) => this.stop(run)));
    this.documents.clear();
    this.runs.clear();
    this.receipts.clear();
  }

  private key(root: string, id: string): string {
    return `${root}\0${id}`;
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation, operation);
    this.tail = next.catch(() => undefined);
    return next;
  }
  private async root(workspace: string): Promise<string> {
    return await realpath(await this.authorize(workspace));
  }
  private async cwd(root: string, directory: string): Promise<string> {
    if (isAbsolute(directory) || directory.split(/[\\/]/).includes(".."))
      throw new Error("Working directory must stay inside the project.");
    const candidate = await realpath(resolve(root, directory || "."));
    const rel = relative(root, candidate);
    if (
      rel.startsWith("..") ||
      isAbsolute(rel) ||
      !(await lstat(candidate)).isDirectory()
    )
      throw new Error("Working directory must stay inside the project.");
    return candidate;
  }
  private async configPath(root: string, create: boolean): Promise<string> {
    const directory = join(root, ".machdoch");
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" && !create) return null;
        throw error;
      },
    );
    if (
      info &&
      (!info.isDirectory() ||
        info.isSymbolicLink() ||
        (await realpath(directory)) !== directory)
    )
      throw new Error(
        "The .machdoch directory must be a regular project directory.",
      );
    const path = join(directory, "run.json");
    const file = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (
      file &&
      (!file.isFile() || file.isSymbolicLink() || file.size > 1024 * 1024)
    )
      throw new Error("run.json must be a regular file no larger than 1 MiB.");
    return path;
  }
  private async load(root: string): Promise<DocumentState> {
    const path = await this.configPath(root, false);
    let content = "";
    const file = await open(path, "r").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (file)
      try {
        const buffer = Buffer.alloc(1024 * 1024 + 1);
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
          const next = await file.read(
            buffer,
            bytesRead,
            buffer.length - bytesRead,
            bytesRead,
          );
          if (!next.bytesRead) break;
          bytesRead += next.bytesRead;
        }
        if (bytesRead > 1024 * 1024) throw new Error("run.json exceeds 1 MiB.");
        content = buffer.subarray(0, bytesRead).toString("utf8");
      } finally {
        await file.close();
      }
    const revision = digest(content);
    const cached = this.documents.get(root);
    if (cached?.revision === revision) return cached;
    const document = content
      ? runDocumentSchema.parse(JSON.parse(content))
      : emptyDocument();
    const state = { document, revision };
    this.documents.set(root, state);
    if (this.documents.size > 16)
      for (const [key] of this.documents) {
        if (key !== root && !this.isInUse(key)) {
          this.documents.delete(key);
          break;
        }
      }
    return state;
  }
  private newStatus(id: string): Status {
    return {
      id,
      state: "stopped",
      pid: null,
      startedAt: null,
      exitCode: null,
      restartCount: 0,
      health: null,
      logs: [],
    };
  }

  private async start(
    root: string,
    config: RunTask,
    manual: boolean,
  ): Promise<Run> {
    if (this.stopping) throw new Error("Fleet service is stopping.");
    let run = this.runs.get(this.key(root, config.id));
    if (run?.child) return run;
    const cwd = await this.cwd(root, config.workingDirectory);
    if (this.runs.size >= 64)
      for (const [key, old] of this.runs) {
        if (old !== run && !active(old)) {
          this.runs.delete(key);
          break;
        }
      }
    if ([...this.runs.values()].filter(active).length >= 16 && !run?.desired)
      throw new Error("This host already has 16 active services.");
    for (const port of config.ports) {
      if (
        [...this.runs.values()].some(
          (other) =>
            other !== run && active(other) && other.config.ports.includes(port),
        )
      )
        throw new Error(`Port ${port} is reserved by another service.`);
      if (
        (
          await Promise.all([this.probePort(port), this.probePort(port, "::1")])
        ).some(Boolean)
      )
        throw new Error(
          `Port ${port} is already in use. Stop its current server or choose a different port.`,
        );
    }
    if (!run) {
      run = {
        workspace: root,
        config,
        status: this.newStatus(config.id),
        desired: false,
        generation: 0,
        restarts: [],
        checking: false,
        checkedAt: 0,
        failures: 0,
        abort: new AbortController(),
        disconnects: new Set(),
        sequence: 0,
        logBytes: 0,
      };
      this.runs.set(this.key(root, config.id), run);
    }
    const current = run;
    current.config = config;
    current.desired = true;
    current.generation++;
    current.abort = new AbortController();
    current.termination = undefined;
    setMaxListeners(64, current.abort.signal);
    current.restartAt = undefined;
    current.failures = 0;
    current.checkedAt = Date.now();
    if (manual) {
      current.restarts = [];
      current.status.restartCount = 0;
    }
    current.status = {
      ...current.status,
      state: "starting",
      startedAt: Date.now(),
      exitCode: null,
      health: config.healthCheck ? "Waiting for health check" : null,
    };
    // Environment secrets belonging to the Fleet manager/CLI must not flow into project commands.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !/^(MACHDOCH_|FLEET_MANAGER_|INVOCATION_ID$|NOTIFY_SOCKET$|WATCHDOG_|LISTEN_)|(?:SECRET|TOKEN|PASSWORD|API_KEY)/i.test(
            key,
          ),
      ),
    );
    Object.assign(env, config.environment);
    const child =
      process.platform === "win32"
        ? spawn(config.command, {
            shell: process.env.ComSpec || "cmd.exe",
            cwd,
            env,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          })
        : spawn("/bin/sh", ["-c", config.command], {
            cwd,
            env,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
          });
    current.child = child;
    current.status.pid = child.pid ?? null;
    let complete!: () => void;
    current.done = new Promise<void>((resolveDone) => {
      complete = resolveDone;
    });
    const secrets = [
      ...new Set(
        Object.values(config.environment).flatMap((value) =>
          value.split(/[\r\n]+/),
        ),
      ),
    ]
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    const hideOutput = secrets.length > 128;
    if (hideOutput)
      this.log(
        current,
        "system",
        "Output hidden because the environment has too many secret fragments to redact safely.",
      );
    for (const stream of ["stdout", "stderr"] as const) {
      const decoder = new StringDecoder("utf8");
      let pending = "";
      let discardingLine = false;
      child[stream]?.on("data", (bytes: Buffer) => {
        if (hideOutput) return;
        const decoded = decoder.write(bytes);
        if (discardingLine) {
          const newline = decoded.indexOf("\n");
          if (newline < 0) return;
          pending = decoded.slice(newline + 1);
          discardingLine = false;
        } else pending += decoded;
        // Redact whole lines before truncation, including secrets split across process writes.
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) {
          this.log(
            current,
            stream,
            this.redact(pending.slice(0, end), secrets),
          );
          pending = pending.slice(end + 1);
        }
        if (pending.length > 16384) {
          pending = "";
          discardingLine = true;
          this.log(current, "system", "Oversized output line omitted.");
        }
      });
      child[stream]?.once("end", () => {
        if (pending)
          this.log(
            current,
            stream,
            this.redact(pending + decoder.end(), secrets),
          );
      });
    }
    child.once("spawn", () => {
      if (current.child === child && current.desired) {
        current.status.state = config.healthCheck ? "starting" : "running";
        this.log(current, "system", "Service started.");
      }
    });
    let finished = false;
    const finish = (code: number | null, launchError = false): void => {
      if (finished) return;
      finished = true;
      void (async () => {
        current.abort.abort();
        for (const close of current.disconnects) close();
        current.disconnects.clear();
        current.termination ??= terminateProcessTree(child, true);
        await current.termination;
        child.stdout?.destroy();
        child.stderr?.destroy();
        if (current.child !== child) return;
        current.child = undefined;
        current.status.pid = null;
        current.status.exitCode = code;
        const failed = launchError || code !== 0;
        current.status.state =
          failed && current.desired ? "crashed" : "stopped";
        this.log(
          current,
          "system",
          launchError
            ? "Failed to launch command."
            : `Service exited${code === null ? " after a signal" : ` with code ${code}`}.`,
        );
        if (current.desired && failed && config.restartPolicy.onCrash)
          this.scheduleRestart(current);
        else current.desired = false;
      })().finally(complete);
    };
    child.once("error", () => finish(null, true));
    child.once("exit", (code) => finish(code));
    return current;
  }

  private async stop(run: Run): Promise<void> {
    run.desired = false;
    run.restartAt = undefined;
    run.generation++;
    run.abort.abort();
    for (const close of run.disconnects) close();
    run.disconnects.clear();
    if (run.child) {
      run.status.state = "stopping";
      run.termination ??= terminateProcessTree(run.child);
      await run.termination;
      let deadline: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          run.done,
          new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(
              () =>
                reject(
                  new Error(
                    "The process tree did not stop. Check the service account's permissions and retry Stop.",
                  ),
                ),
              5000,
            );
            deadline.unref();
          }),
        ]);
      } finally {
        clearTimeout(deadline);
      }
    }
    run.status.state = "stopped";
  }
  private scheduleRestart(run: Run): void {
    const now = Date.now();
    const policy = run.config.restartPolicy;
    run.restarts = run.restarts.filter((at) => now - at < policy.windowMs);
    if (run.restarts.length >= policy.maxRestarts) {
      run.desired = false;
      run.status.state = "crashed";
      this.log(
        run,
        "system",
        "Restart limit reached. Inspect logs, then restart manually.",
      );
      return;
    }
    run.restarts.push(now);
    run.status.restartCount++;
    run.restartAt =
      now +
      Math.min(
        policy.maxBackoffMs,
        policy.backoffMs * 2 ** (run.restarts.length - 1),
      );
    run.status.state = "restarting";
  }
  private async startSequence(
    root: string,
    tasks: RunTask[],
    controller: AbortController,
  ): Promise<void> {
    const started: Array<{ run: Run; generation: number }> = [];
    try {
      for (const config of tasks) {
        if (controller.signal.aborted || this.stopping)
          throw new Error("Sequence stopped.");
        const run = await this.serialize(async () => {
          if (controller.signal.aborted) throw new Error("Sequence stopped.");
          const existing = this.runs.get(this.key(root, config.id));
          const wasActive = existing && active(existing);
          const result = await this.start(root, config, true);
          if (!wasActive)
            started.push({ run: result, generation: result.generation });
          return result;
        });
        const deadline = Date.now() + 150000;
        while (
          run.status.state !== "running" ||
          (config.healthCheck && run.status.health !== "Healthy")
        ) {
          if (run.status.state === "stopped" && run.status.exitCode === 0)
            break;
          if (
            controller.signal.aborted ||
            Date.now() > deadline ||
            !run.desired
          )
            throw new Error("A dependency failed to become ready.");
          await new Promise<void>((done) => setTimeout(done, 100));
        }
      }
    } catch {
      await Promise.all(
        started
          .filter(({ run, generation }) => run.generation === generation)
          .map(({ run }) => this.stop(run)),
      );
    }
  }
  private tick(): void {
    const next = cpuTotals();
    const delta = next.total - this.cpu.total;
    this.cpuPercent =
      delta > 0
        ? Math.max(
            0,
            Math.min(100, 100 * (1 - (next.idle - this.cpu.idle) / delta)),
          )
        : null;
    this.cpu = next;
    for (const run of this.runs.values()) {
      if (run.desired && run.restartAt && Date.now() >= run.restartAt) {
        run.restartAt = undefined;
        void this.serialize(async () => {
          if (!run.desired || this.stopping || run.child) return;
          try {
            await this.start(run.workspace, run.config, false);
          } catch {
            this.log(
              run,
              "system",
              "Restart failed; check the working directory and port availability.",
            );
            this.scheduleRestart(run);
          }
        });
      }
      if (
        !run.child ||
        !run.desired ||
        !run.config.healthCheck ||
        run.checking ||
        Date.now() - run.checkedAt < 5000
      )
        continue;
      run.checking = true;
      run.checkedAt = Date.now();
      const generation = run.generation;
      void this.health(run)
        .then(async (healthy) => {
          if (generation !== run.generation || !run.child || !run.desired)
            return;
          run.failures = healthy ? 0 : run.failures + 1;
          run.status.health = healthy ? "Healthy" : "Health check failed";
          run.status.state = healthy
            ? "running"
            : run.failures >= 3
              ? "unhealthy"
              : run.status.state;
          if (
            !healthy &&
            run.failures >= 3 &&
            run.config.healthCheck?.restartOnFailure
          )
            await this.serialize(async () => {
              if (generation !== run.generation || !run.desired) return;
              await this.stop(run);
              run.desired = true;
              this.scheduleRestart(run);
            });
        })
        .finally(() => {
          run.checking = false;
        });
    }
  }
  private probePort(
    port: number,
    host = "127.0.0.1",
    signal?: AbortSignal,
  ): Promise<boolean> {
    return new Promise((done) => {
      const socket = connect({ host, port });
      const finish = (ok: boolean): void => {
        socket.destroy();
        signal?.removeEventListener("abort", abort);
        done(ok);
      };
      const abort = (): void => finish(false);
      socket.setTimeout(1500, () => finish(false));
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  private health(run: Run): Promise<boolean> {
    const check = run.config.healthCheck!;
    if (check.kind === "tcp")
      return this.probePort(
        check.port!,
        check.host === "::1" ? "::1" : "127.0.0.1",
        run.abort.signal,
      );
    return new Promise((done) => {
      const url = new URL(check.url!);
      const req = httpRequest(
        {
          hostname: url.hostname === "[::1]" ? "::1" : "127.0.0.1",
          port: url.port,
          path: url.pathname + url.search,
          method: "GET",
          signal: run.abort.signal,
          agent: false,
          timeout: 2500,
        },
        (res) => {
          done((res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 400);
          res.destroy();
        },
      );
      req.once("timeout", () => req.destroy());
      req.once("error", () => done(false));
      req.end();
    });
  }
  private redact(value: string, secrets: string[]): string {
    for (const secret of secrets)
      value = value.split(secret).join("[redacted]");
    return value;
  }
  private log(
    run: Run,
    stream: Status["logs"][number]["stream"],
    line: string,
  ): void {
    const entry = {
      sequence: ++run.sequence,
      at: Date.now(),
      stream,
      line: stripVTControlCharacters(line)
        .replace(/[\p{Cc}]/gu, (character) => (character === "\t" ? "\t" : ""))
        .slice(0, 1024),
    };
    run.status.logs.push(entry);
    run.logBytes += Buffer.byteLength(JSON.stringify(entry));
    while (run.status.logs.length > 80 || run.logBytes > 64 * 1024)
      run.logBytes -= Buffer.byteLength(
        JSON.stringify(run.status.logs.shift()!),
      );
  }
}
