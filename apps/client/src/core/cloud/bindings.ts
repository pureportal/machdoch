import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { RunnerConnection } from "@machdoch/cloud-client";
import {
  clientWorkspaceBindingSchema,
  workerRegistrationSchema,
} from "@machdoch/fleet-protocol/cloud-execution";
import { getUserConfigPath } from "../env.js";
import { withCooperativeFileLock } from "../_helpers/with-cooperative-file-lock.helper.js";
import { writeJsonAtomically } from "../_helpers/write-file-atomically.helper.js";
import { inspectClientRepository } from "./repository.js";

const localConnectionSchema = z.strictObject({
  id: z.string().uuid(),
  origin: z.string().url(),
  token: z
    .string()
    .max(200)
    .regex(/^mch_cloud_worker_[A-Za-z0-9_-]+$/),
  registration: z
    .unknown()
    .transform((value) => workerRegistrationSchema.parse(value)),
  binding: z
    .unknown()
    .transform((value) => clientWorkspaceBindingSchema.parse(value)),
  workspaceRoot: z.string().refine(isAbsolute),
  repositoryRoot: z.string().refine(isAbsolute),
  gitDirectory: z.string().refine(isAbsolute),
  subdirectory: z.string(),
  status: z.enum(["linking", "linked", "disconnecting", "disconnected"]),
});
export type ClientCloudConnection = z.infer<typeof localConnectionSchema>;
const stateSchema = z.strictObject({
  connections: z.array(localConnectionSchema).max(100),
});
export const clientCloudDirectory = (): string =>
  join(dirname(getUserConfigPath()), "cloud");

export class ClientCloudBindings {
  readonly directory: string;
  private readonly path: string;
  constructor(directory = clientCloudDirectory()) {
    if (!isAbsolute(directory))
      throw new Error(
        "Cloud connection storage requires an absolute directory.",
      );
    this.directory = directory;
    this.path = join(directory, "connections.json");
  }
  private async load(): Promise<ClientCloudConnection[]> {
    let metadata;
    try {
      metadata = await lstat(this.path);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return [];
      throw error;
    }
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > 2 * 1024 * 1024
    )
      throw new Error("Cloud connection storage is not a valid private file.");
    const bytes = await readFile(this.path, "utf8");
    try {
      return stateSchema.parse(JSON.parse(bytes)).connections;
    } catch {
      throw new Error(
        "Cloud connection storage is unreadable. Preserve the file and restore a valid backup.",
      );
    }
  }
  private async change<T>(
    operation: (connections: ClientCloudConnection[]) => T,
  ): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    return withCooperativeFileLock(this.path, async () => {
      const connections = await this.load();
      const result = operation(connections);
      const state = stateSchema.parse({ connections });
      if (
        Buffer.byteLength(JSON.stringify(state, null, 2) + "\n") >
        2 * 1024 * 1024
      )
        throw new Error(
          "Cloud connection storage is full. Remove unused connections before adding another.",
        );
      await writeJsonAtomically(this.path, state, { mode: 0o600 });
      return result;
    });
  }
  async list() {
    return (await this.load()).map(({ token: _, ...connection }) => connection);
  }
  async get(id: string): Promise<ClientCloudConnection> {
    z.string().uuid().parse(id);
    const connection = (await this.load()).find((entry) => entry.id === id);
    if (!connection)
      throw new Error("Cloud workspace connection is unavailable.");
    return connection;
  }
  async connect(
    origin: string,
    token: string,
    workspace: string,
    name?: string,
    expectedWorkerId?: string,
  ) {
    const remote = new RunnerConnection(origin, token);
    const registration = await remote.registration();
    if (expectedWorkerId && registration.workerId !== expectedWorkerId)
      throw new Error(
        "This token belongs to another runner. Use the token for this workspace.",
      );
    if (registration.profile.target === "cloud")
      throw new Error("Enroll a runner for a client execution profile.");
    const repository = await inspectClientRepository(
      workspace,
      registration.profile.repository,
      registration.profile.baseCommit,
    );
    if (
      repository.subdirectory.replaceAll("\\", "/") !==
      (registration.profile.workspacePath ?? "")
    )
      throw new Error(
        "Choose the directory configured in this execution profile, or update the profile before connecting.",
      );
    const connection = await this.change((connections) => {
      const previous = connections.find(
        (entry) =>
          entry.origin === remote.origin &&
          entry.registration.workerId === registration.workerId,
      );
      if (previous) {
        if (
          previous.workspaceRoot !== repository.workspaceRoot ||
          previous.gitDirectory !== repository.gitDirectory ||
          previous.registration.organizationId !==
            registration.organizationId ||
          previous.registration.profile.id !== registration.profile.id ||
          previous.registration.profile.projectId !==
            registration.profile.projectId ||
          previous.binding.repository !== registration.profile.repository ||
          (name && name !== previous.binding.name)
        )
          throw new Error(
            "This runner is already linked to another workspace or profile. Enroll a new runner to change it.",
          );
        if (previous.status === "disconnecting")
          throw new Error(
            "Finish disconnecting this workspace before reconnecting.",
          );
        if (previous.status === "disconnected") {
          previous.token = token;
          previous.status = "linking";
        }
        return structuredClone(previous);
      }
      if (registration.workspaceBinding)
        throw new Error(
          "This runner is already linked. Restore its local connection or enroll a new runner.",
        );
      const current = localConnectionSchema.parse({
        id: randomUUID(),
        origin: remote.origin,
        token,
        registration,
        binding: {
          workspaceId: randomUUID(),
          name: name ?? basename(repository.workspaceRoot),
          repository: registration.profile.repository,
        },
        workspaceRoot: repository.workspaceRoot,
        repositoryRoot: repository.repositoryRoot,
        gitDirectory: repository.gitDirectory,
        subdirectory: repository.subdirectory,
        status: "linking",
      });
      connections.push(current);
      return structuredClone(current);
    });
    const receipt = await remote.bindWorkspace(connection.binding);
    if (
      receipt.workerId !== registration.workerId ||
      receipt.organizationId !== registration.organizationId ||
      receipt.profile.id !== registration.profile.id ||
      receipt.profile.revision !== registration.profile.revision ||
      receipt.workspaceBinding?.workspaceId !== connection.binding.workspaceId
    )
      throw new Error(
        "Cloud workspace confirmation does not match this connection.",
      );
    await this.change((connections) => {
      const current = connections.find((entry) => entry.id === connection.id)!;
      if (current.status !== "linking" && current.status !== "linked")
        throw new Error("The workspace was disconnected while linking.");
      if (
        current.token !== connection.token ||
        current.registration.profile.revision !==
          connection.registration.profile.revision ||
        current.workspaceRoot !== connection.workspaceRoot
      ) {
        if (
          current.status === "linked" &&
          current.token === token &&
          current.registration.profile.revision === receipt.profile.revision &&
          current.workspaceRoot === connection.workspaceRoot
        )
          return;
        throw new Error(
          "The connection changed while linking. Retry with the current runner token.",
        );
      }
      current.token = token;
      current.registration = receipt;
      current.status = "linked";
    });
    return (await this.list()).find((entry) => entry.id === connection.id)!;
  }
  async disconnect(id: string, replacementToken?: string): Promise<void> {
    const connection = await this.get(id);
    if (connection.status === "disconnected") return;
    await this.change((connections) => {
      const current = connections.find((entry) => entry.id === id)!;
      if (current.status !== "disconnected") current.status = "disconnecting";
    });
    const remote = new RunnerConnection(
      connection.origin,
      replacementToken ?? connection.token,
    );
    if (replacementToken && replacementToken !== connection.token) {
      const identity = await remote.available();
      if (identity.workerId !== connection.registration.workerId)
        throw new Error(
          "This token belongs to another runner. Use the token for this workspace.",
        );
      await this.change((connections) => {
        const current = connections.find((entry) => entry.id === id)!;
        if (
          current.token !== connection.token &&
          current.token !== replacementToken
        )
          throw new Error(
            "The runner token changed. Retry with the current token.",
          );
        current.token = replacementToken;
      });
    }
    await remote.disconnect();
    await this.change((connections) => {
      connections.find((entry) => entry.id === id)!.status = "disconnected";
    });
  }
}
