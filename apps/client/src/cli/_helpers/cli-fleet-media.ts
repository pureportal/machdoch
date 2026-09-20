import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface, type Interface } from "node:readline";
import {
  mediaResponseSchema,
  type MediaRequest,
  type MediaResponse,
} from "@machdoch/fleet-protocol";

export class FleetMediaWorker {
  private worker: ChildProcessWithoutNullStreams | null = null;
  private lines: Interface | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private pending: {
    resolve: (response: MediaResponse) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private stopped = false;

  constructor(
    private readonly executable = process.env.MACHDOCH_NATIVE_EXECUTABLE ??
      fileURLToPath(
        new URL(
          `../../../src-tauri/target/debug/machdoch${process.platform === "win32" ? ".exe" : ""}`,
          import.meta.url,
        ),
      ),
  ) {}

  request(request: MediaRequest): Promise<MediaResponse> {
    const result = this.tail.then(() => this.exchange(request));
    this.tail = result.catch(() => undefined);
    return result;
  }

  close(): void {
    this.stopped = true;
    this.fail(new Error("Fleet media worker stopped."));
  }

  private fail(error: Error): void {
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.lines?.close();
    this.lines = null;
    this.worker?.kill();
    this.worker = null;
  }

  private exchange(request: MediaRequest): Promise<MediaResponse> {
    if (this.stopped)
      return Promise.reject(new Error("Fleet media worker stopped."));
    if (!this.worker) {
      const worker = spawn(this.executable, ["--fleet-media-worker"], {
        windowsHide: true,
        stdio: "pipe",
      });
      this.worker = worker;
      this.lines = createInterface({ input: worker.stdout });
      this.lines.on("line", (line) => {
        if (this.worker !== worker || !this.pending) return;
        try {
          if (line.length > 2 * 1024 * 1024)
            throw new Error("Media worker response exceeded the limit.");
          const response = mediaResponseSchema.parse(JSON.parse(line));
          const pending = this.pending;
          this.pending = null;
          clearTimeout(pending.timer);
          pending.resolve(response);
        } catch {
          this.fail(new Error("Media worker returned an invalid response."));
        }
      });
      worker.stderr.resume();
      worker.once("error", (error) => {
        if (this.worker === worker)
          this.fail(
            new Error(`Native media runtime could not start: ${error.message}`),
          );
      });
      worker.once("exit", () => {
        if (this.worker === worker)
          this.fail(
            new Error(
              "Native media runtime exited. Check Activity before retrying an operation.",
            ),
          );
      });
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(new Error("Media worker did not respond.")),
        20_000,
      );
      this.pending = { resolve, reject, timer };
      this.worker!.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (error) this.fail(error);
      });
    });
  }
}
