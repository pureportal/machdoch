import { execFile } from "node:child_process";

export interface LocalCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
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

export const executeLocalCommand = async (
  executable: string,
  args: string[],
  options: LocalCommandOptions,
): Promise<LocalCommandResult> => {
  return new Promise((resolve, reject) => {
    execFile(executable, args, {
      cwd: options.cwd,
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
  const stdout =
    error instanceof Error &&
    "stdout" in error &&
    (typeof error.stdout === "string" || Buffer.isBuffer(error.stdout))
      ? normalizeProcessOutput(error.stdout)
      : "";
  const stderrOutput =
    error instanceof Error &&
    "stderr" in error &&
    (typeof error.stderr === "string" || Buffer.isBuffer(error.stderr))
      ? normalizeProcessOutput(error.stderr)
      : "";
  const stderr =
    stderrOutput || (error instanceof Error ? error.message : String(error));
  const exitCode =
    error instanceof Error && "code" in error && typeof error.code === "number"
      ? error.code
      : undefined;

  return [
    action,
    exitCode !== undefined ? `exit code: ${exitCode}` : undefined,
    stdout ? `stdout: ${stdout}` : undefined,
    stderr ? `stderr: ${stderr}` : undefined,
  ]
    .filter((part): part is string => typeof part === "string")
    .join("\n");
};
