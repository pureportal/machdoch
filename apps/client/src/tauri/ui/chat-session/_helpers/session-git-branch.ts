import type {
  WorkspaceGitBranchRepository,
  WorkspaceGitBranchStatus,
  WorkspaceGitBranchSwitchResult,
  WorkspaceGitBranchSwitchTarget,
} from "../../runtime";

export type SessionGitBranchRepositoryState =
  | "on-branch"
  | "on-default"
  | "not-switched"
  | "other-branch"
  | "detached"
  | "unavailable";

export type SessionGitBranchStatus =
  | "matched"
  | "new"
  | "not-switched"
  | "mismatch"
  | "unknown";

export interface SessionGitBranchRepositoryEvaluation {
  repository: WorkspaceGitBranchRepository;
  state: SessionGitBranchRepositoryState;
  expectedBranch: string | null;
}

export interface SessionGitBranchEvaluation {
  branchName: string;
  status: SessionGitBranchStatus;
  repositories: SessionGitBranchRepositoryEvaluation[];
}

export type SessionGitBranchBlockReason =
  | "operation"
  | "conflicts"
  | "no-default-branch";

export interface SessionGitBranchBlocker {
  relativePath: string;
  reason: SessionGitBranchBlockReason;
  operation?: string;
}

export interface SessionGitBranchPlan {
  kind: "switch" | "create";
  targets: WorkspaceGitBranchSwitchTarget[];
  dirtyRepositories: string[];
  blockers: SessionGitBranchBlocker[];
}

export interface SessionGitBranchSwitchOutcome {
  stashed: string[];
  failures: string[];
}

const PROBLEM_STATES = new Set<SessionGitBranchRepositoryState>([
  "other-branch",
  "detached",
]);

const SWITCHABLE_STATES = new Set<SessionGitBranchRepositoryState>([
  "not-switched",
  "other-branch",
  "detached",
]);

const evaluateRepository = (
  branchName: string,
  repository: WorkspaceGitBranchRepository,
): SessionGitBranchRepositoryEvaluation => {
  if (repository.error) {
    return { repository, state: "unavailable", expectedBranch: null };
  }
  const branchExists =
    repository.branchLocal || repository.branchRemote !== undefined;
  const expectedBranch = branchExists
    ? branchName
    : (repository.defaultBranch ?? null);
  const current = repository.currentBranch;
  if (current === branchName) {
    return { repository, state: "on-branch", expectedBranch: branchName };
  }
  if (current === undefined) {
    return { repository, state: "detached", expectedBranch };
  }
  if (current === repository.defaultBranch) {
    return {
      repository,
      state: branchExists ? "not-switched" : "on-default",
      expectedBranch,
    };
  }
  return { repository, state: "other-branch", expectedBranch };
};

const aggregateStatus = (
  repositories: readonly SessionGitBranchRepositoryEvaluation[],
): SessionGitBranchStatus => {
  const states = new Set(repositories.map((entry) => entry.state));
  if (repositories.length === 0) return "unknown";
  if ([...states].some((state) => PROBLEM_STATES.has(state))) {
    return "mismatch";
  }
  if (states.has("unavailable")) return "unknown";
  if (states.has("not-switched")) return "not-switched";
  if (states.has("on-branch")) return "matched";
  return "new";
};

export const evaluateSessionGitBranch = (
  branchName: string,
  status: WorkspaceGitBranchStatus,
): SessionGitBranchEvaluation => {
  const repositories = status.repositories.map((repository) =>
    evaluateRepository(branchName, repository),
  );
  return {
    branchName,
    status: aggregateStatus(repositories),
    repositories,
  };
};

const repositoryBlocker = (
  repository: WorkspaceGitBranchRepository,
): SessionGitBranchBlocker | null => {
  if (repository.operation) {
    return {
      relativePath: repository.relativePath,
      reason: "operation",
      operation: repository.operation,
    };
  }
  if (repository.conflicts > 0) {
    return { relativePath: repository.relativePath, reason: "conflicts" };
  }
  return null;
};

const matchesRepository = (
  entry: SessionGitBranchRepositoryEvaluation,
  repositoryRoot: string | undefined,
): boolean =>
  repositoryRoot === undefined ||
  entry.repository.repositoryRoot === repositoryRoot;

export const planSessionGitBranchSwitch = (
  evaluation: SessionGitBranchEvaluation,
  repositoryRoot?: string,
): SessionGitBranchPlan => {
  const plan: SessionGitBranchPlan = {
    kind: "switch",
    targets: [],
    dirtyRepositories: [],
    blockers: [],
  };
  for (const entry of evaluation.repositories) {
    if (
      !SWITCHABLE_STATES.has(entry.state) ||
      !matchesRepository(entry, repositoryRoot)
    ) {
      continue;
    }
    const { repository } = entry;
    if (entry.expectedBranch === null) {
      plan.blockers.push({
        relativePath: repository.relativePath,
        reason: "no-default-branch",
      });
      continue;
    }
    const blocker = repositoryBlocker(repository);
    if (blocker) {
      plan.blockers.push(blocker);
      continue;
    }
    plan.targets.push({
      repositoryRoot: repository.repositoryRoot,
      branchName: entry.expectedBranch,
      create: false,
    });
    if (repository.changes > 0) {
      plan.dirtyRepositories.push(repository.relativePath);
    }
  }
  return plan;
};

export const planSessionGitBranchCreate = (
  evaluation: SessionGitBranchEvaluation,
  repositoryRoot?: string,
): SessionGitBranchPlan => {
  const plan: SessionGitBranchPlan = {
    kind: "create",
    targets: [],
    dirtyRepositories: [],
    blockers: [],
  };
  for (const entry of evaluation.repositories) {
    if (
      entry.state !== "on-default" ||
      !matchesRepository(entry, repositoryRoot)
    ) {
      continue;
    }
    const blocker = repositoryBlocker(entry.repository);
    if (blocker) {
      plan.blockers.push(blocker);
      continue;
    }
    plan.targets.push({
      repositoryRoot: entry.repository.repositoryRoot,
      branchName: evaluation.branchName,
      create: true,
    });
  }
  return plan;
};

export const sessionGitBranchPrimaryPlan = (
  evaluation: SessionGitBranchEvaluation,
): SessionGitBranchPlan | null => {
  if (evaluation.status === "mismatch" || evaluation.status === "not-switched") {
    const plan = planSessionGitBranchSwitch(evaluation);
    return plan.targets.length > 0 || plan.blockers.length > 0 ? plan : null;
  }
  if (evaluation.status === "new" && evaluation.repositories.length === 1) {
    return planSessionGitBranchCreate(evaluation);
  }
  return null;
};

export const describeSessionGitBranchBlocker = (
  blocker: SessionGitBranchBlocker,
  repositoryName: string,
): string => {
  switch (blocker.reason) {
    case "operation":
      return `Finish the ${blocker.operation ?? "operation"} in ${repositoryName} first.`;
    case "conflicts":
      return `Resolve the conflicts in ${repositoryName} first.`;
    case "no-default-branch":
      return `${repositoryName} has no default branch to switch to.`;
  }
};

export const summarizeSessionGitBranchSwitch = (
  results: readonly WorkspaceGitBranchSwitchResult[],
  repositoryName: (relativePath: string) => string,
): SessionGitBranchSwitchOutcome => ({
  stashed: results
    .filter((result) => result.stashed)
    .map((result) => repositoryName(result.relativePath)),
  failures: results.flatMap((result) =>
    result.error
      ? [`${repositoryName(result.relativePath)}: ${result.error}`]
      : [],
  ),
});

export const sessionGitRepositoryName = (
  workspaceRoot: string,
  relativePath: string,
): string =>
  relativePath === "."
    ? (workspaceRoot.split(/[\\/]/u).filter(Boolean).at(-1) ?? workspaceRoot)
    : relativePath;

export const sessionGitBranchSuggestions = (
  status: WorkspaceGitBranchStatus,
): string[] => {
  const checkedOut = status.repositories.flatMap((repository) =>
    repository.currentBranch &&
    repository.currentBranch !== repository.defaultBranch
      ? [repository.currentBranch]
      : [],
  );
  return [...new Set([...checkedOut, ...status.branches])];
};
