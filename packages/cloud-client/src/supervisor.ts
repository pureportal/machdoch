import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

type NativeEvent = Record<string, unknown> & { kind: string };
interface Waiter {
  accept: (event: NativeEvent) => boolean;
  resolve: (event: NativeEvent) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class NativeSupervisor {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly waiters = new Set<Waiter>();
  private buffer: Buffer = Buffer.alloc(0);
  private failure: Error | undefined;
  private diagnostics = "";
  readonly finished: Promise<void>;
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private inputQueue: Promise<void> = Promise.resolve();
  private queuedInputs = 0;
  private inputEnded = false;

  constructor(
    executable: string,
    private readonly onOutput?: (
      kind: "stdout" | "stderr",
      bytes: Buffer,
    ) => void,
  ) {
    this.signal = this.controller.signal;
    this.process = spawn(executable, [], {
      windowsHide: true,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {},
    });
    this.finished = new Promise((resolve) => {
      this.process.once("close", () => {
        this.fail(new Error("Sandbox supervisor stopped"));
        resolve();
      });
      this.process.once("error", (error) => {
        this.fail(error);
        resolve();
      });
    });
    this.process.stdin.on("error", (error) => this.fail(error));
    this.process.stderr.on("data", (data: Buffer) => {
      this.diagnostics = (this.diagnostics + data.toString("utf8")).slice(
        -16384,
      );
    });
    this.process.stdout.on("data", (data: Buffer) => this.consume(data));
  }

  private fail(error: Error): void {
    this.failure ??= error;
    this.controller.abort(this.failure);
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(this.failure);
    }
    this.waiters.clear();
    this.requestStop();
  }

  private requestStop(): void {
    if (!this.process.stdin.writableEnded && !this.process.stdin.destroyed)
      this.process.stdin.end(JSON.stringify({ kind: "stop" }) + "\n");
  }

  private consume(bytes: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, bytes]);
    if (this.buffer.length > 1024 * 1024) {
      this.fail(new Error("Supervisor output exceeds its limit"));
      this.process.kill();
      return;
    }
    let newline;
    while ((newline = this.buffer.indexOf(10)) >= 0) {
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      let event: NativeEvent;
      try {
        event = JSON.parse(line.toString("utf8")) as NativeEvent;
        if (!event || typeof event.kind !== "string")
          throw new Error("Invalid event");
      } catch {
        this.fail(new Error("Invalid supervisor response"));
        this.process.kill();
        return;
      }
      if (event.kind === "error") {
        this.fail(
          new Error(
            typeof event.message === "string"
              ? event.message
              : "Supervisor failed",
          ),
        );
        continue;
      }
      if (
        (event.kind === "stdout" || event.kind === "stderr") &&
        typeof event.data === "string"
      ) {
        const bytes = Buffer.from(event.data, "base64");
        this.diagnostics = (this.diagnostics + bytes.toString("utf8")).slice(
          -16384,
        );
        try {
          this.onOutput?.(event.kind, bytes);
        } catch {
          this.fail(new Error("Sandbox output consumer failed"));
          return;
        }
      }
      for (const waiter of this.waiters) {
        if (!waiter.accept(event)) continue;
        this.waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(event);
      }
    }
  }

  private command(
    value: Record<string, unknown>,
    accept: Waiter["accept"],
  ): Promise<NativeEvent> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        accept,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.fail(
            new Error("Sandbox supervisor did not acknowledge the command"),
          );
        }, 5000),
      };
      this.waiters.add(waiter);
      this.process.stdin.write(JSON.stringify(value) + "\n", (error) => {
        if (error) this.fail(error);
      });
    });
  }

  async anchor(): Promise<string> {
    const id = randomUUID();
    await this.command(
      { kind: "anchor", id },
      (event) => event.kind === "anchored" && event.id === id,
    );
    return id;
  }

  async prepareReceipt(
    receiptPath: string,
    environmentId: string,
    cgroupRoot?: string,
  ): Promise<void> {
    await this.command(
      {
        kind: "prepare",
        receipt_path: receiptPath,
        environment_id: environmentId,
        cgroup_root: cgroupRoot,
      },
      (event) =>
        event.kind === "prepared" && event.environmentId === environmentId,
    );
  }

  get processId(): number | undefined {
    return this.process.pid;
  }

  async start(input: {
    anchorId: string;
    allowanceMs: number;
    maxDurationMs: number;
    memoryLimitBytes: number;
    program: string;
    args: string[];
    directory: string;
    environment: Record<string, string>;
  }): Promise<number> {
    const event = await this.command(
      {
        kind: "start",
        anchor_id: input.anchorId,
        allowance_ms: input.allowanceMs,
        max_duration_ms: input.maxDurationMs,
        memory_limit_bytes: input.memoryLimitBytes,
        program: input.program,
        args: input.args,
        directory: input.directory,
        environment: input.environment,
      },
      (event) => event.kind === "started",
    );
    if (!Number.isSafeInteger(event.pid) || Number(event.pid) <= 0)
      throw new Error("Invalid sandbox process identity");
    return Number(event.pid);
  }

  async renew(anchorId: string, allowanceMs: number): Promise<void> {
    await this.command(
      { kind: "renew", anchor_id: anchorId, allowance_ms: allowanceMs },
      (event) => event.kind === "renewed" && event.id === anchorId,
    );
  }

  async writeInput(bytes: Uint8Array | null): Promise<void> {
    if (this.failure) throw this.failure;
    if (bytes && bytes.byteLength > 512 * 1024)
      throw new Error("Sandbox input exceeds 512 KiB");
    if (this.inputEnded || this.queuedInputs >= 16)
      throw new Error("Sandbox input is closed or its queue is full");
    const payload = bytes === null ? null : Buffer.from(bytes);
    if (payload === null) this.inputEnded = true;
    this.queuedInputs++;
    const write = this.inputQueue.then(async () => {
      let offset = 0;
      do {
        const id = randomUUID();
        const part = payload?.subarray(offset, offset + 65536);
        await this.command(
          { kind: "input", id, data: part ? part.toString("base64") : null },
          (event) => event.kind === "input_written" && event.id === id,
        );
        offset += 65536;
      } while (payload && offset < payload.length);
    });
    this.inputQueue = write.catch((error: unknown) => {
      this.fail(
        error instanceof Error ? error : new Error("Sandbox input failed"),
      );
    });
    try {
      await write;
    } finally {
      this.queuedInputs--;
    }
  }

  async close(): Promise<void> {
    if (this.process.exitCode === null && this.process.signalCode === null)
      this.requestStop();
    await this.finished;
    if (this.process.exitCode !== 0)
      throw this.failure ?? new Error("Sandbox termination failed");
  }
}
