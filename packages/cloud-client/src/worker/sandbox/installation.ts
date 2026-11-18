import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  sandboxArtifactNames,
  type SandboxArtifactName,
  type SandboxBackend,
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
function artifactCandidates(): Record<SandboxArtifactName, string[]> {
  const repositoryRoot = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../..",
  );
  return {
    supervisor: [
      join(sandboxDirectory, `machdoch-cloud-supervisor${executable}`),
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
    kernel: [join(sandboxDirectory, "vmlinuz-virt")],
    initramfs: [join(sandboxDirectory, "initramfs")],
    image: [join(sandboxDirectory, "root.qcow2")],
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
