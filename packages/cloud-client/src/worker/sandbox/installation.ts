import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  sandboxArtifactNames,
  type SandboxArtifactName,
  type SandboxBackend,
  type SandboxRequirement,
} from "@machdoch/fleet-protocol/cloud-sandbox";
import {
  fileDigest,
  type RuntimeAsset,
} from "@machdoch/cloud-client/runtime-assets";

export const machdochDataDirectory = join(homedir(), ".machdoch-cloud");
export const sandboxDirectory = join(machdochDataDirectory, "sandbox");
export const hostSandboxBackend: SandboxBackend =
  process.platform === "win32" ? "whpx" : "kvm";

const executable = process.platform === "win32" ? ".exe" : "";
const packagedSandboxDirectories =
  process.platform === "win32" ? [] : ["/usr/lib/machdoch-cloud/sandbox"];
function artifactCandidates(): Record<SandboxArtifactName, string[]> {
  const repositoryRoot = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../..",
  );
  const directories = [sandboxDirectory, ...packagedSandboxDirectories];
  const located = (file: string) =>
    directories.map((directory) => join(directory, file));
  return {
    supervisor: [
      ...located(`machdoch-cloud-supervisor${executable}`),
      join(
        repositoryRoot,
        `apps/cloud-runner/native/target/release/machdoch-cloud-supervisor${executable}`,
      ),
    ],
    qemu: [
      join(sandboxDirectory, `qemu-system-x86_64${executable}`),
      ...(process.platform === "win32"
        ? ["C:\\Program Files\\qemu\\qemu-system-x86_64.exe"]
        : ["/usr/bin/qemu-system-x86_64", "/usr/local/bin/qemu-system-x86_64"]),
    ],
    kernel: located("vmlinuz-virt"),
    initramfs: located("initramfs"),
    image: located("root.qcow2"),
  };
}

export class SandboxArtifactError extends Error {
  constructor(readonly artifact: SandboxArtifactName) {
    super(`The sandbox ${artifact} is not a readable file.`);
  }
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

export async function detectSandboxArtifacts(): Promise<
  Record<SandboxArtifactName, string>
> {
  const candidates = artifactCandidates();
  const detected = {} as Record<SandboxArtifactName, string>;
  for (const name of sandboxArtifactNames) {
    detected[name] = "";
    for (const candidate of candidates[name])
      if (await isRegularFile(candidate)) {
        detected[name] = candidate;
        break;
      }
  }
  return detected;
}

export async function pinSandboxArtifacts(
  paths: Record<SandboxArtifactName, string>,
): Promise<Record<SandboxArtifactName, RuntimeAsset>> {
  const pinned = {} as Record<SandboxArtifactName, RuntimeAsset>;
  for (const name of sandboxArtifactNames) {
    const path = paths[name];
    if (!isAbsolute(path) || !(await isRegularFile(path)))
      throw new SandboxArtifactError(name);
    pinned[name] = { path, sha256: await fileDigest(path) };
  }
  return pinned;
}

export interface HostSandboxLocation {
  artifacts: Record<SandboxArtifactName, string>;
  cgroupRoot: string | null;
  missing: SandboxRequirement[];
}

const cgroupMount = "/sys/fs/cgroup";
const serverCgroup = "machdoch-server";
const sandboxControllers = "+cpu +memory +pids";
let delegatedCgroup: string | null = null;

async function moveProcesses(from: string, to: string): Promise<void> {
  const pids = (await readFile(join(from, "cgroup.procs"), "utf8"))
    .split("\n")
    .filter(Boolean);
  for (const pid of pids)
    await writeFile(join(to, "cgroup.procs"), pid).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ESRCH") throw error;
      },
    );
}

async function prepareDelegatedCgroup(): Promise<string | null> {
  if (delegatedCgroup) return delegatedCgroup;
  const membership = (await readFile("/proc/self/cgroup", "utf8"))
    .split("\n")
    .find((line) => line.startsWith("0::"));
  if (!membership) return null;
  let own = join(cgroupMount, membership.slice(3).trim());
  if (basename(own) === serverCgroup) own = dirname(own);
  const server = join(own, serverCgroup);
  const root = join(own, "machdoch-sandbox");
  await mkdir(server, { recursive: true });
  await moveProcesses(own, server);
  await writeFile(join(own, "cgroup.subtree_control"), sandboxControllers);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "cgroup.subtree_control"), sandboxControllers);
  delegatedCgroup = await realpath(root);
  return delegatedCgroup;
}

export async function locateHostSandbox(): Promise<HostSandboxLocation> {
  const artifacts = await detectSandboxArtifacts();
  const missing: SandboxRequirement[] = sandboxArtifactNames.filter(
    (name) => !artifacts[name],
  );
  if (hostSandboxBackend === "whpx")
    return { artifacts, cgroupRoot: null, missing };
  const cgroupRoot = await prepareDelegatedCgroup().catch(() => null);
  if (!cgroupRoot) missing.push("cgroup");
  return { artifacts, cgroupRoot, missing };
}
