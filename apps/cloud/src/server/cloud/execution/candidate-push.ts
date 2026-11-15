import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const commit = /^[0-9a-f]{40}$/;

export interface CandidatePush {
  cacheDirectory: string;
  organizationId: string;
  remote: string;
  authorization: string | null;
  bundle: Buffer;
  baseCommit: string;
  candidateCommit: string;
  branch: string;
  allowFileRemote?: boolean;
}

function git(
  directory: string,
  args: string[],
  options: { authorization?: string | null; allowFileRemote?: boolean } = {},
): Promise<string> {
  return execute(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "credential.helper=",
      "-c",
      "http.followRedirects=false",
      "-c",
      "protocol.allow=never",
      "-c",
      "protocol.https.allow=always",
      ...(options.allowFileRemote ? ["-c", "protocol.file.allow=always"] : []),
      ...(options.authorization
        ? ["-c", `http.extraHeader=Authorization: ${options.authorization}`]
        : []),
      "-C",
      directory,
      ...args,
    ],
    {
      windowsHide: true,
      timeout: 5 * 60_000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8",
      env: {
        NODE_ENV: process.env.NODE_ENV,
        PATH: process.env.PATH ?? "",
        ...(process.env.SystemRoot
          ? { SystemRoot: process.env.SystemRoot }
          : {}),
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_NO_REPLACE_OBJECTS: "1",
      },
    },
  ).then(
    (result) => result.stdout,
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        throw new Error("Git is not installed on the cloud server.");
      const stderr =
        error && typeof error === "object" && "stderr" in error
          ? String(error.stderr).trim().slice(-500)
          : "";
      throw new Error(`Git ${args[0]} failed${stderr ? `: ${stderr}` : "."}`);
    },
  );
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

export async function pushCandidate(input: CandidatePush): Promise<void> {
  if (!commit.test(input.baseCommit) || !commit.test(input.candidateCommit))
    throw new Error("Use full commit identities.");
  const key = createHash("sha256")
    .update(`${input.organizationId}\n${input.remote.toLowerCase()}`)
    .digest("hex");
  const mirror = join(input.cacheDirectory, `${key}.git`);
  const options = {
    authorization: input.authorization,
    allowFileRemote: input.allowFileRemote ?? false,
  };
  if (!(await exists(join(mirror, "HEAD")))) {
    await mkdir(mirror, { recursive: true });
    await git(mirror, ["init", "--bare", "--template=", "-q"]);
    await git(mirror, ["config", "remote.origin.url", input.remote]);
    await git(mirror, ["config", "remote.origin.promisor", "true"]);
    await git(mirror, [
      "config",
      "remote.origin.partialclonefilter",
      "blob:none",
    ]);
    await git(mirror, ["config", "extensions.partialclone", "origin"]);
  }
  const hasBase = await git(mirror, [
    "cat-file",
    "-e",
    `${input.baseCommit}^{commit}`,
  ]).then(
    () => true,
    () => false,
  );
  if (!hasBase)
    await git(
      mirror,
      [
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--filter=blob:none",
        "--depth=1",
        "origin",
        `${input.baseCommit}:refs/machdoch/base/${input.baseCommit}`,
      ],
      options,
    );
  const bundlePath = join(mirror, `incoming-${randomUUID()}.bundle`);
  const candidateRef = `refs/machdoch/candidates/${input.candidateCommit}`;
  try {
    await writeFile(bundlePath, input.bundle, { flag: "wx" });
    await git(mirror, ["bundle", "verify", "-q", bundlePath]);
    await git(
      mirror,
      [
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        bundlePath,
        `refs/machdoch/candidate:${candidateRef}`,
      ],
      { allowFileRemote: true },
    );
  } finally {
    await rm(bundlePath, { force: true });
  }
  const fetched = (await git(mirror, ["rev-parse", candidateRef])).trim();
  if (fetched !== input.candidateCommit)
    throw new Error("The stored candidate does not match the verified commit.");
  await git(
    mirror,
    [
      "push",
      "--no-verify",
      "--porcelain",
      "origin",
      `${input.candidateCommit}:refs/heads/${input.branch}`,
    ],
    options,
  );
}
