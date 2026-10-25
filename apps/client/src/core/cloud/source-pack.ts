import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, win32 } from "node:path";
import { z } from "zod/v4";
import { NativeSupervisor } from "@machdoch/cloud-client/supervisor";
import { readStopReceipt } from "@machdoch/cloud-client/stop-receipt";
import {
  runtimeAssetSchema,
  verifyRuntimeAsset,
} from "@machdoch/cloud-client/runtime-assets";
import { within, type ClientRepository } from "./repository.js";
import {
  maximumSourcePackBytes,
  sourcePackRequestSchema,
} from "./source-pack-contract.js";

export const sourcePackRuntimeSchema = z.strictObject({
  supervisor: runtimeAssetSchema,
  node: runtimeAssetSchema,
  host: runtimeAssetSchema,
  git: runtimeAssetSchema,
});
export type SourcePackRuntime = z.infer<typeof sourcePackRuntimeSchema>;

export async function exportClientSourcePack(
  source: Pick<ClientRepository, "repositoryRoot" | "gitDirectory">,
  baseCommit: string,
  storageDirectory: string,
  suppliedRuntime: SourcePackRuntime,
  signal: AbortSignal,
) {
  if (process.platform !== "win32" || !process.env.SystemRoot)
    throw new Error(
      "Local source export requires the Windows sandbox runtime.",
    );
  z.string()
    .regex(/^[a-f0-9]{40}$/)
    .parse(baseCommit);
  for (const path of [
    source.repositoryRoot,
    source.gitDirectory,
    storageDirectory,
  ])
    if (!isAbsolute(path))
      throw new Error("Source export paths must be absolute.");
  signal.throwIfAborted();
  const runtime = sourcePackRuntimeSchema.parse(suppliedRuntime);
  const verified: Record<"supervisor" | "node" | "host" | "git", string> = {
    supervisor: await verifyRuntimeAsset(runtime.supervisor),
    node: await verifyRuntimeAsset(runtime.node),
    host: await verifyRuntimeAsset(runtime.host),
    git: await verifyRuntimeAsset(runtime.git),
  };
  const repositoryRoot = await realpath(source.repositoryRoot);
  const gitDirectory = await realpath(source.gitDirectory);
  const storage = await realpath(storageDirectory);
  if (within(repositoryRoot, storage) || within(storage, repositoryRoot))
    throw new Error(
      "Keep source export storage separate from the linked repository.",
    );
  const objectPath = join(gitDirectory, "objects");
  const objects = await lstat(objectPath);
  if (!objects.isDirectory() || objects.isSymbolicLink())
    throw new Error("The local Git object database cannot be redirected.");
  const objectDirectory = await realpath(objectPath);
  if (!within(gitDirectory, objectDirectory))
    throw new Error("The local Git object database is outside its repository.");
  const runtimeDirectory = dirname(verified.git);
  if (
    within(repositoryRoot, runtimeDirectory) ||
    within(runtimeDirectory, repositoryRoot)
  )
    throw new Error(
      "Keep the Git runtime separate from the linked repository.",
    );
  const environmentId = randomUUID();
  const directory = join(storage, environmentId);
  await mkdir(directory, { mode: 0o700 });
  const sealed = join(directory, "repository"),
    state = join(directory, "state"),
    owner = join(directory, "owner");
  for (const path of [
    sealed,
    state,
    owner,
    join(sealed, "objects"),
    join(sealed, "refs"),
  ])
    await mkdir(path, { mode: 0o700 });
  await writeFile(join(sealed, "HEAD"), "ref: refs/heads/source\n", {
    flag: "wx",
  });
  await writeFile(
    join(sealed, "config"),
    "[core]\n\tbare = true\n\trepositoryformatversion = 0\n",
    { flag: "wx" },
  );
  await writeFile(join(sealed, "shallow"), baseCommit + "\n", { flag: "wx" });
  const request = sourcePackRequestSchema.parse({
    gitExecutable: verified.git,
    repositoryDirectory: sealed,
    objectDirectory,
    stateDirectory: state,
    baseCommit,
  });
  const chunks: Buffer[] = [];
  let byteLength = 0,
    diagnostics = "";
  let captureError: Error | undefined;
  let operationError: unknown;
  let cleanupError: unknown;
  let prepared = false;
  const supervisor = new NativeSupervisor(
    verified.supervisor,
    (kind, bytes) => {
      if (kind === "stderr") {
        diagnostics = (diagnostics + bytes.toString("utf8")).slice(-8192);
        return;
      }
      byteLength += bytes.length;
      if (byteLength > maximumSourcePackBytes) {
        captureError = new Error(
          "The pinned source exceeds the 64 MiB transfer limit.",
        );
        throw captureError;
      }
      chunks.push(Buffer.from(bytes));
    },
  );
  const receiptPath = join(directory, "stopped.json");
  const abort = () => {
    void supervisor.close().catch((error: unknown) => {
      cleanupError = error;
    });
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    await supervisor.prepareReceipt(receiptPath, environmentId);
    prepared = true;
    signal.throwIfAborted();
    await supervisor.start({
      anchorId: await supervisor.anchor(),
      allowanceMs: 60000,
      maxDurationMs: 60000,
      memoryLimitBytes: 512 * 1024 * 1024,
      program: verified.node,
      args: [verified.host],
      directory: dirname(verified.host),
      environment: {
        SystemRoot: process.env.SystemRoot,
        SystemDrive: win32
          .parse(process.env.SystemRoot)
          .root.replace(/[\\/]+$/u, ""),
        PATH: dirname(verified.node),
        LOCALAPPDATA: owner,
        TEMP: owner,
        TMP: owner,
      },
    });
    await supervisor.writeInput(Buffer.from(JSON.stringify(request) + "\n"));
    await supervisor.finished;
  } catch (error) {
    operationError = error;
  } finally {
    signal.removeEventListener("abort", abort);
    try {
      await supervisor.close();
    } catch (error) {
      cleanupError = error;
    }
  }
  const receipt = prepared
    ? await readStopReceipt(receiptPath, environmentId)
    : null;
  if (prepared && !receipt)
    throw new Error(
      "Source export termination is unconfirmed. Preserve its storage for recovery.",
    );
  signal.throwIfAborted();
  if (captureError) throw captureError;
  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
  if (!receipt || receipt.reason !== "completed" || receipt.exitCode !== 0)
    throw new Error(
      "The pinned source could not be exported. Check local Git objects and sandbox resources before retrying.",
      { cause: diagnostics },
    );
  const bytes = Buffer.concat(chunks, byteLength);
  if (
    bytes.length < 32 ||
    bytes.subarray(0, 4).toString() !== "PACK" ||
    ![2, 3].includes(bytes.readUInt32BE(4)) ||
    !createHash("sha1")
      .update(bytes.subarray(0, -20))
      .digest()
      .equals(bytes.subarray(-20))
  )
    throw new Error(
      "The source pack is incomplete or invalid. Retry the export.",
    );
  return {
    baseCommit,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    receiptPath,
  };
}
