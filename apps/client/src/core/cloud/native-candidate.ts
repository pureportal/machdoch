import { mkdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExecutionCheck } from "@machdoch/fleet-protocol/cloud-execution";
import type { VerificationEvidence } from "@machdoch/fleet-protocol/cloud-artifacts";
import { within, workspaceGit } from "./repository.js";
import { runBoundedProcess, taskEnvironment } from "./native-process.js";

const gitTimeoutMs = 300000;
const evidenceOutputBytes = 120 * 1024;

export interface NativeCandidate {
  candidateCommit: string;
  tree: string;
  bundlePath: string;
  bundle: Buffer;
  patch: Buffer;
}

export async function snapshotNativeCandidate(
  checkoutRoot: string,
  baseCommit: string,
  artifactsDirectory: string,
  signal: AbortSignal,
): Promise<NativeCandidate> {
  const git = (args: string[]) =>
    workspaceGit(checkoutRoot, args, signal, gitTimeoutMs);
  await mkdir(artifactsDirectory, { recursive: true, mode: 0o700 });
  await git(["add", "-A"]);
  const tree = (await git(["write-tree"])).trim();
  const candidateCommit = (
    await git([
      "-c",
      "user.name=Machdoch agent",
      "-c",
      "user.email=agent@machdoch.invalid",
      "commit-tree",
      tree,
      "-p",
      baseCommit,
      "-m",
      "Machdoch task result",
    ])
  ).trim();
  if (!/^[a-f0-9]{40}$/.test(candidateCommit) || !/^[a-f0-9]{40}$/.test(tree))
    throw new Error("The candidate snapshot returned an invalid identity.");
  await git(["update-ref", "refs/machdoch/candidate", candidateCommit]);
  const bundlePath = join(artifactsDirectory, "candidate.bundle");
  const patchPath = join(artifactsDirectory, "changes.patch");
  await git([
    "bundle",
    "create",
    bundlePath,
    "refs/machdoch/candidate",
    `^${baseCommit}`,
  ]);
  await git([
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--binary",
    `--output=${patchPath}`,
    baseCommit,
    candidateCommit,
  ]);
  return {
    candidateCommit,
    tree,
    bundlePath,
    bundle: await readFile(bundlePath),
    patch: await readFile(patchPath),
  };
}

export async function prepareValidationCheckout(options: {
  directory: string;
  repositoryRoot: string;
  baseCommit: string;
  bundlePath: string;
  candidateCommit: string;
  signal: AbortSignal;
}): Promise<string> {
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const root = await realpath(options.directory);
  const git = (args: string[]) =>
    workspaceGit(root, args, options.signal, gitTimeoutMs);
  await git(["init", "--template=", "--initial-branch=machdoch/validation"]);
  await git([
    "fetch",
    "--no-tags",
    "--no-write-fetch-head",
    "--depth=1",
    "--",
    pathToFileURL(options.repositoryRoot).href,
    options.baseCommit,
  ]);
  await git(["bundle", "verify", "--quiet", options.bundlePath]);
  await git([
    "fetch",
    "--no-tags",
    "--no-write-fetch-head",
    options.bundlePath,
    "refs/machdoch/candidate:refs/machdoch/candidate",
  ]);
  await git(["checkout", "--detach", options.candidateCommit]);
  if ((await git(["rev-parse", "HEAD"])).trim() !== options.candidateCommit)
    throw new Error("The validation checkout does not match the candidate.");
  return root;
}

export async function runNativeCheck(
  checkoutRoot: string,
  workspacePath: string | undefined,
  check: ExecutionCheck,
  candidateCommit: string,
  signal: AbortSignal,
): Promise<VerificationEvidence> {
  const directory = await realpath(join(checkoutRoot, workspacePath ?? ""));
  if (!within(checkoutRoot, directory))
    throw new Error("The check directory is outside the validation checkout.");
  const started = performance.now();
  const result = await runBoundedProcess({
    command: check.command,
    shell: true,
    cwd: directory,
    env: taskEnvironment(),
    timeoutMs: check.timeoutSeconds * 1000,
    signal,
    outputLimitBytes: evidenceOutputBytes,
  });
  if (result.aborted) signal.throwIfAborted();
  return {
    name: check.name,
    command: check.command,
    candidateCommit,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    truncated: result.truncated,
    durationMs: Math.round(performance.now() - started),
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export async function requireUnchangedCandidate(
  checkoutRoot: string,
  signal: AbortSignal,
): Promise<void> {
  const changes = await workspaceGit(
    checkoutRoot,
    ["status", "--porcelain=v1", "--untracked-files=no"],
    signal,
    gitTimeoutMs,
  );
  if (changes.trim())
    throw new Error("Verification changed tracked files in the candidate.");
}

export async function publishCandidateBranch(options: {
  repositoryRoot: string;
  bundlePath: string;
  title: string;
  runId: string;
  signal: AbortSignal;
}): Promise<string> {
  const slug = options.title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  const branch = `machdoch/${slug ? `${slug}-` : ""}${options.runId.slice(0, 8)}`;
  await workspaceGit(
    options.repositoryRoot,
    [
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      options.bundlePath,
      `refs/machdoch/candidate:refs/heads/${branch}`,
    ],
    options.signal,
    gitTimeoutMs,
  );
  return branch;
}
