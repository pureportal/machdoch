import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";

let compilerDirectory: string | undefined;
let lockerExecutable: Promise<string> | undefined;

const compileFileLocker = async (): Promise<string> => {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) throw new Error("Windows SystemRoot is required.");
  compilerDirectory = await mkdtemp(join(tmpdir(), "ralph-file-locker-"));
  const executable = join(compilerDirectory, "locker.exe");
  await promisify(execFile)(
    join(systemRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    [
      "/nologo",
      `/out:${executable}`,
      fileURLToPath(
        new URL("./fixtures/windows-file-lock.cs", import.meta.url),
      ),
    ],
    { windowsHide: true, timeout: 30_000 },
  );
  return executable;
};

afterAll(async () => {
  if (compilerDirectory)
    await rm(compilerDirectory, { recursive: true, force: true });
});

export const lockWindowsFileReplacement = async (path: string) => {
  const child = spawn(await prepareWindowsFileLocker(), [path], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
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
        30_000,
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

export const prepareWindowsFileLocker = (): Promise<string> =>
  (lockerExecutable ??= compileFileLocker());
