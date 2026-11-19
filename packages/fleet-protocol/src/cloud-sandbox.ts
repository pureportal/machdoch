export const sandboxArtifactNames = [
  "supervisor",
  "qemu",
  "kernel",
  "initramfs",
  "image",
] as const;
export type SandboxArtifactName = (typeof sandboxArtifactNames)[number];
export type SandboxBackend = "whpx" | "kvm";
export type SandboxRequirement = SandboxArtifactName | "cgroup";

export interface ExecutionSandbox {
  directory: string;
  missing: SandboxRequirement[];
}
