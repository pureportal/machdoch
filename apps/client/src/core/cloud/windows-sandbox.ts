import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, parse } from "node:path";
import { randomUUID } from "node:crypto";
import { satisfies } from "semver";
import {
  probe,
  spawn,
  type ContainerRequest,
  type MxcProcess,
} from "@microsoft/mxc-sdk/v1";
import { within } from "./repository.js";
import { quoteWindowsArgument } from "../_helpers/windows-command-line.js";
import { z } from "zod";

export const windowsClientSandboxInputSchema = z.strictObject({
  access: z.enum(["workspace", "read-only"]),
  executable: z.string().min(1).max(32768),
  arguments: z.array(z.string().max(8192)).max(100),
  checkoutDirectory: z.string().min(1).max(32768),
  stateDirectory: z.string().min(1).max(32768),
  readonlyPaths: z.array(z.string().min(1).max(32768)).max(32),
  durationMs: z
    .number()
    .int()
    .min(1)
    .max(24 * 60 * 60 * 1000),
});
export type WindowsClientSandboxInput = z.infer<
  typeof windowsClientSandboxInputSchema
>;

async function canonicalPath(
  path: string,
  directory: boolean,
): Promise<string> {
  if (!isAbsolute(path)) throw new Error("Sandbox paths must be absolute.");
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || (directory && !metadata.isDirectory()))
    throw new Error(
      "Sandbox paths cannot be redirected through symbolic links.",
    );
  const canonical = await realpath(path);
  if (canonical === parse(canonical).root)
    throw new Error("Sandbox access cannot cover an entire drive.");
  return canonical;
}

export async function windowsClientSandboxRequest(
  input: WindowsClientSandboxInput,
): Promise<ContainerRequest> {
  if (process.platform !== "win32")
    throw new Error("This sandbox requires Windows process containers.");
  if (input.access !== "workspace" && input.access !== "read-only")
    throw new Error("Choose an explicit sandbox access mode.");
  if (!satisfies(process.versions.node, ">=24.21.0 <25 || >=26.8.0"))
    throw new Error("Client sandboxing requires Node.js 24.21+ or 26.8+.");
  if (
    !Number.isSafeInteger(input.durationMs) ||
    input.durationMs < 1 ||
    input.durationMs > 24 * 60 * 60 * 1000
  )
    throw new Error("Sandbox duration must be between 1 ms and 24 hours.");
  const checkout = await canonicalPath(input.checkoutDirectory, true);
  const state = await canonicalPath(input.stateDirectory, true);
  if (within(checkout, state) || within(state, checkout))
    throw new Error("Sandbox state and checkout directories must be separate.");
  const executable = await canonicalPath(input.executable, false);
  if (!(await lstat(executable)).isFile() || !executable.endsWith(".exe"))
    throw new Error("Choose a Windows executable for the sandbox runtime.");
  const readonlyPaths = [executable];
  for (const path of input.readonlyPaths)
    readonlyPaths.push(await canonicalPath(path, false));
  for (const path of readonlyPaths) {
    if (
      within(path, checkout) ||
      within(checkout, path) ||
      within(path, state) ||
      within(state, path)
    )
      throw new Error(
        "Sandbox runtime files must be outside writable directories.",
      );
  }
  if (!process.env.SystemRoot)
    throw new Error("Windows SystemRoot is unavailable. Restart Machdoch.");
  const systemRoot = await realpath(process.env.SystemRoot);
  return {
    containment: {
      type: "processcontainer",
      config: {
        ui: {
          isolation: "container",
          desktopSystemControl: false,
          systemSettings: "none",
          ime: false,
        },
      },
    },
    containerName: `machdoch-${randomUUID()}`,
    command: [executable, ...input.arguments]
      .map(quoteWindowsArgument)
      .join(" "),
    workingDirectory: checkout,
    environment: {
      SystemRoot: systemRoot,
      PATH: [dirname(executable), join(systemRoot, "System32")].join(";"),
      HOME: state,
      USERPROFILE: state,
      APPDATA: state,
      LOCALAPPDATA: state,
      TEMP: state,
      TMP: state,
      MACHDOCH_USER_CONFIG_DIR: state,
      NODE_OPTIONS: "--preserve-symlinks --preserve-symlinks-main",
    },
    inheritDefaultEnvironment: false,
    filesystem: {
      readonlyPaths: [
        ...new Set(
          input.access === "read-only"
            ? [...readonlyPaths, checkout, state]
            : readonlyPaths,
        ),
      ],
      readwritePaths: input.access === "read-only" ? [] : [checkout, state],
      clearPolicyOnExit: true,
    },
    network: {
      egress: { default: "deny" },
      ingress: { default: "deny", hostLoopback: "deny" },
    },
    ui: { disable: false, clipboard: "none", allowInputInjection: false },
    timeoutMs: input.durationMs,
  };
}

export async function spawnWindowsClientSandbox(
  input: WindowsClientSandboxInput,
): Promise<MxcProcess> {
  const request = await windowsClientSandboxRequest(input);
  return spawnWindowsContainer(request);
}

export async function spawnWindowsContainer(
  request: ContainerRequest,
): Promise<MxcProcess> {
  const support = probe(request);
  if (
    support.tier !== "base-container" ||
    support.error ||
    support.needsDaclAugmentation ||
    support.warnings.length
  )
    throw new Error("Windows cannot enforce this client sandbox policy.");
  const child = await spawn(request, { telemetry: { enabled: false } });
  if (child.warnings.length) {
    try {
      child.kill();
      await child.wait();
    } finally {
      child.dispose();
    }
    throw new Error("The client sandbox could not enforce its launch policy.");
  }
  return child;
}
