import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { withCooperativeFileLock } from "./_helpers/with-cooperative-file-lock.helper.js";
import {
  writeFileAtomically,
  writeJsonAtomically,
} from "./_helpers/write-file-atomically.helper.js";
import {
  assertWorkspaceRunsInactive,
  migrateWorkspaceStorageReferences,
} from "./_helpers/migrate-workspace-storage-references.helper.js";
import {
  getWorkspaceLocalDirectory,
  getWorkspaceStorageMarkerPath,
  WORKSPACE_STORAGE_LAYOUT_VERSION,
} from "./workspace-storage-paths.js";

const migrations = new Map<string, Promise<void>>();

const metadataIfPresent = async (path: string) => {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

const ensureDirectory = async (
  path: string,
  boundary: string,
): Promise<void> => {
  if (path !== boundary) await ensureDirectory(dirname(path), boundary);
  const metadata = await metadataIfPresent(path);
  if (metadata && (!metadata.isDirectory() || metadata.isSymbolicLink())) {
    throw new Error(`Workspace storage must be a regular directory: ${path}`);
  }
  if (!metadata) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const created = await lstat(path);
      if (!created.isDirectory() || created.isSymbolicLink()) {
        throw new Error(
          `Workspace storage must be a regular directory: ${path}`,
        );
      }
    }
  }
};

const readRegularFile = async (path: string): Promise<string | undefined> => {
  const metadata = await metadataIfPresent(path);
  if (!metadata) return undefined;
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Workspace storage must be a regular file: ${path}`);
  }
  return readFile(path, "utf8");
};

const layoutIsCurrent = async (workspaceRoot: string): Promise<boolean> => {
  const content = await readRegularFile(
    getWorkspaceStorageMarkerPath(workspaceRoot),
  );
  if (!content) return false;
  const marker = JSON.parse(content) as { version?: number };
  if (marker.version !== WORKSPACE_STORAGE_LAYOUT_VERSION) {
    throw new Error("Unsupported workspace storage layout.");
  }
  return true;
};

const moveStorageEntry = async (
  source: string,
  destination: string,
  boundary: string,
): Promise<void> => {
  const sourceMetadata = await metadataIfPresent(source);
  if (!sourceMetadata) return;
  if (sourceMetadata.isSymbolicLink()) {
    throw new Error(`Cannot migrate linked workspace storage: ${source}`);
  }
  await ensureDirectory(dirname(destination), boundary);
  const destinationMetadata = await metadataIfPresent(destination);
  if (!destinationMetadata) {
    await rename(source, destination);
    return;
  }
  if (destinationMetadata.isSymbolicLink()) {
    throw new Error(
      `Cannot migrate into linked workspace storage: ${destination}`,
    );
  }
  if (sourceMetadata.isDirectory() && destinationMetadata.isDirectory()) {
    for (const entry of await readdir(source)) {
      await moveStorageEntry(
        join(source, entry),
        join(destination, entry),
        boundary,
      );
    }
    await rmdir(source);
    return;
  }
  if (
    sourceMetadata.isFile() &&
    destinationMetadata.isFile() &&
    sourceMetadata.size === destinationMetadata.size &&
    (await hashStorageFile(source)) === (await hashStorageFile(destination))
  ) {
    await unlink(source);
    return;
  }
  throw new Error(
    `Workspace storage conflict at ${destination}. Move one of the conflicting files and reload the workspace.`,
  );
};

const hashStorageFile = async (path: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};

const updateIgnoreFile = async (
  path: string,
  projectIgnore: boolean,
): Promise<void> => {
  const original = (await readRegularFile(path)) ?? "";
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.split(/\r?\n/u);
  const updated = lines.map((line) => {
    if (
      !projectIgnore &&
      /^\/?(?:\*\*\/)?\.machdoch(?:\/|\/\*\*)?\s*$/u.test(line)
    ) {
      return "**/.machdoch/local/";
    }
    return line;
  });
  if (projectIgnore) {
    for (const pattern of [
      "/local/",
      "*.machdoch.lock*/",
      "*.json.lock/",
      "*.tmp",
    ]) {
      if (updated.some((line) => line.trim() === pattern)) continue;
      if (updated.at(-1) === "") updated.pop();
      updated.push(pattern, "");
    }
  }
  const content = updated.join(newline);
  if (content !== original) await writeFileAtomically(path, content);
};

const migrateStorage = async (workspaceRoot: string): Promise<void> => {
  const directory = join(workspaceRoot, ".machdoch");
  await ensureDirectory(directory, workspaceRoot);
  await ensureDirectory(
    getWorkspaceLocalDirectory(workspaceRoot, "state"),
    workspaceRoot,
  );
  if (await layoutIsCurrent(workspaceRoot)) return;
  await withCooperativeFileLock(
    getWorkspaceStorageMarkerPath(workspaceRoot),
    async () => {
      if (await layoutIsCurrent(workspaceRoot)) return;
      await assertWorkspaceRunsInactive(join(directory, "ralph", "runs"));
      const { migrateWorkspaceSchedulerStorage } =
        await import("./_helpers/scheduler-workspace-storage.helper.js");
      await migrateWorkspaceSchedulerStorage(workspaceRoot);
      for (const name of [
        "memory.json",
        "reasoning-bank.json",
        "autonomous-features",
        "feature-implementation",
      ]) {
        await moveStorageEntry(
          join(directory, name),
          join(getWorkspaceLocalDirectory(workspaceRoot, "state"), name),
          workspaceRoot,
        );
      }
      const ralphDirectory = join(directory, "ralph");
      const ralphMetadata = await metadataIfPresent(ralphDirectory);
      if (ralphMetadata) {
        await ensureDirectory(ralphDirectory, workspaceRoot);
        for (const entry of await readdir(ralphDirectory, {
          withFileTypes: true,
        })) {
          if (entry.name === "flows") continue;
          const category =
            entry.name === "run-summary-cache.json"
              ? "cache"
              : ["artifacts", "generations", "diagnostics"].includes(entry.name)
                ? "artifacts"
                : "state";
          await moveStorageEntry(
            join(ralphDirectory, entry.name),
            join(
              getWorkspaceLocalDirectory(workspaceRoot, category),
              "ralph",
              entry.name,
            ),
            workspaceRoot,
          );
        }
      }
      const mcpDirectory = join(directory, "mcp");
      if (await metadataIfPresent(mcpDirectory)) {
        await ensureDirectory(mcpDirectory, workspaceRoot);
        await moveStorageEntry(
          join(mcpDirectory, "discovery-cache.json"),
          join(
            getWorkspaceLocalDirectory(workspaceRoot, "cache"),
            "mcp",
            "discovery-cache.json",
          ),
          workspaceRoot,
        );
      }
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const category =
          entry.isDirectory() &&
          (/^(?:chrome-|browser-profile-)/u.test(entry.name) ||
            entry.name === "fleet-payloads")
            ? "cache"
            : (entry.isDirectory() &&
                  ["e2e", "seo-image-sources"].includes(entry.name)) ||
                (entry.isFile() &&
                  (/^(?:screenshot(?:[._-].*)?|media-studio-.+)\.(?:png|jpe?g|webp|gif|mp4|webm)$/iu.test(
                    entry.name,
                  ) ||
                    /\.(?:log|trace)$/iu.test(entry.name)))
              ? "artifacts"
              : undefined;
        if (category)
          await moveStorageEntry(
            join(directory, entry.name),
            join(
              getWorkspaceLocalDirectory(workspaceRoot, category),
              entry.name,
            ),
            workspaceRoot,
          );
      }
      await migrateWorkspaceStorageReferences(workspaceRoot);
      await updateIgnoreFile(join(directory, ".gitignore"), true);
      await updateIgnoreFile(join(workspaceRoot, ".gitignore"), false);
      await writeJsonAtomically(getWorkspaceStorageMarkerPath(workspaceRoot), {
        version: WORKSPACE_STORAGE_LAYOUT_VERSION,
      });
    },
    { timeoutMs: 120_000 },
  );
};

export const ensureWorkspaceStorage = (
  workspaceRoot: string,
): Promise<void> => {
  const root = resolve(workspaceRoot);
  const existing = migrations.get(root);
  if (existing) return existing;
  const migration = migrateStorage(root).catch((error: unknown) => {
    migrations.delete(root);
    throw error;
  });
  migrations.set(root, migration);
  return migration;
};
