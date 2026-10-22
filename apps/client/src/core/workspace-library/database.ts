import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureWorkspaceStorage } from "../workspace-storage.js";

export async function openWorkspaceLibrary(
  workspaceRoot: string,
): Promise<DatabaseSync> {
  const root = await realpath(workspaceRoot);
  await ensureWorkspaceStorage(root);
  const path = join(root, ".machdoch/local/state/workspace-library.sqlite");
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new Error("Workspace library must be a regular file.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, size INTEGER NOT NULL, modified REAL NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(path UNINDEXED, startLine UNINDEXED, endLine UNINDEXED, fingerprint UNINDEXED, content, tokenize='unicode61');
      INSERT INTO chunks(chunks, rank) VALUES('secure-delete', 1);
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, document TEXT NOT NULL);
    `);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function libraryTransaction<T>(
  database: DatabaseSync,
  action: () => T,
): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
