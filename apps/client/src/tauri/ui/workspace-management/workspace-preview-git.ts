import type {
  WorkspaceGitAction,
  WorkspaceGitActionOptions,
  WorkspaceGitBranch,
  WorkspaceGitBranchStatus,
  WorkspaceGitBranchSwitchResult,
  WorkspaceGitBranchSwitchTarget,
  WorkspaceGitDiff,
  WorkspaceGitOverview,
  WorkspaceGitRepositoriesStatus,
  WorkspaceGitRepositoryDiscovery,
  WorkspaceGitSummary,
  WorkspacePullRequestOverview,
} from "@machdoch/fleet-protocol/workspace-contract";
import {
  branch,
  change,
  commit,
  seedClean,
  seedDesktop,
  seedMachdoch,
  type PreviewRepository,
} from "./workspace-preview-git-fixtures";

const repositories = new Map<string, PreviewRepository>();

const normalizePreviewPath = (value: string): string =>
  value.replaceAll("/", "\\").replace(/[\\]+$/u, "");

const repositoryKey = (value: string): string =>
  normalizePreviewPath(value).toLocaleLowerCase();

const joinPreviewRoot = (workspaceRoot: string, relativePath: string): string =>
  `${normalizePreviewPath(workspaceRoot)}\\${relativePath.replaceAll("/", "\\")}`;

const isMachdochWorkspace = (workspaceRoot: string): boolean =>
  /\\machdoch$/iu.test(normalizePreviewPath(workspaceRoot));

const previewRepositoryPaths = (workspaceRoot: string): string[] =>
  isMachdochWorkspace(workspaceRoot)
    ? [".", "packages/cloud", "packages/desktop"]
    : [".", "api", "app"];

const repositoryFor = (
  workspaceRoot: string,
  repositoryRoot: string,
): PreviewRepository => {
  const key = repositoryKey(repositoryRoot);
  const existing = repositories.get(key);
  if (existing) return existing;
  const relative = normalizePreviewPath(repositoryRoot)
    .slice(normalizePreviewPath(workspaceRoot).length)
    .replace(/^\\/u, "");
  const created = isMachdochWorkspace(workspaceRoot)
    ? relative === "packages\\desktop"
      ? seedDesktop(workspaceRoot, repositoryRoot)
      : relative === "packages\\cloud"
        ? seedClean(workspaceRoot, repositoryRoot, "machdoch-cloud")
        : seedMachdoch(workspaceRoot, repositoryRoot)
    : seedClean(
        workspaceRoot,
        repositoryRoot,
        relative ||
          normalizePreviewPath(workspaceRoot).split("\\").at(-1) ||
          "repository",
      );
  repositories.set(key, created);
  return created;
};

const currentBranch = (
  repository: PreviewRepository,
): WorkspaceGitBranch | undefined =>
  repository.localBranches.find(
    (candidate) => candidate.name === repository.branch,
  );

const statusFor = (staged: string, unstaged: string): string =>
  `${staged}${unstaged}`;

const PREVIEW_DEFAULT_BRANCHES = ["main", "master"];

const previewRemoteBranch = (
  repository: PreviewRepository,
  branchName: string,
): string | undefined =>
  repository.remoteBranches.find(
    (candidate) => candidate.name === `origin/${branchName}`,
  )?.name;

const previewDefaultBranch = (
  repository: PreviewRepository,
): string | undefined =>
  PREVIEW_DEFAULT_BRANCHES.find(
    (name) =>
      repository.localBranches.some((candidate) => candidate.name === name) ||
      previewRemoteBranch(repository, name) !== undefined,
  );

const overviewFor = (repository: PreviewRepository): WorkspaceGitOverview => {
  const current = currentBranch(repository);
  const changes = repository.changes.map((entry) => ({ ...entry }));
  const defaultBranch = previewDefaultBranch(repository);
  return {
    workspaceRoot: repository.workspaceRoot,
    repositoryRoot: repository.repositoryRoot,
    branch: repository.branch,
    detached: false,
    ...(current?.upstream ? { upstream: current.upstream } : {}),
    ...(defaultBranch ? { defaultBranch } : {}),
    ahead: current?.ahead ?? 0,
    behind: current?.behind ?? 0,
    clean: changes.length === 0,
    stagedCount: changes.filter((entry) => entry.staged && !entry.untracked)
      .length,
    unstagedCount: changes.filter((entry) => entry.unstaged && !entry.untracked)
      .length,
    untrackedCount: changes.filter((entry) => entry.untracked).length,
    conflictedCount: changes.filter((entry) => entry.conflicted).length,
    totalChanges: changes.length,
    changes,
    changesTruncated: false,
    localBranches: repository.localBranches.map((entry) => ({
      ...entry,
      current: entry.name === repository.branch,
    })),
    remoteBranches: repository.remoteBranches.map((entry) => ({ ...entry })),
    remotes: repository.remotes.map((entry) => ({ ...entry })),
    recentCommits: repository.recentCommits.map((entry) => ({ ...entry })),
    stashes: repository.stashes.map(({ changes: _changes, ...stash }) => ({
      ...stash,
    })),
    ...(repository.operation ? { operation: repository.operation } : {}),
  };
};

export const discoverPreviewWorkspaceGitRepositories = (
  workspaceRoot: string,
): WorkspaceGitRepositoryDiscovery => ({
  workspaceRoot,
  repositories: previewRepositoryPaths(workspaceRoot).map((relativePath) => ({
    repositoryRoot:
      relativePath === "."
        ? workspaceRoot
        : joinPreviewRoot(workspaceRoot, relativePath),
    relativePath,
  })),
  scanLimited: false,
  issues: [],
});

export const loadPreviewWorkspaceGitOverview = (
  workspaceRoot: string,
  repositoryRoot: string,
): WorkspaceGitOverview =>
  overviewFor(repositoryFor(workspaceRoot, repositoryRoot));

export const loadPreviewWorkspaceGitRepositoriesStatus = (
  workspaceRoot: string,
): WorkspaceGitRepositoriesStatus => ({
  workspaceRoot,
  repositories: discoverPreviewWorkspaceGitRepositories(
    workspaceRoot,
  ).repositories.map(({ repositoryRoot, relativePath }) => {
    const repository = repositoryFor(workspaceRoot, repositoryRoot);
    const overview = overviewFor(repository);
    const current = currentBranch(repository);
    return {
      repositoryRoot,
      relativePath,
      branch: overview.branch,
      detached: overview.detached,
      ...(overview.upstream ? { upstream: overview.upstream } : {}),
      upstreamGone: current?.upstreamGone ?? false,
      ahead: overview.ahead,
      behind: overview.behind,
      ...(overview.defaultBranch
        ? { defaultBranch: overview.defaultBranch }
        : {}),
      ...(current?.parent ? { parentBranch: current.parent } : {}),
      stagedCount: overview.stagedCount,
      unstagedCount: overview.unstagedCount,
      untrackedCount: overview.untrackedCount,
      conflictedCount: overview.conflictedCount,
      totalChanges: overview.totalChanges,
      changes: overview.changes,
      changesTruncated: overview.changesTruncated,
      ...(overview.operation ? { operation: overview.operation } : {}),
    };
  }),
  scanLimited: false,
  issues: [],
});

export const loadPreviewWorkspaceGitSummary = (
  workspaceRoot: string,
): WorkspaceGitSummary => {
  const overview = loadPreviewWorkspaceGitOverview(
    workspaceRoot,
    workspaceRoot,
  );
  return {
    branch: overview.branch,
    detached: overview.detached,
    ...(overview.upstream ? { upstream: overview.upstream } : {}),
    ahead: overview.ahead,
    behind: overview.behind,
    changes: overview.totalChanges,
    conflicts: overview.conflictedCount,
  };
};

export const loadPreviewWorkspaceGitDiff = (
  workspaceRoot: string,
  repositoryRoot: string,
  relativePath: string,
): WorkspaceGitDiff => {
  const repository = repositoryFor(workspaceRoot, repositoryRoot);
  const path = relativePath.replaceAll("\\", "/");
  const entry = repository.changes.find((candidate) => candidate.path === path);
  if (!entry) throw new Error("This file is no longer changed.");
  const diff = repository.diffs.get(path);
  if (diff)
    return { ...diff, patches: diff.patches.map((item) => ({ ...item })) };
  return {
    path,
    patches: [
      {
        kind: entry.untracked
          ? "untracked"
          : entry.staged
            ? "staged"
            : "unstaged",
        content: [
          `diff --git a/${path} b/${path}`,
          `--- a/${path}`,
          `+++ b/${path}`,
          "@@ -1 +1 @@",
          "-previous",
          "+updated",
        ].join("\n"),
        binary: false,
        truncated: false,
      },
    ],
  };
};

export const loadPreviewWorkspacePullRequests = (
  workspaceRoot: string,
  repositoryRoot: string,
): WorkspacePullRequestOverview => ({
  available: true,
  items: repositoryFor(workspaceRoot, repositoryRoot).pullRequests.map(
    (pullRequest) => ({ ...pullRequest }),
  ),
});

const requireText = (value: string | undefined, message: string): string => {
  const text = value?.trim();
  if (!text) throw new Error(message);
  return text;
};

const requireLocalBranch = (
  repository: PreviewRepository,
  name: string | undefined,
): WorkspaceGitBranch => {
  const found = repository.localBranches.find(
    (candidate) => candidate.name === name,
  );
  if (!found) throw new Error(`Branch \`${name ?? ""}\` does not exist.`);
  return found;
};

const addCommit = (repository: PreviewRepository, subject: string): string => {
  const hash = `f${String(repository.nextCommit++).padStart(6, "0")}`;
  repository.recentCommits.unshift(
    commit(hash, subject, new Date().toISOString()),
  );
  const current = currentBranch(repository);
  if (current) {
    current.commit = hash;
    current.ahead += 1;
  }
  for (const child of repository.localBranches) {
    if (child.parent === repository.branch) child.needsRestack = true;
  }
  return hash;
};

const assertCanSwitch = (repository: PreviewRepository): void => {
  if (repository.changes.some((entry) => entry.conflicted)) {
    throw new Error("Resolve conflicts before switching branches.");
  }
};

const switchTo = (repository: PreviewRepository, name: string): void => {
  assertCanSwitch(repository);
  repository.branch = name;
};

const createBranch = (
  repository: PreviewRepository,
  name: string | undefined,
  parent?: string,
): void => {
  const branchName = requireText(name, "Enter a valid branch name.");
  if (
    repository.localBranches.some((candidate) => candidate.name === branchName)
  ) {
    throw new Error(`A branch named '${branchName}' already exists.`);
  }
  assertCanSwitch(repository);
  repository.localBranches.push(
    branch(branchName, currentBranch(repository)?.commit ?? "0000000", {
      ...(parent ? { parent } : {}),
    }),
  );
  switchTo(repository, branchName);
};

const stackOf = (repository: PreviewRepository): WorkspaceGitBranch[] => {
  const byName = new Map(
    repository.localBranches.map((entry) => [entry.name, entry]),
  );
  let trunk = repository.branch;
  const seen = new Set<string>();
  while (byName.get(trunk)?.parent && !seen.has(trunk)) {
    seen.add(trunk);
    trunk = byName.get(trunk)!.parent!;
  }
  const members: WorkspaceGitBranch[] = [];
  const queue = [trunk];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const child of repository.localBranches) {
      if (child.parent === parent && !members.includes(child)) {
        members.push(child);
        queue.push(child.name);
      }
    }
  }
  return members;
};

const setStage = (
  repository: PreviewRepository,
  paths: readonly string[] | null,
  staged: boolean,
): void => {
  repository.changes = repository.changes.map((entry) => {
    if (paths && !paths.includes(entry.path)) return entry;
    if (staged) {
      return {
        ...entry,
        status: entry.untracked
          ? "A "
          : statusFor(entry.status[1] === "D" ? "D" : "M", " "),
        staged: true,
        unstaged: false,
        untracked: false,
        conflicted: false,
      };
    }
    return entry.status === "A " && !entry.originalPath
      ? {
          ...entry,
          status: "??",
          staged: false,
          unstaged: false,
          untracked: true,
        }
      : {
          ...entry,
          status: statusFor(" ", entry.status[0] === "D" ? "D" : "M"),
          staged: false,
          unstaged: true,
        };
  });
};

export const runPreviewWorkspaceGitAction = (
  workspaceRoot: string,
  repositoryRoot: string,
  action: WorkspaceGitAction,
  options: WorkspaceGitActionOptions,
): WorkspaceGitOverview => {
  const repository = repositoryFor(workspaceRoot, repositoryRoot);
  const current = currentBranch(repository);
  switch (action) {
    case "fetch":
      break;
    case "pull":
      if (current) current.behind = 0;
      break;
    case "push":
      if (current) {
        current.upstream ??= `origin/${current.name}`;
        current.ahead = 0;
        current.upstreamGone = false;
        if (
          !repository.remoteBranches.some(
            (candidate) => candidate.name === current.upstream,
          )
        ) {
          repository.remoteBranches.push(
            branch(current.upstream, current.commit),
          );
        }
      }
      break;
    case "checkout":
      switchTo(
        repository,
        requireLocalBranch(repository, options.branchName).name,
      );
      break;
    case "checkout-remote": {
      const remote = requireText(
        options.branchName,
        "Select a valid remote branch.",
      );
      const local = remote.replace(/^[^/]+\//u, "");
      assertCanSwitch(repository);
      if (
        !repository.localBranches.some((candidate) => candidate.name === local)
      ) {
        repository.localBranches.push(
          branch(local, "0d1e2f3", { upstream: remote }),
        );
      }
      switchTo(repository, local);
      break;
    }
    case "create-branch":
      createBranch(repository, options.branchName);
      break;
    case "create-stacked-branch":
      createBranch(repository, options.branchName, repository.branch);
      break;
    case "stack-branch": {
      const target = requireLocalBranch(repository, options.branchName);
      requireLocalBranch(repository, options.parentBranch);
      if (target.name === options.parentBranch) {
        throw new Error("A branch cannot be stacked on itself.");
      }
      target.parent = options.parentBranch;
      break;
    }
    case "unstack-branch": {
      const target = requireLocalBranch(repository, options.branchName);
      delete target.parent;
      target.needsRestack = false;
      break;
    }
    case "delete-branch": {
      const target = requireLocalBranch(repository, options.branchName);
      if (target.name === repository.branch) {
        throw new Error("Switch to another branch before deleting this one.");
      }
      if (!options.force && target.parent) {
        throw new Error(
          `\`${target.name}\` has unmerged commits. Delete it anyway to discard them.`,
        );
      }
      repository.localBranches = repository.localBranches.filter(
        (candidate) => candidate !== target,
      );
      for (const child of repository.localBranches) {
        if (child.parent !== target.name) continue;
        if (target.parent) child.parent = target.parent;
        else delete child.parent;
      }
      break;
    }
    case "reset": {
      if (repository.operation) {
        throw new Error(
          `Finish or abort the ${repository.operation} before resetting.`,
        );
      }
      const target = options.startPoint?.trim() || current?.upstream;
      if (!target) {
        throw new Error(
          "This branch has no upstream. Choose a branch or commit to reset to.",
        );
      }
      if (current) {
        current.ahead = 0;
        current.behind = 0;
      }
      if (options.resetMode === "discard") {
        repository.changes = repository.changes.filter(
          (entry) => entry.untracked,
        );
      } else {
        setStage(
          repository,
          repository.changes
            .filter((entry) => entry.staged)
            .map((entry) => entry.path),
          false,
        );
      }
      break;
    }
    case "restack": {
      const members = stackOf(repository);
      if (members.length === 0)
        throw new Error("This branch is not part of a stack.");
      for (const member of members) member.needsRestack = false;
      break;
    }
    case "submit-pull-requests": {
      const members = stackOf(repository);
      const submitted = members.length > 0 ? members : current ? [current] : [];
      for (const member of submitted) {
        member.upstream ??= `origin/${member.name}`;
        member.ahead = 0;
        const existing = repository.pullRequests.find(
          (pullRequest) => pullRequest.headBranch === member.name,
        );
        if (existing) {
          existing.baseBranch = member.parent ?? existing.baseBranch;
          continue;
        }
        const number = 200 + repository.pullRequests.length;
        repository.pullRequests.push({
          number,
          title: member.name,
          state: "OPEN",
          url: `https://github.com/example/preview/pull/${number}`,
          headBranch: member.name,
          baseBranch: member.parent ?? "main",
          draft: options.draft === true,
          author: "machdoch",
          updatedAt: new Date().toISOString(),
        });
      }
      break;
    }
    case "merge":
    case "rebase": {
      const source = requireText(options.branchName, "Select a valid branch.");
      if (source.includes("conflict")) {
        repository.operation = action;
        repository.changes.push(change("UU", "src/merge-conflict.ts"));
        throw new Error(
          `${action === "merge" ? "Merge" : "Rebase"} stopped with conflicts. Resolve them, stage the files, then continue or abort.`,
        );
      }
      if (action === "merge") addCommit(repository, `Merge branch '${source}'`);
      else if (current) {
        current.behind = 0;
        current.needsRestack = false;
      }
      break;
    }
    case "continue-operation":
    case "abort-operation":
    case "skip-operation":
      if (!repository.operation) {
        throw new Error("No merge, rebase, or cherry-pick is in progress.");
      }
      if (
        action === "continue-operation" &&
        repository.changes.some((entry) => entry.conflicted)
      ) {
        throw new Error("Resolve and stage all conflicts before continuing.");
      }
      if (action === "continue-operation" && repository.operation === "merge") {
        addCommit(repository, "Merge with resolved conflicts");
      }
      repository.changes = repository.changes.filter(
        (entry) => entry.path !== "src/merge-conflict.ts",
      );
      delete repository.operation;
      break;
    case "stage":
      setStage(repository, options.paths ?? [], true);
      break;
    case "unstage":
      setStage(repository, options.paths ?? [], false);
      break;
    case "stage-all":
      setStage(repository, null, true);
      break;
    case "unstage-all":
      setStage(repository, null, false);
      break;
    case "commit": {
      const message = requireText(options.message, "Enter a commit message.");
      const staged = repository.changes.filter((entry) => entry.staged);
      if (staged.length === 0) throw new Error("nothing added to commit");
      repository.changes = repository.changes
        .filter((entry) => entry.unstaged || entry.untracked)
        .map((entry) =>
          entry.staged
            ? {
                ...entry,
                status: statusFor(" ", entry.status[1] ?? "M"),
                staged: false,
              }
            : entry,
        );
      addCommit(repository, message.split("\n")[0] ?? message);
      break;
    }
    case "stash-push": {
      const stashed = repository.changes.filter(
        (entry) => options.includeUntracked || !entry.untracked,
      );
      if (stashed.length === 0) break;
      repository.changes = repository.changes.filter(
        (entry) => !stashed.includes(entry),
      );
      repository.stashes.unshift({
        reference: "stash@{0}",
        message: `On ${repository.branch}: ${options.message?.trim() || "WIP"}`,
        createdAt: new Date().toISOString(),
        changes: stashed,
      });
      repository.stashes.forEach((stash, index) => {
        stash.reference = `stash@{${index}}`;
      });
      break;
    }
    case "stash-apply":
    case "stash-pop":
    case "stash-drop": {
      const index = repository.stashes.findIndex(
        (stash) => stash.reference === options.stashRef,
      );
      if (index < 0) throw new Error("Select a valid stash.");
      const [stash] = repository.stashes.slice(index, index + 1);
      if (action !== "stash-drop" && stash) {
        for (const entry of stash.changes) {
          if (
            !repository.changes.some(
              (candidate) => candidate.path === entry.path,
            )
          ) {
            repository.changes.push({ ...entry });
          }
        }
      }
      if (action !== "stash-apply") {
        repository.stashes.splice(index, 1);
        repository.stashes.forEach((entry, position) => {
          entry.reference = `stash@{${position}}`;
        });
      }
      break;
    }
    case "add-remote":
      repository.remotes.push({
        name: requireText(options.remoteName, "Enter a valid remote name."),
        fetchUrl: options.remoteUrl,
        pushUrl: options.remoteUrl,
      });
      break;
    case "remove-remote":
      repository.remotes = repository.remotes.filter(
        (remote) => remote.name !== options.remoteName,
      );
      break;
  }
  return overviewFor(repository);
};

export const resetPreviewWorkspaceGit = (): void => {
  repositories.clear();
};

const previewRelativePath = (
  workspaceRoot: string,
  repositoryRoot: string,
): string =>
  discoverPreviewWorkspaceGitRepositories(workspaceRoot).repositories.find(
    (candidate) =>
      repositoryKey(candidate.repositoryRoot) === repositoryKey(repositoryRoot),
  )?.relativePath ?? repositoryRoot;

export const loadPreviewWorkspaceGitBranchStatus = (
  workspaceRoot: string,
  branchName: string | null,
): WorkspaceGitBranchStatus => {
  const branches = new Set<string>();
  const discovered =
    discoverPreviewWorkspaceGitRepositories(workspaceRoot).repositories;
  return {
    workspaceRoot,
    ...(branchName ? { branchName } : {}),
    repositories: discovered.map(({ repositoryRoot, relativePath }) => {
      const repository = repositoryFor(workspaceRoot, repositoryRoot);
      for (const candidate of repository.localBranches) {
        branches.add(candidate.name);
      }
      for (const candidate of repository.remoteBranches) {
        branches.add(candidate.name.replace(/^[^/]+\//u, ""));
      }
      const defaultBranch = previewDefaultBranch(repository);
      const branchRemote = branchName
        ? previewRemoteBranch(repository, branchName)
        : undefined;
      return {
        repositoryRoot,
        relativePath,
        currentBranch: repository.branch,
        ...(defaultBranch ? { defaultBranch } : {}),
        branchLocal: branchName
          ? repository.localBranches.some(
              (candidate) => candidate.name === branchName,
            )
          : false,
        ...(branchRemote ? { branchRemote } : {}),
        changes: repository.changes.length,
        conflicts: repository.changes.filter((entry) => entry.conflicted)
          .length,
        ...(repository.operation ? { operation: repository.operation } : {}),
      };
    }),
    branches: [...branches],
    scanLimited: false,
    issues: [],
  };
};

type PreviewSwitchSource = "current" | "local" | "remote" | "create";

export const switchPreviewWorkspaceGitBranches = (
  workspaceRoot: string,
  targets: readonly WorkspaceGitBranchSwitchTarget[],
  stashChanges: boolean,
): WorkspaceGitBranchSwitchResult[] => {
  const prepared = targets.map((target) => {
    const repository = repositoryFor(workspaceRoot, target.repositoryRoot);
    const relativePath = previewRelativePath(
      workspaceRoot,
      target.repositoryRoot,
    );
    const name =
      relativePath === "."
        ? (normalizePreviewPath(workspaceRoot).split("\\").at(-1) ??
          relativePath)
        : relativePath;
    const branchName = requireText(
      target.branchName,
      `${name}: Enter a valid branch name.`,
    );
    let source: PreviewSwitchSource;
    if (repository.branch === branchName) {
      source = "current";
    } else if (repository.operation) {
      throw new Error(`Finish the ${repository.operation} in ${name} first.`);
    } else if (repository.changes.some((entry) => entry.conflicted)) {
      throw new Error(`Resolve the conflicts in ${name} first.`);
    } else if (
      repository.localBranches.some((candidate) => candidate.name === branchName)
    ) {
      source = "local";
    } else if (previewRemoteBranch(repository, branchName)) {
      source = "remote";
    } else if (target.create) {
      source = "create";
    } else {
      throw new Error(`Branch \`${branchName}\` does not exist in ${name}.`);
    }
    return { target, repository, relativePath, branchName, source };
  });
  return prepared.map(
    ({ target, repository, relativePath, branchName, source }) => {
      const result: WorkspaceGitBranchSwitchResult = {
        repositoryRoot: target.repositoryRoot,
        relativePath,
        branchName,
        switched: false,
        stashed: false,
      };
      if (source === "current") return result;
      if (
        stashChanges &&
        source !== "create" &&
        repository.changes.length > 0
      ) {
        runPreviewWorkspaceGitAction(
          workspaceRoot,
          target.repositoryRoot,
          "stash-push",
          {
            includeUntracked: true,
            message: `Before switching to ${branchName}`,
          },
        );
        result.stashed = true;
      }
      if (source === "remote") {
        repository.localBranches.push(
          branch(branchName, "0d1e2f3", { upstream: `origin/${branchName}` }),
        );
      } else if (source === "create") {
        repository.localBranches.push(
          branch(branchName, currentBranch(repository)?.commit ?? "0000000"),
        );
      }
      repository.branch = branchName;
      result.switched = true;
      return result;
    },
  );
};
