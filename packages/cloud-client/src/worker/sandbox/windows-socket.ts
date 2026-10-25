import { execFile, spawn } from "node:child_process";
import { Duplex, Readable, Writable } from "node:stream";
import { promisify } from "node:util";

export async function prepareWindowsSocketDirectory(
  executable: string,
  directory: string,
) {
  await promisify(execFile)(executable, ["--socket-directory", directory], {
    windowsHide: true,
    env: process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {},
    timeout: 5000,
    maxBuffer: 4096,
  });
}

export function openWindowsSocket(executable: string, directory: string) {
  const child = spawn(executable, ["--socket-proxy"], {
    cwd: directory,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {},
  });
  const stream = Duplex.fromWeb({
    readable: Readable.toWeb(child.stdout),
    writable: Writable.toWeb(child.stdin),
  });
  let diagnostics = "";
  child.stderr.on("data", (bytes: Buffer) => {
    diagnostics = (diagnostics + bytes.toString("utf8")).slice(-4096);
  });
  child.on("error", (error) => stream.destroy(error));
  const exited = new Promise<void>((resolve) =>
    child.once("close", (code) => {
      if (!stream.destroyed)
        stream.destroy(
          code === 0
            ? undefined
            : new Error(diagnostics.trim() || "The VM socket bridge stopped"),
        );
      resolve();
    }),
  );
  return {
    stream,
    async close() {
      stream.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    },
  };
}
