import type {
  WorkspaceGitCommitDetail,
  WorkspaceGitGraph,
  WorkspaceGitGraphCommit,
  WorkspaceGitGraphRef,
  WorkspaceGitGraphScope,
} from "@machdoch/fleet-protocol/workspace-contract";
import type { PreviewRepository } from "./workspace-preview-git-fixtures";

const TRUNK_SUBJECTS = [
  "Initial workspace layout",
  "Add Git status overview",
  "Introduce run configurations",
  "Speed up repository discovery",
  "Add workspace run inputs",
  "Polish workspace toolbar",
  "Track branch alignment",
  "Refine workspace tools",
];

const START_TIME = Date.parse("2026-07-20T09:00:00Z");
const HOUR = 3_600_000;

const previewHash = (seed: string): string => {
  let hash = 0x811c9dc5;
  let hex = "";
  for (let round = 0; hex.length < 40; round += 1) {
    for (const character of `${seed}:${round}`) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hex += hash.toString(16).padStart(8, "0");
  }
  return hex.slice(0, 40);
};

interface PreviewHistory {
  commits: Map<string, WorkspaceGitGraphCommit>;
  tips: Map<string, string>;
}

const buildHistory = (
  repository: PreviewRepository,
  trunk: string,
): PreviewHistory => {
  const commits = new Map<string, WorkspaceGitGraphCommit>();
  const tips = new Map<string, string>();
  let clock = START_TIME;
  const add = (seed: string, subject: string, parents: string[]): string => {
    const hash = previewHash(`${repository.repositoryRoot}:${seed}`);
    clock += HOUR;
    commits.set(hash, {
      hash,
      shortHash: hash.slice(0, 7),
      parents,
      subject,
      author: "Machdoch",
      authoredAt: new Date(clock).toISOString(),
      refs: [],
    });
    return hash;
  };
  const trunkChain: string[] = [];
  for (const [index, subject] of TRUNK_SUBJECTS.entries()) {
    trunkChain.push(add(`${trunk}:${index}`, subject, trunkChain.slice(-1)));
  }
  tips.set(trunk, trunkChain.at(-1)!);
  const pending = repository.localBranches.filter(
    (branch) => branch.name !== trunk,
  );
  for (let pass = 0; pending.length > 0 && pass < 4; pass += 1) {
    for (const branch of [...pending]) {
      const base = branch.parent
        ? tips.get(branch.parent)
        : trunkChain[Math.max(1, trunkChain.length - 3 - tips.size)];
      if (!base) continue;
      pending.splice(pending.indexOf(branch), 1);
      const first = add(`${branch.name}:1`, `Start ${branch.name}`, [base]);
      tips.set(
        branch.name,
        add(`${branch.name}:2`, `Continue ${branch.name}`, [first]),
      );
    }
  }
  for (const remote of repository.remoteBranches) {
    const local = remote.name.split("/").slice(1).join("/");
    const localBranch = repository.localBranches.find(
      (branch) => branch.name === local,
    );
    const localTip = tips.get(local);
    if (localTip && localBranch) {
      let tip = localTip;
      for (let step = 0; step < localBranch.ahead; step += 1) {
        tip = commits.get(tip)?.parents[0] ?? tip;
      }
      for (let step = 0; step < localBranch.behind; step += 1) {
        tip = add(`${remote.name}:${step}`, `Upstream update ${step + 1}`, [
          tip,
        ]);
      }
      tips.set(remote.name, tip);
    } else {
      tips.set(
        remote.name,
        add(`${remote.name}:1`, `Prepare ${local}`, [trunkChain[3]!]),
      );
    }
  }
  return { commits, tips };
};

const ancestors = (
  commits: ReadonlyMap<string, WorkspaceGitGraphCommit>,
  starts: readonly string[],
): Set<string> => {
  const seen = new Set<string>();
  const pending = [...starts];
  while (pending.length > 0) {
    const hash = pending.pop()!;
    if (seen.has(hash)) continue;
    seen.add(hash);
    pending.push(...(commits.get(hash)?.parents ?? []));
  }
  return seen;
};

const decorate = (
  history: PreviewHistory,
  current: string,
): Map<string, WorkspaceGitGraphRef[]> => {
  const refs = new Map<string, WorkspaceGitGraphRef[]>();
  const push = (hash: string | undefined, reference: WorkspaceGitGraphRef) => {
    if (hash) refs.set(hash, [...(refs.get(hash) ?? []), reference]);
  };
  push(history.tips.get(current), { name: "HEAD", kind: "head" });
  for (const [name, hash] of history.tips) {
    push(hash, {
      name,
      kind: name.startsWith("origin/") ? "remote" : "local",
    });
  }
  return refs;
};

export const previewWorkspaceGitGraph = (
  repository: PreviewRepository,
  trunk: string,
  scope: WorkspaceGitGraphScope,
): WorkspaceGitGraph => {
  const history = buildHistory(repository, trunk);
  const current = repository.branch;
  const head = history.tips.get(current);
  const currentBranch = repository.localBranches.find(
    (branch) => branch.name === current,
  );
  const baseName = currentBranch?.parent ?? (current !== trunk ? trunk : null);
  const baseTip = baseName ? history.tips.get(baseName) : undefined;
  const upstreamTip = currentBranch?.upstream
    ? history.tips.get(currentBranch.upstream)
    : undefined;
  const visible =
    scope === "all"
      ? new Set(history.commits.keys())
      : ancestors(
          history.commits,
          [head, baseTip, upstreamTip].filter(
            (hash): hash is string => hash !== undefined,
          ),
        );
  const refs = decorate(history, current);
  const commits = [...history.commits.values()]
    .filter((commit) => visible.has(commit.hash))
    .sort((left, right) => right.authoredAt.localeCompare(left.authoredAt))
    .map((commit) => ({ ...commit, refs: refs.get(commit.hash) ?? [] }));
  let base: WorkspaceGitGraph["base"];
  if (baseName && baseTip && head) {
    const headAncestors = ancestors(history.commits, [head]);
    const baseAncestors = ancestors(history.commits, [baseTip]);
    const mergeBase = commits.find(
      (commit) =>
        headAncestors.has(commit.hash) && baseAncestors.has(commit.hash),
    );
    if (mergeBase) {
      base = {
        branch: baseName,
        mergeBase: mergeBase.hash,
        ahead: [...headAncestors].filter((hash) => !baseAncestors.has(hash))
          .length,
        behind: [...baseAncestors].filter((hash) => !headAncestors.has(hash))
          .length,
      };
    }
  }
  return {
    repositoryRoot: repository.repositoryRoot,
    commits,
    truncated: false,
    ...(base ? { base } : {}),
  };
};

export const previewWorkspaceGitCommit = (
  repository: PreviewRepository,
  trunk: string,
  hash: string,
  { base, relativePath }: { base?: string; relativePath?: string },
): WorkspaceGitCommitDetail => {
  const commit = buildHistory(repository, trunk).commits.get(hash);
  if (!commit) throw new Error("This commit is no longer available.");
  const area = commit.subject.split(" ").at(-1)?.toLowerCase() ?? "workspace";
  const files = [
    { path: `src/${area}.ts`, status: "M", additions: 24, deletions: 7 },
    { path: `src/${area}.spec.ts`, status: "A", additions: 41, deletions: 0 },
    { path: "README.md", status: "M", additions: 2, deletions: 2 },
    ...(base
      ? [
          { path: "src/runtime.ts", status: "M", additions: 58, deletions: 19 },
          { path: "docs/legacy.md", status: "D", additions: 0, deletions: 34 },
        ]
      : []),
  ];
  const file = files.find((entry) => entry.path === relativePath);
  return {
    hash: commit.hash,
    parents: commit.parents,
    author: commit.author,
    authoredAt: commit.authoredAt,
    message: `${commit.subject}\n\nKeeps the ${area} flow responsive.`,
    files,
    filesTruncated: false,
    ...(file
      ? {
          patch: {
            kind: "commit" as const,
            content: [
              `diff --git a/${file.path} b/${file.path}`,
              `--- a/${file.path}`,
              `+++ b/${file.path}`,
              "@@ -10,4 +10,5 @@ export const load = () => {",
              "   const state = read();",
              "-  return state;",
              `+  const next = refresh${area.charAt(0).toUpperCase()}${area.slice(1)}(state);`,
              "+  return next;",
              " };",
            ].join("\n"),
            binary: false,
            truncated: false,
          },
        }
      : {}),
  };
};
