import { resolve } from "node:path";
import type { RalphUtilityConfig } from "../ralph.js";
import { resolveWorkspaceTarget } from "./agent-tools-shared.js";

export const assertRalphWorkspaceBoundary = async (
  workspaceBoundary: string,
  blockWorkspace: string,
  attachments: readonly string[] = [],
  utility?: RalphUtilityConfig,
): Promise<void> => {
  const paths = [
    resolve(blockWorkspace),
    ...attachments,
    utility?.cwd,
    utility?.path,
    utility?.rootPath,
    utility?.registryPath,
    utility?.outputPath,
    utility?.markdownPath,
    utility?.screenshotPath,
    utility?.server?.cwd,
  ];
  for (const path of paths) {
    if (
      path?.trim() &&
      !(
        await resolveWorkspaceTarget(
          workspaceBoundary,
          resolve(blockWorkspace, path),
        )
      ).insideWorkspace
    ) {
      throw new Error("Workflow paths must stay inside the active workspace.");
    }
  }
};
