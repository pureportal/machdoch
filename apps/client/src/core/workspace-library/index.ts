import { workspaceLibraryRequestSchema } from "@machdoch/fleet-protocol/workspace-library";
import { openWorkspaceLibrary } from "./database.js";
import { readKnowledgeFile } from "./files.js";
import { realpath } from "node:fs/promises";
import { indexWorkspaceKnowledge, searchWorkspaceKnowledge } from "./search.js";
import {
  checkResearchSources,
  deleteResearchProject,
  listResearchProjects,
  readResearchProject,
  saveResearchProject,
} from "./research.js";

export async function runWorkspaceLibraryRequest(
  workspaceRoot: string,
  input: unknown,
): Promise<unknown> {
  const request = workspaceLibraryRequestSchema.parse(input);
  const database = await openWorkspaceLibrary(workspaceRoot);
  try {
    switch (request.action) {
      case "source": {
        const source = await readKnowledgeFile(
          await realpath(workspaceRoot),
          request.path,
        );
        if (!source)
          throw new Error(
            "This source is unavailable. Search again to refresh the results.",
          );
        return {
          path: request.path,
          content: source.content,
          fingerprint: source.fingerprint,
        };
      }
      case "index":
        return await indexWorkspaceKnowledge(database, workspaceRoot);
      case "search":
        return await searchWorkspaceKnowledge(
          database,
          workspaceRoot,
          request.query,
          request.limit,
        );
      case "projects":
        return listResearchProjects(database);
      case "project":
        return readResearchProject(database, request.id);
      case "save-project":
        return await saveResearchProject(
          database,
          workspaceRoot,
          request.project,
        );
      case "delete-project":
        deleteResearchProject(database, request.id, request.revision);
        return { deleted: true };
      case "check-sources":
        return await checkResearchSources(database, workspaceRoot, request.id);
    }
  } finally {
    database.close();
  }
}
