import { spawn } from "node:child_process";
import { once } from "node:events";

export const lockWindowsFileReplacement = async (path: string) => {
  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference = 'Stop'; $lock = [System.IO.File]::Open($env:RALPH_LOCK_TEST_PATH, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read); try { [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null } finally { $lock.Dispose() }",
    ],
    {
      env: { ...process.env, RALPH_LOCK_TEST_PATH: path },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      let stdout = "";
      const timeout = setTimeout(
        () => reject(new Error("Windows file lock did not become ready.")),
        10_000,
      );
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        if (stdout.includes("locked")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Windows file lock exited ${code}: ${stderr}`));
      });
    });
  } catch (error) {
    child.kill();
    await exited.catch(() => undefined);
    throw error;
  }
  let release: Promise<void> | undefined;
  return () =>
    (release ??= (async () => {
      child.stdin.end("\n");
      const [code] = await exited;
      if (code !== 0)
        throw new Error(`Windows file lock exited ${code}: ${stderr}`);
    })());
};
