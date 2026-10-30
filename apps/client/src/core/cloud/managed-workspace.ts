import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { WorkerClaim } from "@machdoch/fleet-protocol/cloud-execution";
import { workerClaimReceiptSchema } from "@machdoch/fleet-protocol/cloud-execution";
import { withCooperativeFileLock } from "../_helpers/with-cooperative-file-lock.helper.js";
import { writeJsonAtomically } from "../_helpers/write-file-atomically.helper.js";
import type { ClientCloudConnection } from "./bindings.js";
import { inspectClientRepository, within, workspaceGit } from "./repository.js";

// Concurrent tasks queue behind a whole checkout, which runs about ten Git
// commands of up to a minute each.
const preparationLockTimeoutMs = 10 * 60_000;

const preparationSchema = z.strictObject({
  runId: z.string().uuid(),
  attemptId: z.string().uuid(),
  epoch: z.number().int().positive(),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  baseCommit: z.string().regex(/^[a-f0-9]{40}$/),
  phase: z.enum(["preparing", "ready"]),
});
export interface ManagedClientWorkspace {
  directory: string;
  repositoryDirectory: string;
  checkoutRoot: string;
  workspaceRoot: string;
  branch: string;
  baseCommit: string;
}

async function ownedDirectory(root: string, path: string): Promise<string> {
  if (!within(root, path))
    throw new Error("Managed workspace path is outside its storage root.");
  let current = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      )
        throw error;
    }
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new Error(
        "Managed workspace directories cannot be symbolic links or files.",
      );
  }
  return realpath(current);
}

async function readyWorkspace(
  worktree: string,
  branch: string,
  baseCommit: string,
): Promise<void> {
  const metadata = await lstat(join(worktree, ".git"));
  if (
    (await lstat(worktree)).isSymbolicLink() ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink()
  )
    throw new Error("Managed checkout identity changed.");
  const common = await realpath(
    (
      await workspaceGit(worktree, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ])
    ).trim(),
  );
  if (
    common !== (await realpath(join(worktree, ".git"))) ||
    (await workspaceGit(worktree, ["branch", "--show-current"])).trim() !==
      branch
  )
    throw new Error(
      "Managed checkout belongs to a different repository or branch.",
    );
  await workspaceGit(worktree, [
    "merge-base",
    "--is-ancestor",
    baseCommit,
    "HEAD",
  ]);
}

export async function prepareClientWorkspace(
  storage: string,
  connection: ClientCloudConnection,
  suppliedClaim: WorkerClaim,
  signal?: AbortSignal,
): Promise<ManagedClientWorkspace> {
  const claim = workerClaimReceiptSchema.parse(suppliedClaim);
  const profile = claim.manifest.profile;
  const linked = connection.registration;
  if (
    connection.status !== "linked" ||
    profile.target !== "client" ||
    profile.id !== linked.profile.id ||
    profile.revision !== linked.profile.revision ||
    profile.projectId !== linked.profile.projectId ||
    profile.repository !== connection.binding.repository ||
    profile.baseCommit !== linked.profile.baseCommit ||
    connection.subdirectory.replaceAll("\\", "/") !==
      (profile.workspacePath ?? "") ||
    linked.workspaceBinding?.workspaceId !== connection.binding.workspaceId
  )
    throw new Error("This task does not match the linked client workspace.");
  if (!isAbsolute(storage))
    throw new Error("Managed workspace storage must be absolute.");
  signal?.throwIfAborted();
  if (
    Date.parse(claim.leaseExpiresAt) <= Date.now() ||
    Date.parse(claim.deadlineAt) <= Date.now()
  )
    throw new Error(
      "Task execution authority ended before workspace preparation.",
    );
  const source = await inspectClientRepository(
    connection.workspaceRoot,
    profile.repository,
    profile.baseCommit,
  );
  if (
    source.repositoryRoot !== connection.repositoryRoot ||
    source.gitDirectory !== connection.gitDirectory ||
    source.subdirectory !== connection.subdirectory
  )
    throw new Error(
      "The linked repository moved or changed identity. Connect the workspace again.",
    );
  const parent = await realpath(dirname(storage));
  const destination = join(parent, basename(storage));
  if (
    within(source.repositoryRoot, destination) ||
    within(destination, source.repositoryRoot)
  )
    throw new Error(
      "Keep managed cloud storage separate from the source repository.",
    );
  const root = await ownedDirectory(parent, destination);
  const directory = await ownedDirectory(root, join(root, linked.workerId));
  return withCooperativeFileLock(
    join(directory, "repository"),
    async () => {
      const ownerPath = join(directory, "owner.json");
      const identity = JSON.stringify({
        workerId: linked.workerId,
        origin: connection.origin,
        workspaceId: connection.binding.workspaceId,
        repository: profile.repository,
      });
      let owner: string;
      try {
        owner = await readFile(ownerPath, "utf8");
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        )
          throw error;
        // A competing preparation keeps its lock candidate beside the lock.
        const entries = (await readdir(directory)).filter(
          (name) => !name.startsWith("repository.machdoch.lock"),
        );
        if (entries.length)
          throw new Error(
            "Managed storage has files without an ownership record. Preserve it for recovery.",
          );
        await writeFile(ownerPath, identity, { flag: "wx", mode: 0o600 });
        owner = identity;
      }
      if (owner !== identity || (await lstat(ownerPath)).isSymbolicLink())
        throw new Error("Managed storage belongs to another client workspace.");
      const environment = await ownedDirectory(
        root,
        join(directory, "attempts", claim.attemptId),
      );
      const recordPath = join(environment, "preparation.json");
      const proposed = preparationSchema.parse({
        runId: claim.runId,
        attemptId: claim.attemptId,
        epoch: claim.epoch,
        inputDigest: claim.inputDigest,
        baseCommit: profile.baseCommit,
        phase: "preparing",
      });
      let record;
      try {
        record = preparationSchema.parse(
          JSON.parse(await readFile(recordPath, "utf8")),
        );
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        )
          throw error;
        if ((await readdir(environment)).length)
          throw new Error(
            "Task storage has files without a preparation record. Preserve it for recovery.",
          );
        await writeFile(recordPath, JSON.stringify(proposed), {
          flag: "wx",
          mode: 0o600,
        });
        record = proposed;
      }
      if (
        record.runId !== proposed.runId ||
        record.attemptId !== proposed.attemptId ||
        record.epoch !== proposed.epoch ||
        record.inputDigest !== proposed.inputDigest ||
        record.baseCommit !== proposed.baseCommit ||
        (await lstat(recordPath)).isSymbolicLink()
      )
        throw new Error(
          "The prepared workspace belongs to another task grant.",
        );
      const checkoutRoot = await ownedDirectory(
        root,
        join(environment, "checkout"),
      );
      const repositoryDirectory = join(checkoutRoot, ".git");
      const branch = `machdoch/task/${claim.attemptId}`;
      const git = (args: string[]) => workspaceGit(checkoutRoot, args, signal);
      if (record.phase === "preparing") {
        if (!(await readdir(checkoutRoot)).length) {
          await git(["init", "--template=", `--initial-branch=${branch}`]);
          await git(["config", "core.longpaths", "true"]);
        }
        const metadata = await lstat(repositoryDirectory);
        if (!metadata.isDirectory() || metadata.isSymbolicLink())
          throw new Error("Managed checkout identity changed.");
        const refs = (
          await git(["for-each-ref", "--format=%(objectname)"])
        ).trim();
        if (!refs) {
          if ((await readdir(checkoutRoot)).some((entry) => entry !== ".git"))
            throw new Error(
              "Workspace preparation is incomplete or has unrecorded edits. Preserve the checkout and reconcile it before retrying.",
            );
          await git([
            "fetch",
            "--no-tags",
            "--no-write-fetch-head",
            "--depth=1",
            "--",
            pathToFileURL(source.repositoryRoot).href,
            profile.baseCommit,
          ]);
          await git([
            "checkout",
            "--no-track",
            "-B",
            branch,
            profile.baseCommit,
          ]);
        }
        await readyWorkspace(checkoutRoot, branch, profile.baseCommit);
        try {
          await workspaceGit(
            checkoutRoot,
            ["diff", "--quiet", "--no-ext-diff", "--no-textconv", "HEAD", "--"],
            signal,
          );
          await workspaceGit(
            checkoutRoot,
            [
              "diff",
              "--cached",
              "--quiet",
              "--no-ext-diff",
              "--no-textconv",
              "HEAD",
              "--",
            ],
            signal,
          );
        } catch {
          signal?.throwIfAborted();
          throw new Error(
            "Workspace preparation is incomplete or has unrecorded edits. Preserve the checkout and reconcile it before retrying.",
          );
        }
        await writeJsonAtomically(
          recordPath,
          { ...proposed, phase: "ready" },
          { mode: 0o600 },
        );
      } else await readyWorkspace(checkoutRoot, branch, profile.baseCommit);
      const workspaceRoot = await realpath(
        join(checkoutRoot, source.subdirectory),
      );
      if (!within(checkoutRoot, workspaceRoot))
        throw new Error("Prepared workspace points outside its checkout.");
      return {
        directory: environment,
        repositoryDirectory,
        checkoutRoot,
        workspaceRoot,
        branch,
        baseCommit: profile.baseCommit,
      };
    },
    {
      ...(signal ? { signal } : {}),
      timeoutMs: preparationLockTimeoutMs,
      ownerDescription: "Cloud workspace preparation",
    },
  );
}
