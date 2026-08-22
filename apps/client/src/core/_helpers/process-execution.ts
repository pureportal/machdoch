import { execFile } from "node:child_process";

export interface LocalCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface LocalCommandErrorDetails {
  stdout: string;
  stderr: string;
  exitCode?: number;
  errorCode?: string;
  signal?: string;
  timedOut?: boolean;
  timeoutMs?: number;
}

export interface LocalCommandOptions {
  cwd: string;
  timeoutMs: number;
  maxBufferBytes: number;
  acceptedExitCodes?: number[];
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export const normalizeProcessOutput = (value: string | Buffer): string => {
  return value.toString().replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
};

export const normalizeLocalCommandCwd = (
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): string => {
  if (platform !== "win32") {
    return cwd;
  }

  const uncMatch = /^\\\\[?.]\\UNC\\/iu.exec(cwd);

  if (uncMatch) {
    return `\\\\${cwd.slice(uncMatch[0].length)}`;
  }

  const namespaceMatch = /^\\\\[?.]\\/u.exec(cwd);

  if (!namespaceMatch) {
    return cwd;
  }

  const withoutPrefix = cwd.slice(namespaceMatch[0].length);

  return /^[a-z]:[\\/]/i.test(withoutPrefix) ? withoutPrefix : cwd;
};

const getErrorCode = (error: unknown): number | string | undefined => {
  return error instanceof Error &&
    "code" in error &&
    (typeof error.code === "number" || typeof error.code === "string")
    ? error.code
    : undefined;
};

const getErrorSignal = (error: unknown): string | undefined => {
  return error instanceof Error &&
    "signal" in error &&
    typeof error.signal === "string"
    ? error.signal
    : undefined;
};

const isAbortError = (error: unknown): boolean => {
  const code = getErrorCode(error);

  return error instanceof Error && (error.name === "AbortError" || code === "ABORT_ERR");
};

const isTimeoutError = (error: unknown, timeoutMs?: number): boolean => {
  const code = getErrorCode(error);

  if (code === "ETIMEDOUT") {
    return true;
  }

  if (
    error instanceof Error &&
    timeoutMs !== undefined &&
    timeoutMs > 0 &&
    !isAbortError(error) &&
    "killed" in error &&
    error.killed === true &&
    getErrorSignal(error)
  ) {
    return true;
  }

  return false;
};

export const getLocalCommandErrorDetails = (
  error: unknown,
): LocalCommandErrorDetails => {
  const stdout =
    error instanceof Error &&
    "stdout" in error &&
    (typeof error.stdout === "string" || Buffer.isBuffer(error.stdout))
      ? normalizeProcessOutput(error.stdout)
      : "";
  const stderr =
    error instanceof Error &&
    "stderr" in error &&
    (typeof error.stderr === "string" || Buffer.isBuffer(error.stderr))
      ? normalizeProcessOutput(error.stderr)
      : "";
  const code = getErrorCode(error);
  const signal = getErrorSignal(error);
  const timedOut =
    error instanceof Error && "timedOut" in error && error.timedOut === true;
  const timeoutMs =
    error instanceof Error &&
    "timeoutMs" in error &&
    typeof error.timeoutMs === "number" &&
    Number.isFinite(error.timeoutMs)
      ? error.timeoutMs
      : undefined;

  return {
    stdout,
    stderr,
    ...(typeof code === "number" ? { exitCode: code } : {}),
    ...(typeof code === "string" ? { errorCode: code } : {}),
    ...(signal ? { signal } : {}),
    ...(timedOut ? { timedOut: true } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
};

export const executeLocalCommand = async (
  executable: string,
  args: string[],
  options: LocalCommandOptions,
): Promise<LocalCommandResult> => {
  return new Promise((resolve, reject) => {
    execFile(executable, args, {
      cwd: normalizeLocalCommandCwd(options.cwd),
      ...(options.env ? { env: options.env } : {}),
      timeout: options.timeoutMs,
      maxBuffer: options.maxBufferBytes,
      ...(options.signal ? { signal: options.signal } : {}),
      windowsHide: true,
      encoding: "utf8",
    }, (error, stdout, stderr) => {
      const exitCode =
        error &&
        "code" in error &&
        typeof error.code === "number"
          ? error.code
          : undefined;

      if (
        error &&
        (exitCode === undefined ||
          !options.acceptedExitCodes?.includes(exitCode))
      ) {
        reject(
          Object.assign(error, {
            stdout,
            stderr,
            ...(isTimeoutError(error, options.timeoutMs)
              ? { timedOut: true, timeoutMs: options.timeoutMs }
              : {}),
          }),
        );
        return;
      }

      resolve({
        stdout: normalizeProcessOutput(stdout),
        stderr: normalizeProcessOutput(stderr),
        exitCode: exitCode ?? 0,
      });
    });
  });
};

export const formatLocalCommandError = (
  action: string,
  error: unknown,
): string => {
  const details = getLocalCommandErrorDetails(error);
  const stderr = details.stderr || (error instanceof Error ? error.message : String(error));

  return [
    action,
    details.exitCode !== undefined ? `exit code: ${details.exitCode}` : undefined,
    details.errorCode ? `error code: ${details.errorCode}` : undefined,
    details.timedOut && details.timeoutMs !== undefined
      ? `timed out after ${details.timeoutMs}ms`
      : undefined,
    details.signal ? `signal: ${details.signal}` : undefined,
    details.stdout ? `stdout: ${details.stdout}` : undefined,
    stderr ? `stderr: ${stderr}` : undefined,
  ]
    .filter((part): part is string => typeof part === "string")
    .join("\n");
};
