import { mkdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { assertRalphWorkspaceBoundary } from "./assert-ralph-workspace-boundary.helper.js";
import {
  snapshotRalphIntegrationConflicts,
  stageRalphIntegrationConflictRepairs,
} from "./ralph-integration-conflicts.helper.js";
import {
  readRalphIntegrationState,
  type RalphRunIntegration,
} from "./ralph-integration-state.helper.js";
import type { RalphRunWorktree } from "./ralph-run-worktree.helper.js";
import {
  commitRalphSnapshot,
  runRalphWorktreeGit as git,
  snapshotRalphWorktree,
  stageRalphSourceChanges,
} from "./ralph-worktree-git.helper.js";
import { applyRalphTreeDifference } from "./ralph-worktree-patch.helper.js";
import { withCooperativeFileLock } from "./with-cooperative-file-lock.helper.js";
import { writeJsonAtomically } from "./write-file-atomically.helper.js";

export type { RalphRunIntegration } from "./ralph-integration-state.helper.js";

const removeInterruptedCandidates = async (
  repositoryRoot: string,
  worktreeRoot: string,
  candidateFailure?: unknown,
): Promise<void> => {
  try {
    const worktrees = await git(repositoryRoot, [
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const integrationRoot = `${worktreeRoot}-integration-${attempt}`;
      const candidate = worktrees
        .split("\0\0")
        .find((entry) =>
          entry
            .split("\0")
            .some(
              (field) =>
                field === `worktree ${integrationRoot.replace(/\\/gu, "/")}`,
            ),
        );
      if (!candidate) continue;
      if (!candidate.split("\0").includes("detached")) {
        throw new Error(
          "RALPH integration workspace is no longer a detached candidate.",
        );
      }
      await git(repositoryRoot, [
        "worktree",
        "remove",
        "--force",
        "--force",
        integrationRoot,
      ]);
    }
  } catch (cleanupError) {
    if (candidateFailure !== undefined) {
      const preparationReason =
        candidateFailure instanceof Error
          ? candidateFailure.message
          : String(candidateFailure);
      const cleanupReason =
        cleanupError instanceof Error
          ? cleanupError.message
          : String(cleanupError);
      throw new AggregateError(
        [candidateFailure, cleanupError],
        `RALPH could not prepare or remove its integration candidate: ${preparationReason}\nCandidate cleanup failed: ${cleanupReason}`,
      );
    }
    throw cleanupError;
  }
};

export const integrateRalphRunWorktree = async (
  worktree: RalphRunWorktree,
  runDirectory: string,
  options: {
    verify: (workspaceRoot: string) => Promise<void>;
    repair: (workspaceRoot: string, reason: string) => Promise<void>;
    beforePublish?: () => Promise<void>;
    signal?: AbortSignal;
  },
): Promise<RalphRunIntegration> => {
  const commonDirectory = (
    await git(worktree.repositoryRoot, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ])
  ).trim();
  const statePath = join(runDirectory, "workspace-integration.json");
  const baselineRef = `refs/machdoch/${worktree.branch}/integration`;
  return withCooperativeFileLock(
    join(commonDirectory, "ralph-integration"),
    async () => {
      const assertSourceBranch = async (): Promise<void> => {
        options.signal?.throwIfAborted();
        const [branch, conflicts] = await Promise.all([
          git(worktree.repositoryRoot, ["branch", "--show-current"]),
          git(worktree.repositoryRoot, ["ls-files", "--unmerged"]),
        ]);
        if (branch.trim() !== worktree.sourceBranch) {
          throw new Error("RALPH source branch changed during this run.");
        }
        if (conflicts) {
          throw new Error(
            "RALPH cannot integrate while the source repository has unresolved conflicts.",
          );
        }
      };
      await assertSourceBranch();
      await removeInterruptedCandidates(
        worktree.repositoryRoot,
        worktree.worktreeRoot,
      );
      const state = await readRalphIntegrationState(
        statePath,
        worktree.baseCommit,
      );
      const readPendingRunTree = async (): Promise<string> => {
        const pending = state.pending!;
        const runTree = await snapshotRalphWorktree(worktree.worktreeRoot);
        if (runTree !== pending.runTree && runTree !== pending.mergedTree) {
          throw new Error(
            "RALPH run files changed while integration was being recovered.",
          );
        }
        return runTree;
      };
      const synchronizePendingRun = async (): Promise<void> => {
        const runTree = await readPendingRunTree();
        await applyRalphTreeDifference(
          worktree.worktreeRoot,
          runTree,
          state.pending!.mergedTree,
        );
      };
      const completePending = async (): Promise<RalphRunIntegration> => {
        const pending = state.pending!;
        await synchronizePendingRun();
        state.baseCommit = pending.mergedCommit;
        state.last = pending.result;
        delete state.pending;
        await git(worktree.repositoryRoot, [
          "update-ref",
          baselineRef,
          state.baseCommit,
        ]);
        await writeJsonAtomically(statePath, state);
        return state.last;
      };
      if (state.pending) {
        await readPendingRunTree();
        const sourceTree = await snapshotRalphWorktree(worktree.repositoryRoot);
        if (sourceTree === state.pending.mergedTree) return completePending();
        await options.beforePublish?.();
        await assertSourceBranch();
        await readPendingRunTree();
        if (
          (await git(worktree.repositoryRoot, ["rev-parse", "HEAD"])).trim() ===
            state.pending.sourceHead &&
          (await snapshotRalphWorktree(worktree.repositoryRoot)) ===
            state.pending.sourceTree
        ) {
          await applyRalphTreeDifference(
            worktree.repositoryRoot,
            state.pending.sourceTree,
            state.pending.mergedTree,
          );
          return completePending();
        }
        await synchronizePendingRun();
        state.baseCommit = await commitRalphSnapshot(
          worktree.repositoryRoot,
          state.pending.sourceTree,
          [state.pending.mergedCommit],
        );
        delete state.pending;
        await git(worktree.repositoryRoot, [
          "update-ref",
          baselineRef,
          state.baseCommit,
        ]);
        await writeJsonAtomically(statePath, state);
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await assertSourceBranch();
        const [sourceHeadOutput, sourceTree, runTree, baseTreeOutput] =
          await Promise.all([
            git(worktree.repositoryRoot, ["rev-parse", "HEAD"]),
            snapshotRalphWorktree(worktree.repositoryRoot),
            snapshotRalphWorktree(worktree.worktreeRoot),
            git(worktree.repositoryRoot, [
              "rev-parse",
              `${state.baseCommit}^{tree}`,
            ]),
          ]);
        const sourceHead = sourceHeadOutput.trim();
        const baseTree = baseTreeOutput.trim();
        const sourceCommit = await commitRalphSnapshot(
          worktree.repositoryRoot,
          sourceTree,
          [state.baseCommit],
        );
        if (runTree === baseTree) {
          state.pending = {
            sourceHead,
            sourceTree,
            runTree,
            mergedTree: sourceTree,
            mergedCommit: sourceCommit,
            result: state.last ?? {
              status: "no-changes",
              mergedAt: new Date().toISOString(),
              changedPaths: [],
            },
          };
          await writeJsonAtomically(statePath, state);
          return completePending();
        }
        const runCommit = await commitRalphSnapshot(
          worktree.repositoryRoot,
          runTree,
          [state.baseCommit],
        );
        const integrationRoot = `${worktree.worktreeRoot}-integration-${attempt}`;
        await mkdir(runDirectory, { recursive: true });
        let candidatePrepared = false;
        let candidateFailure: unknown;
        let retryPreparation = false;
        try {
          await git(
            worktree.repositoryRoot,
            ["worktree", "add", "--detach", integrationRoot, sourceCommit],
            options.signal ? { signal: options.signal } : {},
          );
          candidatePrepared = true;
          let failure: string | undefined;
          try {
            await git(integrationRoot, [
              "-c",
              "user.name=RALPH",
              "-c",
              "user.email=ralph@machdoch.local",
              "merge",
              "--no-commit",
              "--no-ff",
              runCommit,
            ]);
          } catch (error) {
            if (!(await git(integrationRoot, ["ls-files", "--unmerged"])))
              throw error;
            failure = `Resolve the Git merge conflicts between the latest source files and this run. ${error instanceof Error ? error.message : String(error)}`;
          }
          const executionRoot = resolve(
            integrationRoot,
            relative(worktree.repositoryRoot, worktree.sourceWorkspaceRoot),
          );
          let mergedTree = "";
          for (let repairAttempt = 0; repairAttempt < 3; repairAttempt += 1) {
            options.signal?.throwIfAborted();
            if (failure) {
              const conflicts =
                await snapshotRalphIntegrationConflicts(integrationRoot);
              try {
                await options.repair(executionRoot, failure);
              } catch (error) {
                options.signal?.throwIfAborted();
                failure = `Automatic repair failed: ${error instanceof Error ? error.message : String(error)}`;
                continue;
              }
              options.signal?.throwIfAborted();
              if (
                !(await stageRalphIntegrationConflictRepairs(
                  integrationRoot,
                  conflicts,
                ))
              ) {
                failure =
                  "Resolve all remaining Git merge conflicts. Stage unchanged files only when they intentionally resolve the conflict.";
                continue;
              }
            }
            await stageRalphSourceChanges(integrationRoot);
            if (await git(integrationRoot, ["ls-files", "--unmerged"])) {
              failure = "Resolve all remaining Git merge conflicts.";
              continue;
            }
            mergedTree = (await git(integrationRoot, ["write-tree"])).trim();
            try {
              await git(integrationRoot, [
                "diff",
                "--check",
                sourceTree,
                mergedTree,
              ]);
              options.signal?.throwIfAborted();
              await options.verify(executionRoot);
              if (
                (await snapshotRalphWorktree(integrationRoot)) !== mergedTree
              ) {
                throw new Error(
                  "Verification changed the candidate files; verify the updated candidate again.",
                );
              }
              failure = undefined;
              break;
            } catch (error) {
              options.signal?.throwIfAborted();
              failure = `Repair the combined changes and pass verification. ${error instanceof Error ? error.message : String(error)}`;
            }
          }
          if (failure)
            throw new Error(
              `RALPH automatic integration exhausted its repair attempts: ${failure}`,
            );
          const changedPaths = (
            await git(integrationRoot, [
              "diff",
              "--name-only",
              "--no-renames",
              "--no-color",
              "-z",
              sourceTree,
              mergedTree,
            ])
          )
            .split("\0")
            .filter(Boolean);
          for (const path of changedPaths) {
            await assertRalphWorkspaceBoundary(
              worktree.sourceWorkspaceRoot,
              resolve(worktree.repositoryRoot, path),
            );
          }
          await options.beforePublish?.();
          await assertSourceBranch();
          if (
            (
              await git(worktree.repositoryRoot, ["rev-parse", "HEAD"])
            ).trim() !== sourceHead ||
            (await snapshotRalphWorktree(worktree.repositoryRoot)) !==
              sourceTree ||
            (await snapshotRalphWorktree(worktree.worktreeRoot)) !== runTree
          )
            continue;
          const mergedCommit = await commitRalphSnapshot(
            integrationRoot,
            mergedTree,
            [sourceCommit, runCommit],
          );
          state.pending = {
            sourceHead,
            sourceTree,
            runTree,
            mergedTree,
            mergedCommit,
            result: {
              status: "merged",
              mergedAt: new Date().toISOString(),
              changedPaths,
            },
          };
          await git(worktree.repositoryRoot, [
            "update-ref",
            baselineRef,
            mergedCommit,
          ]);
          await writeJsonAtomically(statePath, state);
          options.signal?.throwIfAborted();
          await assertSourceBranch();
          if (
            (
              await git(worktree.repositoryRoot, ["rev-parse", "HEAD"])
            ).trim() !== sourceHead ||
            (await snapshotRalphWorktree(worktree.repositoryRoot)) !==
              sourceTree ||
            (await snapshotRalphWorktree(worktree.worktreeRoot)) !== runTree
          ) {
            delete state.pending;
            await writeJsonAtomically(statePath, state);
            continue;
          }
          await applyRalphTreeDifference(
            worktree.repositoryRoot,
            sourceTree,
            mergedTree,
          );
          return completePending();
        } catch (error) {
          candidateFailure = error;
          if (
            !candidatePrepared &&
            attempt < 2 &&
            error instanceof Error &&
            /timed out/iu.test(error.message) &&
            !options.signal?.aborted
          ) {
            retryPreparation = true;
          } else {
            throw error;
          }
        } finally {
          await removeInterruptedCandidates(
            worktree.repositoryRoot,
            worktree.worktreeRoot,
            candidateFailure,
          );
        }
        if (retryPreparation) {
          await setTimeout(
            (attempt + 1) * 1_000 + Math.floor(Math.random() * 250),
            undefined,
            options.signal ? { signal: options.signal } : {},
          );
        }
      }
      throw new Error(
        "RALPH source or run files kept changing during automatic integration; changes remain in the run worktree.",
      );
    },
    {
      timeoutMs: 24 * 60 * 60 * 1000,
      ...(options.signal ? { signal: options.signal } : {}),
      ownerDescription: `RALPH integration ${worktree.branch}`,
    },
  );
};
