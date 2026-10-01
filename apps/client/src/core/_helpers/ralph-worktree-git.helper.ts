import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { runStreamingCommand } from "./streaming-command.js";

export const RALPH_SOURCE_PATHS = [
  ".",
  ":(glob,exclude).machdoch/**",
  ":(glob,exclude)**/.machdoch/**",
];

export const runRalphWorktreeGit = async (
  cwd: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    input?: string;
    onStdoutBytes?: (chunk: Buffer) => void;
    signal?: AbortSignal;
  } = {},
): Promise<string> => {
  try {
    const result = await runStreamingCommand(
      "git",
      ["--no-optional-locks", ...args],
      {
        cwd,
        timeoutMs: 30_000,
        maxBufferBytes: 32 * 1024 * 1024,
        normalizeOutput: false,
        ...options,
      },
    );
    return result.stdout;
  } catch (error) {
    if (
      error instanceof Error &&
      "stderr" in error &&
      typeof error.stderr === "string" &&
      error.stderr.trim()
    ) {
      throw new Error(error.stderr.trim(), { cause: error });
    }
    throw error;
  }
};

export const snapshotRalphWorktree = async (root: string): Promise<string> => {
  const gitDirectory = (
    await runRalphWorktreeGit(root, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ])
  ).trim();
  const indexPath = join(gitDirectory, `ralph-index-${randomUUID()}`);
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  try {
    await runRalphWorktreeGit(root, ["read-tree", "HEAD"], { env });
    await runRalphWorktreeGit(
      root,
      ["add", "--all", "--", ...RALPH_SOURCE_PATHS],
      { env },
    );
    const artifacts = await runRalphWorktreeGit(
      root,
      ["ls-files", "-z", "--", ":(glob).machdoch/**", ":(glob)**/.machdoch/**"],
      { env },
    );
    if (artifacts) {
      await runRalphWorktreeGit(
        root,
        ["update-index", "--force-remove", "-z", "--stdin"],
        {
          env,
          input: artifacts,
        },
      );
    }
    return (await runRalphWorktreeGit(root, ["write-tree"], { env })).trim();
  } finally {
    await Promise.all(
      [indexPath, `${indexPath}.lock`].map((path) => rm(path, { force: true })),
    );
  }
};

export const commitRalphSnapshot = async (
  root: string,
  tree: string,
  parents: readonly string[],
): Promise<string> =>
  (
    await runRalphWorktreeGit(
      root,
      [
        "commit-tree",
        tree,
        ...parents.flatMap((parent) => ["-p", parent]),
        "-m",
        "RALPH workspace snapshot",
      ],
      {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "RALPH",
          GIT_AUTHOR_EMAIL: "ralph@machdoch.local",
          GIT_COMMITTER_NAME: "RALPH",
          GIT_COMMITTER_EMAIL: "ralph@machdoch.local",
        },
      },
    )
  ).trim();
