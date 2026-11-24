import { useEffect, useState } from "react";
import {
  loadWorkspaceGitOverview,
  loadWorkspaceGitRepositories,
} from "../runtime";
import { workspaceChangeFeed } from "./workspace-change-events";
import {
  buildFileDecorations,
  type FileDecorationIndex,
} from "./workspace-file-decorations";

const EMPTY_DECORATIONS: FileDecorationIndex = {
  files: new Map(),
  folders: new Map(),
};
const RELOAD_DELAY_MS = 150;

export const useWorkspaceFileDecorations = (
  workspaceRoot: string,
): FileDecorationIndex => {
  const [decorations, setDecorations] = useState(EMPTY_DECORATIONS);

  useEffect(() => {
    let active = true;
    let running = false;
    let pending = false;
    let timer: number | undefined;
    setDecorations(EMPTY_DECORATIONS);

    const load = async (): Promise<void> => {
      if (running) {
        pending = true;
        return;
      }
      running = true;
      try {
        const discovery = await loadWorkspaceGitRepositories(workspaceRoot);
        const repositories = await Promise.all(
          discovery.repositories.map(async (repository) => {
            const overview = await loadWorkspaceGitOverview(
              workspaceRoot,
              repository.repositoryRoot,
              { sections: [], untrackedFiles: "normal" },
            );
            return {
              relativePath: repository.relativePath,
              changes: overview.changes,
            };
          }),
        );
        if (active) setDecorations(buildFileDecorations(repositories));
      } catch (error) {
        console.error("Loading file decorations failed", error);
      } finally {
        running = false;
        if (pending && active) {
          pending = false;
          void load();
        }
      }
    };

    void load();
    const unsubscribe = workspaceChangeFeed.subscribe(
      workspaceRoot,
      (event) => {
        if (event.repositories.length === 0 && !event.rescan) return;
        window.clearTimeout(timer);
        timer = window.setTimeout(() => void load(), RELOAD_DELAY_MS);
      },
    );
    return () => {
      active = false;
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [workspaceRoot]);

  return decorations;
};
