import { createWorkspaceRootKey } from "./workspace-management-model";

const GITHUB_PULL_REQUEST =
  /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/u;

export const cloudPullRequestUrl = (
  origin: string,
  pullRequestUrl: string,
): string | null => {
  const match = GITHUB_PULL_REQUEST.exec(pullRequestUrl.trim());
  if (!match) return null;
  const base = origin.trim().replace(/\/+$/u, "");
  if (!/^https?:\/\//u.test(base)) return null;
  const [, owner, repository, number] = match;
  return `${base}/cloud/pull-requests/reference/${owner}/${repository}/${number}`;
};

export const cloudOriginForWorkspace = (
  connections: readonly {
    origin: string;
    workspaceRoot: string;
    status: string;
  }[],
  workspaceRoot: string,
): string | null => {
  const key = createWorkspaceRootKey(workspaceRoot);
  return (
    connections.find(
      (connection) =>
        connection.status !== "disconnected" &&
        createWorkspaceRootKey(connection.workspaceRoot) === key,
    )?.origin ?? null
  );
};
