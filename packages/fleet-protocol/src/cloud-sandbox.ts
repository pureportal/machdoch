import { z } from "zod";

export const sandboxArtifactNames = [
  "supervisor",
  "qemu",
  "kernel",
  "initramfs",
  "image",
] as const;
export type SandboxArtifactName = (typeof sandboxArtifactNames)[number];
export type SandboxBackend = "whpx" | "kvm";

const artifactPath = z.string().trim().min(1).max(1000);
export const sandboxRuntimeInputSchema = z.strictObject({
  cgroupRoot: z.string().trim().max(1000).nullable(),
  artifacts: z.strictObject({
    supervisor: artifactPath,
    qemu: artifactPath,
    kernel: artifactPath,
    initramfs: artifactPath,
    image: artifactPath,
  }),
});
export type SandboxRuntimeInput = z.infer<typeof sandboxRuntimeInputSchema>;

export interface ExecutionSandbox {
  backend: SandboxBackend;
  cgroupRoot: string | null;
  artifacts: Record<SandboxArtifactName, string>;
  savedAt: string | null;
}
