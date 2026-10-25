import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { promisify } from "node:util";
import { githubRepositorySchema } from "@machdoch/fleet-protocol/cloud-repository";

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
  const scp = /^git@github\.com:([^\s]+)$/i.exec(value);
  const url = new URL(scp ? `https://github.com/${scp[1]}` : value);
  if (
    url.hostname.toLowerCase() !== "github.com" ||
    url.port ||
    url.password ||
    url.search ||
    url.hash ||
    !["https:", "ssh:"].includes(url.protocol) ||
    (url.username && !(url.protocol === "ssh:" && url.username === "git"))
  )
    throw new Error("Use a GitHub remote without embedded credentials.");
  return githubRepositorySchema
    .parse(`https://github.com${url.pathname.replace(/\.git$/i, "")}`)
    .toLowerCase();
}

export async function workspaceGit(
  root: string,
  args: string[],
  signal?: AbortSignal,
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
        timeout: 60000,
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
  baseCommit: string,
): Promise<ClientRepository> {
  if (!/^[a-f0-9]{40}$/.test(baseCommit))
    throw new Error("Use a full base commit SHA.");
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
  const commit = (
    await workspaceGit(repositoryRoot, [
      "rev-parse",
      "--verify",
      `${baseCommit}^{commit}`,
    ])
  ).trim();
  if (commit !== baseCommit)
    throw new Error(
      "Fetch the configured base commit before connecting this workspace.",
    );
  const tree = await workspaceGit(repositoryRoot, [
    "ls-tree",
    "-r",
    "-z",
    baseCommit,
  ]);
  if (tree.split("\0").some((entry) => entry.startsWith("160000 ")))
    throw new Error(
      "This commit contains submodules. An independent checkout is required and is not configured for this runner.",
    );
  const subdirectory = relative(repositoryRoot, workspaceRoot);
  if (subdirectory) {
    const type = (
      await workspaceGit(repositoryRoot, [
        "cat-file",
        "-t",
        `${baseCommit}:${subdirectory.replaceAll("\\", "/")}`,
      ])
    ).trim();
    if (type !== "tree")
      throw new Error(
        "The workspace directory is absent from the configured base commit.",
      );
  }
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
    subdirectory,
    repository,
  };
}
