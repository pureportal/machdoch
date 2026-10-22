import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import {
  researchProjectInputSchema,
  type ResearchProject,
  type ResearchProjectInput,
  type ResearchSourceCheck,
} from "@machdoch/fleet-protocol/workspace-library";
import { libraryTransaction } from "./database.js";
import { readKnowledgeFile } from "./files.js";

export function listResearchProjects(
  database: DatabaseSync,
): ResearchProject[] {
  return database
    .prepare(
      "SELECT document FROM projects ORDER BY json_extract(document, '$.updatedAt') DESC",
    )
    .all()
    .map((row) => JSON.parse(String(row.document)) as ResearchProject);
}

export function readResearchProject(
  database: DatabaseSync,
  id: string,
): ResearchProject {
  const row = database
    .prepare("SELECT document FROM projects WHERE id = ?")
    .get(id);
  if (!row)
    throw new Error(
      "Research project no longer exists. Refresh the project list.",
    );
  return JSON.parse(String(row.document)) as ResearchProject;
}

export async function saveResearchProject(
  database: DatabaseSync,
  workspaceRoot: string,
  input: ResearchProjectInput,
): Promise<ResearchProject> {
  const parsed = researchProjectInputSchema.parse(input);
  const saved = parsed.id ? readResearchProject(database, parsed.id) : null;
  if ((saved?.revision ?? 0) !== parsed.revision)
    throw new Error(
      "This research project changed elsewhere. Reload it before saving.",
    );
  const savedSources = new Map(
    saved?.sources.map((source) => [source.id, source]),
  );
  const root = await realpath(workspaceRoot);
  const sources = await Promise.all(
    parsed.sources.map(async (source) => {
      if (/^https?:\/\//iu.test(source.uri)) return source;
      const file = await readKnowledgeFile(root, source.uri);
      const previous = savedSources.get(source.id);
      if (
        previous?.fingerprint &&
        previous.uri === source.uri &&
        previous.excerpt === source.excerpt &&
        previous.fingerprint === source.fingerprint &&
        previous.fingerprint !== file?.fingerprint
      )
        return { ...previous, title: source.title };
      if (!file)
        throw new Error(
          `Cannot read research source ${source.uri}. Choose a text file inside the workspace.`,
        );
      if (
        source.excerpt &&
        !file.content.includes(source.excerpt.replaceAll("\r\n", "\n"))
      )
        throw new Error(
          `The excerpt from ${source.uri} does not match its source. Refresh the excerpt.`,
        );
      return {
        ...source,
        fingerprint: file.fingerprint,
        checkedAt: Date.now(),
      };
    }),
  );
  return libraryTransaction(database, () => {
    const previous = parsed.id
      ? readResearchProject(database, parsed.id)
      : null;
    if ((previous?.revision ?? 0) !== parsed.revision)
      throw new Error(
        "This research project changed elsewhere. Reload it before saving.",
      );
    const project: ResearchProject = {
      ...parsed,
      sources,
      id: previous?.id ?? randomUUID(),
      revision: parsed.revision + 1,
      createdAt: previous?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    database
      .prepare(
        "INSERT OR REPLACE INTO projects (id, revision, document) VALUES (?, ?, ?)",
      )
      .run(project.id, project.revision, JSON.stringify(project));
    return project;
  });
}

export function deleteResearchProject(
  database: DatabaseSync,
  id: string,
  revision: number,
): void {
  const result = database
    .prepare("DELETE FROM projects WHERE id = ? AND revision = ?")
    .run(id, revision);
  if (Number(result.changes) !== 1)
    throw new Error(
      "This research project changed elsewhere. Reload it before deleting.",
    );
}

export async function checkResearchSources(
  database: DatabaseSync,
  workspaceRoot: string,
  id: string,
): Promise<ResearchSourceCheck[]> {
  const project = readResearchProject(database, id);
  const root = await realpath(workspaceRoot);
  return Promise.all(
    project.sources.map(async (source) => {
      if (/^https?:\/\//iu.test(source.uri))
        return { sourceId: source.id, state: "unverified" as const };
      const file = await readKnowledgeFile(root, source.uri);
      return {
        sourceId: source.id,
        state: !file
          ? "missing"
          : !source.fingerprint
            ? "unverified"
            : file.fingerprint === source.fingerprint
              ? "current"
              : "changed",
      };
    }),
  );
}
