import { useEffect, useState } from "react";
import {
  loadWorkspaceGitCommit,
  loadWorkspaceGitGraph,
  type WorkspaceGitCommitDetail,
  type WorkspaceGitGraph,
  type WorkspaceGitGraphScope,
  type WorkspaceGitOverview,
} from "../runtime";
import { createWorkspaceRootKey } from "./workspace-management-model";

const MAX_CACHED_COMMITS = 120;

interface CachedGraph {
  revision: string;
  graph: WorkspaceGitGraph;
}

const graphCache = new Map<string, CachedGraph>();
const commitCache = new Map<string, Promise<WorkspaceGitCommitDetail>>();

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const workspaceGitGraphRevision = (
  overview: WorkspaceGitOverview,
): string =>
  [
    overview.detached ? "detached" : overview.branch,
    overview.recentCommits[0]?.hash ?? "",
    ...overview.localBranches.map(
      (branch) => `${branch.name}=${branch.commit}`,
    ),
    ...overview.remoteBranches.map(
      (branch) => `${branch.name}=${branch.commit}`,
    ),
  ].join("\n");

const graphKey = (repositoryRoot: string, scope: WorkspaceGitGraphScope) =>
  `${createWorkspaceRootKey(repositoryRoot)}\n${scope}`;

export interface WorkspaceGitGraphState {
  graph: WorkspaceGitGraph | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export const useWorkspaceGitGraph = (
  overview: WorkspaceGitOverview,
  scope: WorkspaceGitGraphScope,
): WorkspaceGitGraphState => {
  const key = graphKey(overview.repositoryRoot, scope);
  const revision = workspaceGitGraphRevision(overview);
  const [state, setState] = useState<{
    key: string;
    graph: WorkspaceGitGraph | null;
    loading: boolean;
    error: string | null;
  }>(() => ({
    key,
    graph: graphCache.get(key)?.graph ?? null,
    loading: false,
    error: null,
  }));
  const [reloadToken, setReloadToken] = useState(0);
  const current =
    state.key === key
      ? state
      : {
          key,
          graph: graphCache.get(key)?.graph ?? null,
          loading: false,
          error: null,
        };

  useEffect(() => {
    const cached = graphCache.get(key);
    if (cached?.revision === revision) {
      setState({ key, graph: cached.graph, loading: false, error: null });
      return;
    }
    let active = true;
    setState((previous) => ({
      key,
      graph: previous.key === key ? previous.graph : (cached?.graph ?? null),
      loading: true,
      error: null,
    }));
    loadWorkspaceGitGraph(
      overview.workspaceRoot,
      overview.repositoryRoot,
      scope,
    )
      .then((graph) => {
        graphCache.set(key, { revision, graph });
        if (active) setState({ key, graph, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (active) {
          setState((previous) => ({
            ...previous,
            loading: false,
            error: errorMessage(error),
          }));
        }
      });
    return () => {
      active = false;
    };
  }, [
    key,
    overview.repositoryRoot,
    overview.workspaceRoot,
    reloadToken,
    revision,
    scope,
  ]);

  return {
    graph: current.graph,
    loading: current.loading,
    error: current.error,
    reload: () => {
      graphCache.delete(key);
      setReloadToken((token) => token + 1);
    },
  };
};

export interface WorkspaceGitCommitQuery {
  base?: string;
  relativePath?: string;
}

export const loadCachedWorkspaceGitCommit = (
  workspaceRoot: string,
  repositoryRoot: string,
  commit: string,
  query: WorkspaceGitCommitQuery = {},
): Promise<WorkspaceGitCommitDetail> => {
  const key = [
    createWorkspaceRootKey(repositoryRoot),
    commit,
    query.base ?? "",
    query.relativePath ?? "",
  ].join("\n");
  const cached = commitCache.get(key);
  if (cached) return cached;
  const request = loadWorkspaceGitCommit(
    workspaceRoot,
    repositoryRoot,
    commit,
    query,
  );
  commitCache.set(key, request);
  request.catch(() => commitCache.delete(key));
  if (commitCache.size > MAX_CACHED_COMMITS) {
    commitCache.delete(commitCache.keys().next().value!);
  }
  return request;
};

export interface WorkspaceGitCommitState {
  detail: WorkspaceGitCommitDetail | null;
  error: string | null;
}

export const useWorkspaceGitCommit = (
  overview: WorkspaceGitOverview,
  commit: string | null,
  { base, relativePath }: WorkspaceGitCommitQuery = {},
): WorkspaceGitCommitState => {
  const [state, setState] = useState<
    WorkspaceGitCommitState & { requestKey: string | null }
  >({ detail: null, error: null, requestKey: null });
  const requestKey = commit
    ? [commit, base ?? "", relativePath ?? ""].join("\n")
    : null;

  useEffect(() => {
    if (!commit) return;
    let active = true;
    loadCachedWorkspaceGitCommit(
      overview.workspaceRoot,
      overview.repositoryRoot,
      commit,
      { base, relativePath },
    )
      .then((detail) => {
        if (active) setState({ detail, error: null, requestKey });
      })
      .catch((error: unknown) => {
        if (active) {
          setState({ detail: null, error: errorMessage(error), requestKey });
        }
      });
    return () => {
      active = false;
    };
  }, [
    base,
    commit,
    overview.repositoryRoot,
    overview.workspaceRoot,
    relativePath,
    requestKey,
  ]);

  return state.requestKey === requestKey
    ? { detail: state.detail, error: state.error }
    : { detail: null, error: null };
};
