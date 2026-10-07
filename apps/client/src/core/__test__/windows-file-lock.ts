import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";

let compilerDirectory: string | undefined;
let lockerExecutable: Promise<string> | undefined;

const compileFileLocker = async (): Promise<string> => {
  const systemRootKey = Object.keys(process.env).find(
    (key) => key.toLowerCase() === "systemroot",
  );
  const systemRoot = systemRootKey ? process.env[systemRootKey] : undefined;
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
  if (compilerDirectory) {
    if (
      dirname(resolve(compilerDirectory)) !== resolve(tmpdir()) ||
      !basename(compilerDirectory).startsWith("ralph-file-locker-")
    ) {
      throw new Error("Unexpected Windows file-locker directory.");
    }
    await rm(compilerDirectory, { recursive: true, force: true });
  }
});

const lockWindowsFile = async (path: string, sharing: "read" | "none") => {
  const child = spawn(await prepareWindowsFileLocker(), [path, sharing], {
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

export const lockWindowsFileReplacement = (path: string) =>
  lockWindowsFile(path, "read");

export const lockWindowsFileRead = (path: string) =>
  lockWindowsFile(path, "none");

export const prepareWindowsFileLocker = (): Promise<string> =>
  (lockerExecutable ??= compileFileLocker());
