import { dirname, join, win32 } from "node:path";
import type { SandboxConfiguration } from "./configuration.ts";

export function machineLaunch(
  configuration: SandboxConfiguration,
  socketDirectory: string,
) {
  const { qemu, kernel, initramfs, image } = configuration;
  if (!socketDirectory)
    throw new Error("A private VM socket directory is required");
  const environment: Record<string, string> = { PATH: dirname(qemu.path) };
  if (configuration.backend === "whpx" && process.env.SystemRoot) {
    environment.SystemRoot = process.env.SystemRoot;
    environment.SystemDrive = win32
      .parse(process.env.SystemRoot)
      .root.replace(/[\\/]+$/u, "");
  }
  const channel = join(socketDirectory, "agent.sock");
  return {
    channel,
    process: {
      program: qemu.path,
      directory: socketDirectory,
      environment,
      args: [
        "-accel",
        configuration.backend,
        "-machine",
        configuration.backend === "kvm" ? "q35,dump-guest-core=off" : "q35",
        "-m",
        "1024",
        "-smp",
        "2",
        "-nodefaults",
        "-no-user-config",
        "-display",
        "none",
        "-device",
        "virtio-serial-pci,disable-legacy=on",
        "-chardev",
        "socket,id=agent,path=agent.sock,server=on,wait=off",
        "-device",
        "virtserialport,chardev=agent,name=org.machdoch.agent",
        "-object",
        "rng-builtin,id=entropy",
        "-device",
        "virtio-rng-pci,rng=entropy,max-bytes=1024,period=1000,disable-legacy=on",
        "-serial",
        "null",
        "-monitor",
        "none",
        "-nic",
        "none",
        "-no-reboot",
        "-blockdev",
        JSON.stringify({
          driver: "file",
          filename: image.path,
          "node-name": "image-file",
          "read-only": true,
        }),
        "-blockdev",
        JSON.stringify({
          driver: "qcow2",
          file: "image-file",
          "node-name": "root-disk",
          "read-only": true,
        }),
        "-device",
        "virtio-blk-pci,drive=root-disk,disable-legacy=on",
        "-kernel",
        kernel.path,
        "-initrd",
        initramfs.path,
        "-append",
        "console=ttyS0 rdinit=/cloud-enter panic=-1 loglevel=3",
        ...(configuration.backend === "kvm"
          ? [
              "-sandbox",
              "on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny",
            ]
          : []),
      ],
    },
  };
}
