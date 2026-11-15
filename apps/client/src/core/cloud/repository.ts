import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { promisify } from "node:util";
import { gitRepositoryUrlSchema } from "@machdoch/fleet-protocol/cloud-repository";

const execute = promisify(execFile);
export function within(root: string, path: string): boolean {
  const difference = relative(root, path);
  return (
    difference === "" ||
    (difference !== ".." &&
      !difference.startsWith(`..${sep}`) &&
      !isAbsolute(difference))
  );
}

export function canonicalRepository(value: string): string {
  const scp = /^git@([^\s:/]+):([^\s]+)$/i.exec(value);
  const url = new URL(scp ? `ssh://git@${scp[1]}/${scp[2]}` : value);
  if (
    url.password ||
    url.search ||
    url.hash ||
    !["https:", "ssh:"].includes(url.protocol) ||
    (url.username && !(url.protocol === "ssh:" && url.username === "git"))
  )
    throw new Error("Use a Git remote without embedded credentials.");
  const host = url.protocol === "ssh:" ? url.hostname : url.host;
  return gitRepositoryUrlSchema
    .parse(
      `https://${host.toLowerCase()}${url.pathname.replace(/\.git$/i, "")}`,
    )
    .toLowerCase();
}

export async function workspaceGit(
  root: string,
  args: string[],
  signal?: AbortSignal,
  timeoutMs = 60000,
): Promise<string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(GIT_|SSH_ASKPASS|SSH_AUTH_SOCK)/i.test(key),
    ),
  );
  try {
    const result = await execute(
      "git",
      [
        "--no-optional-locks",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.longpaths=true",
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.file.allow=always",
        "-C",
        root,
        ...args,
      ],
      {
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        encoding: "utf8",
        ...(signal ? { signal } : {}),
        env: {
          ...env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_ATTR_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
          GIT_NO_REPLACE_OBJECTS: "1",
        },
      },
    );
    return result.stdout;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      throw new Error("Git is unavailable. Install Git and restart Machdoch.");
    throw new Error(
      `Git ${args[0]} failed. Check the repository and its permissions before retrying.`,
    );
  }
}

export interface ClientRepository {
  workspaceRoot: string;
  repositoryRoot: string;
  gitDirectory: string;
  subdirectory: string;
  repository: string;
}
export async function inspectClientRepository(
  workspace: string,
  repository: string,
): Promise<ClientRepository> {
  const workspaceRoot = await realpath(workspace);
  const repositoryRoot = await realpath(
    (
      await workspaceGit(workspaceRoot, ["rev-parse", "--show-toplevel"])
    ).trim(),
  );
  if (!within(repositoryRoot, workspaceRoot))
    throw new Error("The workspace is outside its Git checkout.");
  const remote = (
    await workspaceGit(repositoryRoot, [
      "config",
      "--local",
      "--no-includes",
      "--get",
      "remote.origin.url",
    ])
  ).trim();
  if (canonicalRepository(remote) !== canonicalRepository(repository))
    throw new Error(
      "The workspace origin does not match this cloud project's repository.",
    );
  const gitDirectory = await realpath(
    (
      await workspaceGit(repositoryRoot, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ])
    ).trim(),
  );
  return {
    workspaceRoot,
    repositoryRoot,
    gitDirectory,
    subdirectory: relative(repositoryRoot, workspaceRoot),
    repository,
  };
}

export async function resolveClientCommit(
  source: ClientRepository,
  branch: string | null,
  pinned: string | null,
): Promise<string> {
  const reference = pinned ?? `refs/remotes/origin/${branch ?? "HEAD"}`;
  let commit: string;
  try {
    commit = (
      await workspaceGit(source.repositoryRoot, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${reference}^{commit}`,
      ])
    ).trim();
  } catch {
    throw new Error(
      `Fetch the latest ${branch ?? "default branch"} changes in this workspace, then retry.`,
    );
  }
  if (!/^[a-f0-9]{40}$/.test(commit) || (pinned !== null && commit !== pinned))
    throw new Error(
      `Fetch the latest ${branch ?? "default branch"} changes in this workspace, then retry.`,
    );
  const tree = await workspaceGit(source.repositoryRoot, [
    "ls-tree",
    "-r",
    "-z",
    commit,
  ]);
  if (tree.split("\0").some((entry) => entry.startsWith("160000 ")))
    throw new Error(
      "This commit contains submodules. An independent checkout is required and is not configured for this runner.",
    );
  if (source.subdirectory) {
    const type = (
      await workspaceGit(source.repositoryRoot, [
        "cat-file",
        "-t",
        `${commit}:${source.subdirectory.replaceAll("\\", "/")}`,
      ])
    ).trim();
    if (type !== "tree")
      throw new Error(
        "The workspace directory is absent from the base commit.",
      );
  }
  return commit;
}
