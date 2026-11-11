import { loadWorkspaceGitDiff, type WorkspaceGitDiff } from "../runtime";

const diffCache = new WeakMap<object, Map<string, Promise<WorkspaceGitDiff>>>();

export const loadCachedWorkspaceGitDiff = (
  workspaceRoot: string,
  repositoryRoot: string,
  path: string,
  revision: object,
): Promise<WorkspaceGitDiff> => {
  const diffs = diffCache.get(revision) ?? new Map();
  diffCache.set(revision, diffs);
  const key = `${repositoryRoot}\n${path}`;
  const cached = diffs.get(key);
  if (cached) return cached;
  const request = loadWorkspaceGitDiff(workspaceRoot, repositoryRoot, path);
  diffs.set(key, request);
  request.catch(() => diffs.delete(key));
  return request;
};

export const prefetchWorkspaceGitDiff = (
  workspaceRoot: string,
  repositoryRoot: string,
  path: string,
  revision: object,
): void => {
  void loadCachedWorkspaceGitDiff(
    workspaceRoot,
    repositoryRoot,
    path,
    revision,
  ).catch(() => undefined);
};
