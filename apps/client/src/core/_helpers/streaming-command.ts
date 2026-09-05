import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { normalizeLocalCommandCwd } from "./process-cwd.js";
import { terminateProcessTree } from "./process-tree.js";

interface CommandProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const normalizeShellOutput = (value: string): string => {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
};

const createCommandProcessError = (
  message: string,
  result: {
    stdout: string;
    stderr: string;
    exitCode?: number;
  },
): Error & { stdout: string; stderr: string; code?: number } => {
  const error = new Error(message) as Error & {
    stdout: string;
    stderr: string;
    code?: number;
  };

  error.stdout = result.stdout;
  error.stderr = result.stderr;

  if (result.exitCode !== undefined) {
    error.code = result.exitCode;
  }

  return error;
};

const getAbortReasonMessage = (signal: AbortSignal | undefined): string => {
  const reason = signal?.reason;

  if (reason instanceof Error && reason.message.trim().length > 0) {
    return reason.message;
  }

  if (typeof reason === "string" && reason.trim().length > 0) {
    return reason;
  }

  return "Execution cancelled by user.";
};

export const runStreamingCommand = async (
  shellExecutable: string,
  shellArgs: string[],
  options: {
    cwd: string;
    timeoutMs: number;
    maxBufferBytes: number;
    acceptedExitCodes?: number[];
    env?: NodeJS.ProcessEnv;
    shell?: boolean;
    input?: string | Buffer;
    normalizeOutput?: boolean;
    // A synchronous consumer can parse large/binary stdout incrementally.
    // When supplied, stdout is neither decoded nor retained by this runner.
    onStdoutBytes?: (chunk: Buffer) => void;
    signal?: AbortSignal;
    onOutput?: (output: {
      stream: "stdout" | "stderr";
      chunk: string;
    }) => void | Promise<void>;
  },
): Promise<CommandProcessResult> => {
  if (options.signal?.aborted) {
    throw Object.assign(
      createCommandProcessError(getAbortReasonMessage(options.signal), {
        stdout: "",
        stderr: "",
      }),
      { name: "AbortError", code: "ABORT_ERR" },
    );
  }

  return new Promise((resolve, reject) => {
    const cwd = normalizeLocalCommandCwd(options.cwd);
    const child = spawn(shellExecutable, shellArgs, {
      cwd,
      ...(options.env ? { env: options.env } : {}),
      ...(options.shell ? { shell: true } : {}),
      detached: process.platform !== "win32",
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const chunks = {
      stdout: [] as string[],
      stderr: [] as string[],
    };
    const decoders = {
      stdout: new StringDecoder("utf8"),
      stderr: new StringDecoder("utf8"),
    };
    let outputBytes = 0;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let exceededBuffer = false;
    let processError: Error | undefined;
    let outputHandlerError: unknown;
    let outputHandlerFailed = false;
    let pendingOutputHandlers = 0;
    let termination: Promise<void> | undefined;
    let childExit:
      | { code: number | null; signal: NodeJS.Signals | null }
      | undefined;
    let childClosed = false;
    let settlementTimer: ReturnType<typeof setTimeout> | undefined;

    const stop = (force = false): void => {
      if (settled || termination) return;
      if (childClosed) {
        finish(childExit?.code ?? null, childExit?.signal ?? null);
        return;
      }
      termination = terminateProcessTree(child, force);
      // A descendant may keep inherited pipes open forever. Settlement must
      // not depend on Node receiving the child's `close` event.
      void termination.then(() => {
        if (settled) return;
        if (childClosed) {
          finish(childExit?.code ?? null, childExit?.signal ?? null);
        } else {
          settlementTimer = setTimeout(
            () => finish(childExit?.code ?? null, childExit?.signal ?? null),
            1_000,
          );
        }
      });
    };

    const timeoutHandle =
      options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            stop();
          }, options.timeoutMs)
        : undefined;

    const cleanup = (): void => {
      clearTimeout(timeoutHandle);
      clearTimeout(settlementTimer);
      options.signal?.removeEventListener("abort", handleAbort);
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      child.stdout?.destroy?.();
      child.stderr?.destroy?.();
      child.stdin?.destroy?.();
    };

    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      callback();
    };

    function handleAbort(): void {
      if (settled || aborted) {
        return;
      }

      aborted = true;
      stop();
    }

    options.signal?.addEventListener("abort", handleAbort, { once: true });

    if (options.signal?.aborted) {
      handleAbort();
    }

    const appendOutput = (
      stream: "stdout" | "stderr",
      value: string | Buffer,
    ): void => {
      if (
        settled ||
        timedOut ||
        aborted ||
        exceededBuffer ||
        processError !== undefined ||
        outputHandlerFailed
      )
        return;
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (stream === "stdout" && options.onStdoutBytes) {
        try {
          options.onStdoutBytes(bytes);
        } catch (error) {
          outputHandlerFailed = true;
          outputHandlerError = error;
          stop();
        }
        return;
      }
      const remaining = Math.max(0, options.maxBufferBytes - outputBytes);
      const chunk = decoders[stream].write(bytes.subarray(0, remaining));
      outputBytes += Math.min(bytes.length, remaining);
      if (chunk) chunks[stream].push(chunk);

      const handleOutputError = (error: unknown): void => {
        if (settled) return;
        if (!outputHandlerFailed) {
          outputHandlerError = error;
          outputHandlerFailed = true;
        }
        stop();
      };

      try {
        const output = chunk
          ? options.onOutput?.({ stream, chunk })
          : undefined;
        if (output) {
          const reader = stream === "stdout" ? child.stdout : child.stderr;
          reader?.pause();
          pendingOutputHandlers += 1;
          void output.catch(handleOutputError).finally(() => {
            pendingOutputHandlers -= 1;
            if (!settled) reader?.resume();
            if (childClosed) {
              if (termination) {
                void termination.then(() =>
                  finish(childExit?.code ?? null, childExit?.signal ?? null),
                );
              } else {
                finish(childExit?.code ?? null, childExit?.signal ?? null);
              }
            }
          });
        }
      } catch (error) {
        handleOutputError(error);
      }

      if (bytes.length > remaining && !exceededBuffer) {
        exceededBuffer = true;
        stop();
      }
    };

    child.stdout?.on("data", (chunk: string | Buffer) => {
      appendOutput("stdout", chunk);
    });
    child.stderr?.on("data", (chunk: string | Buffer) => {
      appendOutput("stderr", chunk);
    });
    const handleProcessError = (error: Error): void => {
      processError ??= error;
      if (child.pid === undefined) {
        finish(null, null);
      } else {
        stop(true);
      }
    };
    child.once("error", handleProcessError);
    child.stdout?.once("error", handleProcessError);
    child.stderr?.once("error", handleProcessError);
    child.stdin?.once("error", handleProcessError);
    if (options.input !== undefined) child.stdin?.end(options.input);
    child.once("exit", (code, signal) => {
      childExit = { code, signal };
      if (process.platform !== "win32") {
        stop(true);
      } else if (!termination) {
        // Usually `close` follows immediately. Avoid spawning taskkill for
        // every successful command; only recover if inherited pipes stay open.
        settlementTimer = setTimeout(() => stop(true), 1_000);
      }
    });
    child.once("close", (code, signal) => {
      clearTimeout(settlementTimer);
      settlementTimer = undefined;
      childClosed = true;
      childExit = { code, signal };
      if (termination) {
        void termination.then(() => finish(code, signal));
      } else {
        finish(code, signal);
      }
    });
    function finish(code: number | null, signal: NodeJS.Signals | null): void {
      if (
        pendingOutputHandlers > 0 &&
        !timedOut &&
        !aborted &&
        !exceededBuffer &&
        !processError &&
        !outputHandlerFailed
      )
        return;
      settle(() => {
        if (!exceededBuffer) {
          chunks.stdout.push(decoders.stdout.end());
          chunks.stderr.push(decoders.stderr.end());
        }
        const stdout = chunks.stdout.join("");
        const stderr = chunks.stderr.join("");

        if (processError) {
          reject(Object.assign(processError, { stdout, stderr }));
          return;
        }

        if (timedOut) {
          reject(
            Object.assign(
              createCommandProcessError(
                `Command timed out after ${options.timeoutMs}ms.`,
                { stdout, stderr },
              ),
              {
                timedOut: true,
                timeoutMs: options.timeoutMs,
                code: "ETIMEDOUT",
              },
            ),
          );
          return;
        }

        if (aborted) {
          reject(
            Object.assign(
              createCommandProcessError(getAbortReasonMessage(options.signal), {
                stdout,
                stderr,
              }),
              { name: "AbortError", code: "ABORT_ERR" },
            ),
          );
          return;
        }

        if (outputHandlerFailed) {
          reject(
            createCommandProcessError(
              `Command output handler failed: ${
                outputHandlerError instanceof Error
                  ? outputHandlerError.message
                  : String(outputHandlerError)
              }`,
              { stdout, stderr },
            ),
          );
          return;
        }

        if (exceededBuffer) {
          reject(
            createCommandProcessError(
              `Command output exceeded ${options.maxBufferBytes} bytes.`,
              { stdout, stderr },
            ),
          );
          return;
        }

        if (code === null) {
          reject(
            Object.assign(
              createCommandProcessError(
                `Command terminated by signal ${signal ?? "unknown"}.`,
                { stdout, stderr },
              ),
              { signal },
            ),
          );
          return;
        }

        const exitCode = code;

        if (exitCode !== 0 && !options.acceptedExitCodes?.includes(exitCode)) {
          reject(
            createCommandProcessError(
              `Command failed with exit code ${exitCode}.`,
              { stdout, stderr, exitCode },
            ),
          );
          return;
        }

        resolve({
          stdout:
            options.normalizeOutput === false
              ? stdout
              : normalizeShellOutput(stdout),
          stderr:
            options.normalizeOutput === false
              ? stderr
              : normalizeShellOutput(stderr),
          exitCode,
        });
      });
    }
  });
};
