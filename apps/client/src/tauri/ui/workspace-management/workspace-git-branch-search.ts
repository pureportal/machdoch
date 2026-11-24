export interface BranchCandidate {
  name: string;
  remote: boolean;
  current: boolean;
  ahead: number;
  behind: number;
  upstreamGone: boolean;
  lastCommitAt?: string;
  merged?: boolean;
}

export interface RankedBranch extends BranchCandidate {
  score: number;
  recentRank: number | null;
}

export interface BranchGroups {
  recent: RankedBranch[];
  local: RankedBranch[];
  remote: RankedBranch[];
}

export const fuzzyBranchScore = (
  query: string,
  name: string,
): number | null => {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  const haystack = name.toLowerCase();
  const exact = haystack.indexOf(needle);
  if (exact >= 0) {
    const boundary = exact === 0 || /[/_.-]/u.test(haystack[exact - 1]!);
    return 1_000 - exact - haystack.length / 10 + (boundary ? 200 : 0);
  }
  let score = 0;
  let position = 0;
  let previous = -2;
  for (const character of needle) {
    const found = haystack.indexOf(character, position);
    if (found < 0) return null;
    score += found === previous + 1 ? 15 : 5;
    if (found === 0 || /[/_.-]/u.test(haystack[found - 1]!)) score += 10;
    previous = found;
    position = found + 1;
  }
  return score - haystack.length / 10;
};

export const groupBranches = (
  branches: readonly BranchCandidate[],
  recent: readonly string[],
  query: string,
  recentLimit = 5,
): BranchGroups => {
  const recentIndex = new Map(recent.map((name, index) => [name, index]));
  const ranked = branches.flatMap((branch): RankedBranch[] => {
    const score = fuzzyBranchScore(query, branch.name);
    if (score === null) return [];
    return [
      {
        ...branch,
        score,
        recentRank: branch.remote
          ? null
          : (recentIndex.get(branch.name) ?? null),
      },
    ];
  });
  const byScore = (left: RankedBranch, right: RankedBranch): number =>
    right.score - left.score ||
    Number(right.current) - Number(left.current) ||
    (right.lastCommitAt ?? "").localeCompare(left.lastCommitAt ?? "") ||
    left.name.localeCompare(right.name);
  const recentBranches = ranked
    .filter((branch) => branch.recentRank !== null && !branch.current)
    .sort((left, right) =>
      query.trim()
        ? byScore(left, right)
        : left.recentRank! - right.recentRank!,
    )
    .slice(0, recentLimit);
  const recentNames = new Set(recentBranches.map((branch) => branch.name));
  return {
    recent: recentBranches,
    local: ranked
      .filter((branch) => !branch.remote && !recentNames.has(branch.name))
      .sort(byScore),
    remote: ranked.filter((branch) => branch.remote).sort(byScore),
  };
};

export const recentBranchesFromReflog = (
  subjects: readonly string[],
): string[] => {
  const names: string[] = [];
  for (const subject of subjects) {
    const match = /^checkout: moving from (.+) to (.+)$/u.exec(subject.trim());
    if (!match) continue;
    for (const name of [match[2]!, match[1]!]) {
      if (/^[0-9a-f]{7,40}$/iu.test(name) || names.includes(name)) continue;
      names.push(name);
    }
  }
  return names;
};

export const commitAge = (
  iso: string | undefined,
  now: number,
): string | null => {
  if (!iso) return null;
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  const minutes = Math.max(0, Math.round((now - time) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 60) return `${days}d`;
  const months = Math.round(days / 30);
  return months < 24 ? `${months}mo` : `${Math.round(months / 12)}y`;
};

export interface ChangeCountParts {
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
}

export const changeCountTooltip = (parts: ChangeCountParts): string =>
  [
    parts.conflicted ? `${parts.conflicted} conflicted` : null,
    parts.staged ? `${parts.staged} staged` : null,
    parts.unstaged ? `${parts.unstaged} modified` : null,
    parts.untracked ? `${parts.untracked} untracked` : null,
  ]
    .filter(Boolean)
    .join(" · ");

export interface CleanupCandidate {
  name: string;
  reason: "merged" | "gone" | "stale";
}

export const branchCleanupCandidates = (
  branches: readonly BranchCandidate[],
  protectedNames: ReadonlySet<string>,
  now: number,
  staleDays = 90,
): CleanupCandidate[] =>
  branches.flatMap((branch): CleanupCandidate[] => {
    if (branch.remote || branch.current || protectedNames.has(branch.name))
      return [];
    if (branch.merged) return [{ name: branch.name, reason: "merged" }];
    if (branch.upstreamGone) return [{ name: branch.name, reason: "gone" }];
    const time = branch.lastCommitAt ? Date.parse(branch.lastCommitAt) : NaN;
    if (Number.isFinite(time) && now - time > staleDays * 86_400_000)
      return [{ name: branch.name, reason: "stale" }];
    return [];
  });

export const issueKeyFromBranch = (branchName: string): string | null => {
  const match = /(?:^|\/)([a-z][a-z0-9]{1,15})-(\d{1,7})(?=$|[-_/])/iu.exec(
    branchName,
  );
  return match ? `${match[1]!.toUpperCase()}-${match[2]}` : null;
};

export const branchNameForIssue = (key: string, title: string): string => {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48)
    .replace(/-+$/u, "");
  const prefix = key.toLowerCase();
  return slug ? `${prefix}-${slug}` : prefix;
};
