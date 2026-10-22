import { realpath } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import type {
  KnowledgeHit,
  KnowledgeSearchResult,
} from "@machdoch/fleet-protocol/workspace-library";
import { libraryTransaction } from "./database.js";
import { mapWithConcurrencyLimit } from "../_helpers/task-file-change-concurrency.js";
import {
  knowledgeChunks,
  listKnowledgeFiles,
  readKnowledgeFile,
} from "./files.js";

export async function indexWorkspaceKnowledge(
  database: DatabaseSync,
  workspaceRoot: string,
): Promise<Omit<KnowledgeSearchResult, "hits">> {
  const root = await realpath(workspaceRoot);
  const paths = await listKnowledgeFiles(root);
  const indexed = new Map(
    database
      .prepare("SELECT path, fingerprint FROM files")
      .all()
      .map((row) => [String(row.path), String(row.fingerprint)]),
  );
  const changed: {
    path: string;
    file: NonNullable<Awaited<ReturnType<typeof readKnowledgeFile>>>;
  }[] = [];
  const retained = new Set<string>();
  let skippedFiles = 0;
  let totalBytes = 0;
  await mapWithConcurrencyLimit(paths, 8, async (path) => {
    const file = await readKnowledgeFile(root, path);
    if (!file) {
      skippedFiles++;
      return;
    }
    totalBytes += file.size;
    if (totalBytes > 128 * 1024 * 1024)
      throw new Error(
        "Workspace search exceeds 128 MiB of text. Select a smaller workspace.",
      );
    const normalizedPath = path.replaceAll("\\", "/");
    retained.add(normalizedPath);
    if (indexed.get(normalizedPath) !== file.fingerprint)
      changed.push({ path: normalizedPath, file });
  });
  libraryTransaction(database, () => {
    const removed = [...indexed.keys()].filter((path) => !retained.has(path));
    const replaced = [...removed, ...changed.map(({ path }) => path)];
    if (replaced.length)
      database
        .prepare(
          "DELETE FROM chunks WHERE path IN (SELECT value FROM json_each(?))",
        )
        .run(JSON.stringify(replaced));
    if (removed.length)
      database
        .prepare(
          "DELETE FROM files WHERE path IN (SELECT value FROM json_each(?))",
        )
        .run(JSON.stringify(removed));
    const saveFile = database.prepare(
      "INSERT OR REPLACE INTO files (path, fingerprint, size, modified) VALUES (?, ?, ?, ?)",
    );
    const saveChunk = database.prepare(
      "INSERT INTO chunks (path, startLine, endLine, fingerprint, content) VALUES (?, ?, ?, ?, ?)",
    );
    for (const { path, file } of changed) {
      saveFile.run(path, file.fingerprint, file.size, file.modified);
      for (const chunk of knowledgeChunks(file.content))
        saveChunk.run(
          path,
          chunk.startLine,
          chunk.endLine,
          file.fingerprint,
          chunk.content,
        );
    }
  });
  return { indexedFiles: retained.size, skippedFiles, indexedAt: Date.now() };
}

export async function searchWorkspaceKnowledge(
  database: DatabaseSync,
  workspaceRoot: string,
  query: string,
  limit: number,
): Promise<KnowledgeSearchResult> {
  const status = await indexWorkspaceKnowledge(database, workspaceRoot);
  const terms = [
    ...new Set(query.normalize("NFKC").match(/[\p{L}\p{N}_]+/gu) ?? []),
  ].slice(0, 32);
  if (!terms.length) return { ...status, hits: [] };
  const match = terms.map((term) => `"${term}"`).join(" OR ");
  const rows = database
    .prepare(
      "SELECT path, startLine, endLine, fingerprint, content FROM chunks WHERE chunks MATCH ? ORDER BY bm25(chunks), path, CAST(startLine AS INTEGER) LIMIT ?",
    )
    .all(match, limit);
  const hits: KnowledgeHit[] = rows.map((row) => ({
    path: String(row.path),
    startLine: Number(row.startLine),
    endLine: Number(row.endLine),
    fingerprint: String(row.fingerprint),
    excerpt: String(row.content),
  }));
  return { ...status, hits };
}
