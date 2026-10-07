import { createHash } from "node:crypto";
import { lstat, readdir, readFile, utimes } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { RalphFlow } from "../ralph.js";
import { createRalphFlowFingerprint } from "./create-ralph-flow-fingerprint.helper.js";
import { isRalphRunOwnerAlive } from "./is-ralph-run-owner-alive.helper.js";
import { writeJsonAtomically } from "./write-file-atomically.helper.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFlow = (value: unknown): value is RalphFlow =>
  isRecord(value) &&
  typeof value.id === "string" &&
  Array.isArray(value.blocks) &&
  Array.isArray(value.edges);

export const migrateWorkspacePathReferences = (
  value: unknown,
  workspaceRoot: string,
  fingerprints: ReadonlyMap<string, string> = new Map(),
): unknown => {
  if (typeof value === "string") {
    if (isAbsolute(value)) {
      const path = relative(resolve(workspaceRoot), resolve(value));
      if (
        isAbsolute(path) ||
        path === ".." ||
        path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
      )
        return value;
    }
    return value
      .replace(
        /\.machdoch([\\/])ralph\1(artifacts|generations|diagnostics)(?=[\\/]|$)/gu,
        ".machdoch$1local$1artifacts$1ralph$1$2",
      )
      .replace(
        /\.machdoch([\\/])ralph\1(?!flows(?:[\\/]|$))/gu,
        ".machdoch$1local$1state$1ralph$1",
      )
      .replace(
        /\.machdoch([\\/])(autonomous-features|feature-implementation)(?=[\\/]|$)/gu,
        ".machdoch$1local$1state$1$2",
      );
  }
  if (Array.isArray(value))
    return value.map((entry) =>
      migrateWorkspacePathReferences(entry, workspaceRoot, fingerprints),
    );
  if (!isRecord(value)) return value;
  const updated = Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      key === "flowFingerprint" && typeof entry === "string"
        ? (fingerprints.get(entry) ?? entry)
        : migrateWorkspacePathReferences(entry, workspaceRoot, fingerprints),
    ]),
  );
  if (
    isFlow(value.flowSnapshot) &&
    isFlow(updated.flowSnapshot) &&
    value.flowFingerprint === createRalphFlowFingerprint(value.flowSnapshot)
  ) {
    updated.flowFingerprint = createRalphFlowFingerprint(updated.flowSnapshot);
  }
  return updated;
};

const listDirectory = async (path: string) => {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`Workspace storage must be a regular directory: ${path}`);
    }
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
};

const migrateJsonReferences = async (
  path: string,
  workspaceRoot: string,
  fingerprints: ReadonlyMap<string, string>,
): Promise<void> => {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Workspace storage must be a regular file: ${path}`);
  }
  const original: unknown = JSON.parse(await readFile(path, "utf8"));
  const updated = migrateWorkspacePathReferences(
    original,
    workspaceRoot,
    fingerprints,
  );
  if (JSON.stringify(original) === JSON.stringify(updated)) return;
  if (
    isRecord(original) &&
    isRecord(updated) &&
    "checksum" in original &&
    "checkpoint" in original
  ) {
    const checksum = (checkpoint: unknown) =>
      createHash("sha256")
        .update(JSON.stringify({ generation: original.generation, checkpoint }))
        .digest("hex");
    if (original.checksum !== checksum(original.checkpoint)) {
      throw new Error(
        `Cannot migrate a checkpoint with an invalid checksum: ${path}`,
      );
    }
    updated.checksum = checksum(updated.checkpoint);
  }
  await writeJsonAtomically(path, updated);
  await utimes(path, metadata.atime, metadata.mtime);
};

export const assertWorkspaceRunsInactive = async (
  runDirectory: string,
): Promise<void> => {
  for (const entry of await listDirectory(runDirectory)) {
    if (!entry.isDirectory()) continue;
    const leasePath = join(runDirectory, entry.name, "run-lease.json");
    let lease: unknown;
    try {
      lease = JSON.parse(await readFile(leasePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (
      isRecord(lease) &&
      !lease.releasedAt &&
      typeof lease.ownerId === "string" &&
      isRalphRunOwnerAlive(lease.ownerId)
    ) {
      throw new Error(
        `Stop the active RALPH run before migrating workspace storage: ${entry.name}`,
      );
    }
  }
};

export const migrateWorkspaceStorageReferences = async (
  workspaceRoot: string,
): Promise<void> => {
  const projectDirectory = join(workspaceRoot, ".machdoch");
  const flowPaths: string[] = [];
  for (const directory of [
    join(projectDirectory, "ralph", "flows"),
    join(projectDirectory, "local", "state", "ralph", "revisions"),
  ]) {
    const visit = async (path: string): Promise<void> => {
      for (const entry of await listDirectory(path)) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) await visit(child);
        else if (entry.name.endsWith(".json")) flowPaths.push(child);
      }
    };
    await visit(directory);
  }
  const fingerprintPath = join(
    projectDirectory,
    "local",
    "state",
    "storage-path-references.json",
  );
  const fingerprints = new Map<string, string>();
  try {
    const metadata = await lstat(fingerprintPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(
        `Workspace storage must be a regular file: ${fingerprintPath}`,
      );
    }
    const saved: unknown = JSON.parse(await readFile(fingerprintPath, "utf8"));
    if (
      !isRecord(saved) ||
      Object.values(saved).some((value) => typeof value !== "string")
    ) {
      throw new Error(`Invalid migration fingerprint map: ${fingerprintPath}`);
    }
    for (const [before, after] of Object.entries(saved))
      fingerprints.set(before, after as string);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const path of flowPaths) {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Workspace storage must be a regular file: ${path}`);
    }
    const original: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isFlow(original)) continue;
    const updated = migrateWorkspacePathReferences(
      original,
      workspaceRoot,
    ) as RalphFlow;
    const before = createRalphFlowFingerprint(original);
    const after = createRalphFlowFingerprint(updated);
    if (before !== after) fingerprints.set(before, after);
  }
  if (fingerprints.size > 0) {
    await writeJsonAtomically(
      fingerprintPath,
      Object.fromEntries(fingerprints),
    );
  }
  for (const path of flowPaths)
    await migrateJsonReferences(path, workspaceRoot, fingerprints);
  const runs = join(projectDirectory, "local", "state", "ralph", "runs");
  for (const entry of await listDirectory(runs)) {
    if (entry.isFile() && entry.name.endsWith(".json")) {
      await migrateJsonReferences(
        join(runs, entry.name),
        workspaceRoot,
        fingerprints,
      );
      continue;
    }
    if (!entry.isDirectory()) continue;
    const directory = join(runs, entry.name);
    for (const file of await listDirectory(directory)) {
      if (file.isFile() && file.name === "run.json") {
        await migrateJsonReferences(
          join(directory, file.name),
          workspaceRoot,
          fingerprints,
        );
      }
    }
    const checkpoints = join(directory, "checkpoints");
    for (const file of await listDirectory(checkpoints)) {
      if (file.isFile() && file.name.endsWith(".json")) {
        await migrateJsonReferences(
          join(checkpoints, file.name),
          workspaceRoot,
          fingerprints,
        );
      }
    }
  }
};
