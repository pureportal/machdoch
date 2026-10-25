import { spawn } from "node:child_process";

export function fileTool(
  tool: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "/usr/bin/python3",
      [
        "-I",
        "/opt/machdoch/exec.py",
        "/usr/bin/node",
        "/opt/machdoch/file-worker.ts",
        tool,
      ],
      {
        cwd: "/workspace",
        stdio: ["pipe", "pipe", "pipe"],
        env: { HOME: "/workspace", PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
      },
    );
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    let diagnostics = "";
    const timer = setTimeout(() => {
      failure = new Error("File operation timed out");
      child.kill("SIGKILL");
    }, 30000);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) {
        failure = new Error("File response exceeds its limit");
        child.kill("SIGKILL");
      } else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      diagnostics = (diagnostics + chunk.toString("utf8")).slice(-4096);
    });
    child.stdin.on("error", (error) => {
      failure = error;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failure || code !== 0) {
        reject(failure ?? new Error(`File worker failed: ${diagnostics}`));
        return;
      }
      try {
        const response = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          ok: boolean;
          result?: unknown;
          error?: string;
        };
        if (!response.ok)
          throw new Error(response.error ?? "File operation failed");
        resolve(response.result);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
