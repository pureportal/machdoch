import { isAbsolute } from "node:path";
import { z } from "zod";
import { runtimeAssetSchema as artifact } from "@machdoch/cloud-client/runtime-assets";

const artifacts = {
  supervisor: artifact,
  qemu: artifact,
  kernel: artifact,
  initramfs: artifact,
  image: artifact,
};
export const sandboxConfigurationSchema = z.discriminatedUnion("backend", [
  z.strictObject({ backend: z.literal("whpx"), ...artifacts }),
  z.strictObject({
    backend: z.literal("kvm"),
    cgroupRoot: z.string().refine(isAbsolute, "Use an absolute cgroup path"),
    ...artifacts,
  }),
]);
export type SandboxConfiguration = z.infer<typeof sandboxConfigurationSchema>;
