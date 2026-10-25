import { mkdir, open, unlink, rmdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { GuestChannel, type GuestResponse } from "./guest-channel.ts";
import { NativeSupervisor } from "@machdoch/cloud-client/supervisor";
import { verifyRuntimeAsset } from "@machdoch/cloud-client/runtime-assets";
import {
  environmentLifecycleSchema,
  readStopReceipt,
  type StopReceipt,
} from "@machdoch/cloud-client/stop-receipt";
import type { RepositoryTransport } from "@machdoch/fleet-protocol/cloud-repository";
import type { CloudAgentTransport } from "@machdoch/fleet-protocol/cloud-agent";
import {
  sandboxConfigurationSchema,
  type SandboxConfiguration,
} from "./configuration.ts";
import { machineLaunch } from "./machine-launch.ts";
import {
  openWindowsSocket,
  prepareWindowsSocketDirectory,
} from "./windows-socket.ts";

export class VirtualMachineSandbox {
  private channel: GuestChannel | undefined;
  private closed = false;
  private closing: Promise<StopReceipt> | undefined;
  private bridge: ReturnType<typeof openWindowsSocket> | undefined;
  private readonly abort = () => this.channel?.close();
  private constructor(
    private readonly configuration: SandboxConfiguration,
    readonly supervisor: NativeSupervisor,
    readonly environmentId: string,
    readonly receiptPath: string,
    private readonly socketDirectory: string,
  ) {
    supervisor.signal.addEventListener("abort", this.abort, { once: true });
  }

  static async create(
    configuration: SandboxConfiguration,
    lifecycle: { directory: string; environmentId: string },
  ): Promise<VirtualMachineSandbox> {
    configuration = sandboxConfigurationSchema.parse(configuration);
    if (configuration.backend === "whpx" && process.platform !== "win32")
      throw new Error("The WHPX sandbox requires Windows");
    if (configuration.backend === "kvm") {
      if (process.platform !== "linux" || process.getuid?.() === 0)
        throw new Error(
          "The KVM worker requires Linux and a dedicated non-root account",
        );
      const kvm = await open("/dev/kvm", "r+");
      try {
        if (!(await kvm.stat()).isCharacterDevice())
          throw new Error("The KVM device is unavailable");
      } finally {
        await kvm.close();
      }
    }
    environmentLifecycleSchema.parse(lifecycle);
    if (!isAbsolute(lifecycle.directory))
      throw new Error("Environment state requires an absolute directory");
    for (const artifact of [
      configuration.supervisor,
      configuration.qemu,
      configuration.kernel,
      configuration.initramfs,
      configuration.image,
    ]) {
      await verifyRuntimeAsset(artifact);
    }
    await mkdir(lifecycle.directory, { recursive: true, mode: 0o700 });
    const receiptPath = join(
      lifecycle.directory,
      lifecycle.environmentId + ".stopped.json",
    );
    const socketDirectory = join(lifecycle.directory, lifecycle.environmentId);
    if (configuration.backend === "kvm") {
      if (Buffer.byteLength(join(socketDirectory, "agent.sock")) > 107)
        throw new Error(
          "Use a shorter state directory for the VM control socket",
        );
      await mkdir(socketDirectory, { mode: 0o700 });
    } else {
      await prepareWindowsSocketDirectory(
        configuration.supervisor.path,
        socketDirectory,
      );
    }
    const supervisor = new NativeSupervisor(configuration.supervisor.path);
    try {
      await supervisor.prepareReceipt(
        receiptPath,
        lifecycle.environmentId,
        configuration.backend === "kvm" ? configuration.cgroupRoot : undefined,
      );
    } catch (error) {
      try {
        await supervisor.close();
        await rmdir(socketDirectory);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Environment preparation and cleanup failed",
        );
      }
      throw error;
    }
    return new VirtualMachineSandbox(
      configuration,
      supervisor,
      lifecycle.environmentId,
      receiptPath,
      socketDirectory,
    );
  }

  async start(
    anchorId: string,
    allowanceMs: number,
    maxDurationMs: number,
    repositoryTransport?: RepositoryTransport,
  ): Promise<number> {
    if (this.closed || this.channel)
      throw new Error("Sandbox cannot be started in its current state");
    const launch = machineLaunch(this.configuration, this.socketDirectory);
    const processId = await this.supervisor.start({
      anchorId,
      allowanceMs,
      maxDurationMs,
      memoryLimitBytes: 3 * 1024 * 1024 * 1024,
      ...launch.process,
    });
    if (this.configuration.backend === "whpx") {
      this.bridge = openWindowsSocket(
        this.configuration.supervisor.path,
        this.socketDirectory,
      );
      this.channel = await GuestChannel.fromStream(
        this.bridge.stream,
        this.supervisor.signal,
        repositoryTransport,
      );
    } else {
      this.channel = await GuestChannel.open(
        launch.channel,
        this.supervisor.signal,
        repositoryTransport,
      );
    }
    this.supervisor.signal.throwIfAborted();
    return processId;
  }

  call(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    id?: string,
    agentTransport?: CloudAgentTransport,
  ): Promise<GuestResponse> {
    if (this.closed || !this.channel)
      return Promise.reject(new Error("Sandbox is not ready"));
    return this.channel.call(
      tool,
      args,
      signal
        ? AbortSignal.any([signal, this.supervisor.signal])
        : this.supervisor.signal,
      id,
      agentTransport,
    );
  }

  close(): Promise<StopReceipt> {
    return (this.closing ??= this.stop());
  }

  private async stop(): Promise<StopReceipt> {
    this.closed = true;
    this.channel?.close();
    await this.bridge?.close();
    this.supervisor.signal.removeEventListener("abort", this.abort);
    let shutdownError: unknown;
    try {
      await this.supervisor.close();
    } catch (error) {
      shutdownError = error;
    }
    const receipt = await readStopReceipt(this.receiptPath, this.environmentId);
    if (!receipt)
      throw new Error("Environment termination has no native receipt", {
        cause: shutdownError,
      });
    try {
      await unlink(join(this.socketDirectory, "agent.sock"));
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
    }
    await rmdir(this.socketDirectory);
    return receipt;
  }
}
