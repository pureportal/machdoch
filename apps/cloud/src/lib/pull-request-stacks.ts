import type { PullRequestState } from "./git-automation";

export interface StackCandidate {
  id: string;
  repositoryId: string;
  number: number;
  title: string;
  headRef: string;
  baseRef: string;
  state: PullRequestState;
  updatedAt: string;
}

export interface StackLink {
  id: string;
  number: number;
  title: string;
  headRef: string;
  baseRef: string;
  state: PullRequestState;
}

export interface PullRequestStack {
  parent: StackLink | null;
  children: StackLink[];
  depth: number;
  retargetTo: string | null;
}

function link(candidate: StackCandidate): StackLink {
  const { id, number, title, headRef, baseRef, state } = candidate;
  return { id, number, title, headRef, baseRef, state };
}

function parentOf(
  candidate: StackCandidate,
  all: readonly StackCandidate[],
): StackCandidate | null {
  const matches = all.filter(
    (other) =>
      other.id !== candidate.id &&
      other.repositoryId === candidate.repositoryId &&
      other.headRef === candidate.baseRef &&
      other.state !== "closed",
  );
  return (
    matches.find((other) => other.state === "open") ??
    matches.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    )[0] ??
    null
  );
}

export function pullRequestStacks(
  candidates: readonly StackCandidate[],
): Map<string, PullRequestStack> {
  const parents = new Map(
    candidates.map((candidate) => [
      candidate.id,
      candidate.state === "open" ? parentOf(candidate, candidates) : null,
    ]),
  );
  const stacks = new Map<string, PullRequestStack>();
  for (const candidate of candidates) {
    const parent = parents.get(candidate.id) ?? null;
    const children = candidates.filter(
      (other) => parents.get(other.id)?.id === candidate.id,
    );
    if (!parent && !children.length) continue;
    const seen = new Set([candidate.id]);
    let depth = 0;
    let current = parent;
    while (current && !seen.has(current.id) && current.state === "open") {
      seen.add(current.id);
      depth++;
      current = parents.get(current.id) ?? null;
    }
    stacks.set(candidate.id, {
      parent: parent && link(parent),
      children: children.map(link),
      depth,
      retargetTo: parent?.state === "merged" ? parent.baseRef : null,
    });
  }
  return stacks;
}
