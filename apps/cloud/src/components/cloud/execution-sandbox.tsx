import type {
  ExecutionSandbox,
  SandboxRequirement,
} from "@machdoch/fleet-protocol/cloud-sandbox";

const requirementLabels: Record<SandboxRequirement, string> = {
  supervisor: "supervisor",
  qemu: "QEMU",
  kernel: "kernel",
  initramfs: "initramfs",
  image: "disk image",
  cgroup: "a delegated cgroup",
};

export function ExecutionSandboxStatus({
  sandbox,
}: {
  sandbox: ExecutionSandbox;
}) {
  const files = sandbox.missing.filter((entry) => entry !== "cgroup");
  return (
    <p role="status" className="cloud-error mt-8">
      Tasks can't run on this server: missing{" "}
      {sandbox.missing.map((entry) => requirementLabels[entry]).join(", ")}.
      {files.length > 0 && (
        <>
          {" "}
          Put the files in <code>{sandbox.directory}</code>.
        </>
      )}
    </p>
  );
}
