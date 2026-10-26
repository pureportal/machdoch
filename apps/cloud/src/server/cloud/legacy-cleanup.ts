import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { CloudDatabase } from "./database";

export interface ImportFile {
  path: string;
  device: string;
  inode: string;
  digest: string;
}

export function importFiles(
  configPath: string,
  keyPath?: string,
): ImportFile[] {
  const directory = dirname(realpathSync(configPath));
  return [keyPath, configPath].flatMap((candidate) => {
    if (!candidate || !existsSync(candidate)) return [];
    const path = resolve(candidate);
    const local = relative(directory, path);
    const identity = lstatSync(path, { bigint: true });
    if (
      local === ".." ||
      local.startsWith(`..${sep}`) ||
      isAbsolute(local) ||
      !identity.isFile() ||
      identity.isSymbolicLink() ||
      realpathSync(path) !== path
    )
      return [];
    return [
      {
        path,
        device: identity.dev.toString(),
        inode: identity.ino.toString(),
        digest: createHash("sha256").update(readFileSync(path)).digest("hex"),
      },
    ];
  });
}

export async function finishImportCleanup(
  database: CloudDatabase,
  sourceId: string,
): Promise<boolean> {
  return database.transaction(async (sql) => {
    const receipt = (
      await sql.query<{
        source_path: string;
        cleanup_files: ImportFile[];
        cleaned_at: Date | null;
      }>(
        "SELECT source_path,cleanup_files,cleaned_at FROM cloud_imports WHERE source_id=$1 FOR UPDATE",
        [sourceId],
      )
    ).rows[0];
    if (!receipt) throw new Error("The migration receipt is missing.");
    if (receipt.cleaned_at) return true;
    if (existsSync(receipt.source_path)) return false;
    let cleaned = true;
    for (const file of receipt.cleanup_files) {
      try {
        if (!existsSync(file.path)) continue;
        const identity = lstatSync(file.path, { bigint: true });
        if (
          !identity.isFile() ||
          identity.isSymbolicLink() ||
          realpathSync(file.path) !== file.path ||
          identity.dev.toString() !== file.device ||
          identity.ino.toString() !== file.inode ||
          createHash("sha256").update(readFileSync(file.path)).digest("hex") !==
            file.digest
        )
          throw new Error("The source file changed after import.");
        unlinkSync(file.path);
      } catch (error) {
        cleaned = false;
        console.error(
          "Import completed; source file retained:",
          file.path,
          error instanceof Error ? error.message : "Unknown error",
        );
      }
    }
    if (cleaned)
      await sql.query(
        "UPDATE cloud_imports SET cleaned_at=now() WHERE source_id=$1",
        [sourceId],
      );
    return cleaned;
  });
}

export async function resumeImportCleanup(
  database: CloudDatabase,
): Promise<Set<string>> {
  const receipts = await database.transaction(
    async (sql) =>
      (
        await sql.query<{
          source_id: string;
          source_path: string;
          config_path: string;
          cleaned_at: Date | null;
        }>(
          "SELECT source_id,source_path,config_path,cleaned_at FROM cloud_imports",
        )
      ).rows,
  );
  for (const receipt of receipts) {
    if (!receipt.cleaned_at)
      await finishImportCleanup(database, receipt.source_id);
  }
  return new Set(
    receipts
      .filter((receipt) => !existsSync(receipt.source_path))
      .map((receipt) => receipt.config_path),
  );
}
