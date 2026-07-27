import { lstat, open, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sameFileObjectIdentity } from "../_helpers/same-file-identity.helper.js";
import { writeFileAtomically } from "../_helpers/write-file-atomically.helper.js";
import {
  assertContainedPath,
  canonicalizeExistingWorkspaceRoot,
  normalizeInstructionBody,
  normalizeScopePath,
  readNormalizedInstructionFile,
} from "./normalization.js";
import { InstructionSystemError, type LocalInstructionRecord } from "./types.js";

const resolveLocalInstructionPath = (
  workspaceRoot: string,
  scopePath: string,
): { scope: string; directory: string; path: string } => {
  const scope = normalizeScopePath(scopePath);
  const directory =
    scope === "." ? workspaceRoot : join(workspaceRoot, ...scope.split("/"));
  assertContainedPath(workspaceRoot, directory);
  return { scope, directory, path: join(directory, "AGENTS.md") };
};

const readExisting = async (
  workspaceRoot: string,
  scopePath: string,
): Promise<LocalInstructionRecord> => {
  const target = resolveLocalInstructionPath(workspaceRoot, scopePath);
  const metadata = await lstat(target.path).catch((error: unknown) => {
    throw new InstructionSystemError(
      "LOCAL_INSTRUCTION_NOT_FOUND",
      `No AGENTS.md exists at scope "${target.scope}".`,
      [],
      { cause: error },
    );
  });
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new InstructionSystemError(
      "LOCAL_INSTRUCTION_NOT_REGULAR_FILE",
      `${target.path} must be a regular file, not a link.`,
    );
  }
  const canonical = await realpath(target.path);
  assertContainedPath(workspaceRoot, canonical, "LOCAL_INSTRUCTION_ESCAPE");
  const normalized = await readNormalizedInstructionFile(
    canonical,
    target.scope === "." ? "AGENTS.md" : `${target.scope}/AGENTS.md`,
  );
  const relativePath =
    target.scope === "." ? "AGENTS.md" : `${target.scope}/AGENTS.md`;
  return {
    id: `local:${relativePath}`,
    relativePath,
    scopePath: target.scope,
    ...normalized,
  };
};

export const showLocalInstruction = async (
  workspaceRootInput: string,
  scopePath: string,
): Promise<LocalInstructionRecord> => {
  const workspaceRoot = await canonicalizeExistingWorkspaceRoot(workspaceRootInput);
  return readExisting(workspaceRoot, scopePath);
};

export const createLocalInstruction = async (
  workspaceRootInput: string,
  scopePath: string,
  bodyInput: string,
): Promise<LocalInstructionRecord> => {
  const workspaceRoot = await canonicalizeExistingWorkspaceRoot(workspaceRootInput);
  const target = resolveLocalInstructionPath(workspaceRoot, scopePath);
  if (await lstat(target.path).then(() => true).catch(() => false)) {
    throw new InstructionSystemError(
      "LOCAL_INSTRUCTION_ALREADY_EXISTS",
      `${target.path} already exists. Use edit with its expected digest.`,
    );
  }
  const body = normalizeInstructionBody(bodyInput, target.path);
  const directoryMetadata = await lstat(target.directory).catch(
    (error: unknown) => {
      throw new InstructionSystemError(
        "LOCAL_INSTRUCTION_SCOPE_MISSING",
        `Scope directory "${target.scope}" does not exist.`,
        [],
        { cause: error },
      );
    },
  );
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    throw new InstructionSystemError(
      "LOCAL_INSTRUCTION_SCOPE_UNSAFE",
      `Scope directory "${target.scope}" must be a real directory, not a link.`,
    );
  }
  const directoryCanonical = await realpath(target.directory);
  assertContainedPath(workspaceRoot, directoryCanonical, "LOCAL_INSTRUCTION_ESCAPE");
  let handle;
  let createdIdentity: { dev: bigint; ino: bigint } | undefined;
  let writeError: unknown;
  try {
    handle = await open(target.path, "wx");
    const metadata = await handle.stat({ bigint: true });
    createdIdentity = { dev: metadata.dev, ino: metadata.ino };
    await handle.writeFile(body, "utf8");
    await handle.sync();
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      throw new InstructionSystemError(
        "LOCAL_INSTRUCTION_ALREADY_EXISTS",
        `${target.path} was created concurrently. Refresh before editing it.`,
        [],
        { cause: error },
      );
    }
    writeError = error;
  } finally {
    await handle?.close();
  }
  if (writeError !== undefined) {
    if (createdIdentity) {
      const current = await lstat(target.path, { bigint: true }).catch(
        () => undefined,
      );
      if (
        current &&
        sameFileObjectIdentity(current, createdIdentity)
      ) {
        await rm(target.path).catch(() => undefined);
      }
    }
    throw writeError;
  }
  return readExisting(workspaceRoot, target.scope);
};

export const updateLocalInstruction = async (
  workspaceRootInput: string,
  scopePath: string,
  bodyInput: string,
  expectedDigest: string,
): Promise<LocalInstructionRecord> => {
  const workspaceRoot = await canonicalizeExistingWorkspaceRoot(workspaceRootInput);
  const current = await readExisting(workspaceRoot, scopePath);
  if (current.digest !== expectedDigest) {
    throw new InstructionSystemError(
      "LOCAL_INSTRUCTION_REVISION_CONFLICT",
      `${current.relativePath} changed after it was loaded. Refresh and retry.`,
    );
  }
  const body = normalizeInstructionBody(bodyInput, current.relativePath);
  const path = resolve(
    workspaceRoot,
    ...current.relativePath.split("/"),
  );
  assertContainedPath(workspaceRoot, path);
  // Re-read immediately before replacement to provide compare-and-swap
  // behavior across editors which do not use Machdoch.
  const beforeWrite = await readExisting(workspaceRoot, scopePath);
  if (beforeWrite.digest !== expectedDigest) {
    throw new InstructionSystemError(
      "LOCAL_INSTRUCTION_REVISION_CONFLICT",
      `${current.relativePath} changed before the save could commit.`,
    );
  }
  await writeFileAtomically(path, body, "utf8", {
    beforeCommit: async () => {
      const latest = await readExisting(workspaceRoot, scopePath);
      if (latest.digest !== expectedDigest) {
        throw new InstructionSystemError(
          "LOCAL_INSTRUCTION_REVISION_CONFLICT",
          `${current.relativePath} changed while the replacement was being prepared.`,
        );
      }
    },
  });
  return readExisting(workspaceRoot, scopePath);
};

export const deleteLocalInstruction = async (
  workspaceRootInput: string,
  scopePath: string,
  expectedDigest: string,
): Promise<void> => {
  const workspaceRoot = await canonicalizeExistingWorkspaceRoot(workspaceRootInput);
  const current = await readExisting(workspaceRoot, scopePath);
  if (current.digest !== expectedDigest) {
    throw new InstructionSystemError(
      "LOCAL_INSTRUCTION_REVISION_CONFLICT",
      `${current.relativePath} changed after it was loaded. Refresh and retry.`,
    );
  }
  const path = resolve(workspaceRoot, ...current.relativePath.split("/"));
  assertContainedPath(workspaceRoot, path);
  const verified = await readExisting(workspaceRoot, scopePath);
  if (verified.digest !== expectedDigest) {
    throw new InstructionSystemError(
      "LOCAL_INSTRUCTION_REVISION_CONFLICT",
      `${current.relativePath} changed before deletion.`,
    );
  }
  await rm(path);
};
