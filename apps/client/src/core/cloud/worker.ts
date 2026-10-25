import { open, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod/v4";
import { RunnerConnection } from "@machdoch/cloud-client";
import {
  CloudRunner,
  RunnerJournal,
  sandboxConfigurationSchema,
} from "@machdoch/cloud-client/worker";
import { ClientCloudBindings } from "./bindings.js";
import {
  exportClientSourcePack,
  sourcePackRuntimeSchema,
} from "./source-pack.js";
import { inspectClientRepository, within } from "./repository.js";

export const clientCloudRuntimeSchema = z.strictObject({
  sandbox: sandboxConfigurationSchema,
  source: sourcePackRuntimeSchema.omit({ supervisor: true }),
  pollIntervalMs: z.number().int().min(500).max(30000).default(3000),
  repairAttempts: z.number().int().min(0).max(3).default(2),
});

async function readRuntime(path: string) {
  if (!isAbsolute(path))
    throw new Error("Choose an absolute client runtime path.");
  const file = await open(path, "r");
  try {
    if (!(await file.stat()).isFile())
      throw new Error("The client runtime configuration must be a file.");
    const bytes = Buffer.alloc(65537);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 65536)
      throw new Error("Client runtime configuration exceeds 64 KiB.");
    return clientCloudRuntimeSchema.parse(
      JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")),
    );
  } finally {
    await file.close();
  }
}

export async function createClientCloudWorker(
  id: string,
  runtimePath: string,
  bindings = new ClientCloudBindings(),
) {
  const initial = await bindings.get(id);
  if (initial.status !== "linked")
    throw new Error("Finish connecting this workspace before running tasks.");
  if (initial.registration.profile.target !== "client-linux")
    throw new Error(
      "Choose a Client (Linux) execution profile. Native client execution is not available.",
    );
  const runtime = await readRuntime(runtimePath);
  const storage = await realpath(bindings.directory);
  const repository = await realpath(initial.repositoryRoot);
  if (within(repository, storage) || within(storage, repository))
    throw new Error(
      "Keep client connection storage separate from the linked repository.",
    );
  const directory = join(storage, "workers", initial.id);
  const sourceDirectory = join(directory, "source");
  await mkdir(sourceDirectory, { recursive: true, mode: 0o700 });
  const connection = new RunnerConnection(initial.origin, initial.token);
  const journal = new RunnerJournal(directory, initial.origin);
  async function currentConnection() {
    const current = await bindings.get(id);
    if (
      current.status !== "linked" ||
      current.origin !== initial.origin ||
      current.token !== initial.token ||
      current.registration.workerId !== initial.registration.workerId ||
      current.binding.workspaceId !== initial.binding.workspaceId ||
      current.workspaceRoot !== initial.workspaceRoot ||
      current.gitDirectory !== initial.gitDirectory
    )
      throw new Error(
        "The client connection changed. Restart execution with its current settings.",
      );
    return current;
  }
  const configuration = {
    origin: initial.origin,
    stateDirectory: directory,
    pollIntervalMs: runtime.pollIntervalMs,
    repairAttempts: runtime.repairAttempts,
    sandbox: runtime.sandbox,
  };
  const runner = new CloudRunner(configuration, connection, journal, {
    kind: "client-linux",
    checkConnection: async () => {
      await currentConnection();
    },
    prepareSource: async (registration, signal) => {
      const current = await currentConnection();
      if (
        registration.workerId !== current.registration.workerId ||
        registration.organizationId !== current.registration.organizationId ||
        registration.profile.id !== current.registration.profile.id ||
        registration.profile.revision !==
          current.registration.profile.revision ||
        registration.workspaceBinding?.workspaceId !==
          current.binding.workspaceId ||
        registration.profile.repository !== current.binding.repository
      )
        throw new Error(
          "This task profile no longer matches the linked workspace. Reconnect the workspace before running tasks.",
        );
      const source = await inspectClientRepository(
        current.workspaceRoot,
        registration.profile.repository,
        registration.profile.baseCommit,
      );
      if (
        source.repositoryRoot !== current.repositoryRoot ||
        source.gitDirectory !== current.gitDirectory ||
        source.subdirectory !== current.subdirectory ||
        source.subdirectory.replaceAll("\\", "/") !==
          (registration.profile.workspacePath ?? "")
      )
        throw new Error(
          "The linked repository or directory changed. Reconnect this workspace before running tasks.",
        );
      return exportClientSourcePack(
        source,
        registration.profile.baseCommit,
        sourceDirectory,
        { ...runtime.source, supervisor: runtime.sandbox.supervisor },
        signal,
      );
    },
  });
  return { runner, journal, pollIntervalMs: runtime.pollIntervalMs };
}
