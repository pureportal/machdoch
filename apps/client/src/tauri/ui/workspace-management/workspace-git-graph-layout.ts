import type { WorkspaceGitGraphCommit } from "../runtime";

export interface WorkspaceGitGraphLane {
  hash: string;
  color: number;
}

export interface WorkspaceGitGraphRow {
  commit: WorkspaceGitGraphCommit;
  lane: number;
  color: number;
  top: (WorkspaceGitGraphLane | null)[];
  bottom: (WorkspaceGitGraphLane | null)[];
  incoming: number[];
  outgoing: number[];
}

export interface WorkspaceGitGraphLayout {
  rows: WorkspaceGitGraphRow[];
  width: number;
}

const firstFreeLane = (lanes: readonly (WorkspaceGitGraphLane | null)[]) => {
  const free = lanes.indexOf(null);
  return free === -1 ? lanes.length : free;
};

const laneOf = (
  lanes: readonly (WorkspaceGitGraphLane | null)[],
  hash: string,
): number => lanes.findIndex((lane) => lane?.hash === hash);

const trimmed = (
  lanes: (WorkspaceGitGraphLane | null)[],
): (WorkspaceGitGraphLane | null)[] => {
  let end = lanes.length;
  while (end > 0 && lanes[end - 1] === null) end -= 1;
  return lanes.slice(0, end);
};

export const layoutWorkspaceGitGraph = (
  commits: readonly WorkspaceGitGraphCommit[],
  colorCount: number,
): WorkspaceGitGraphLayout => {
  const visible = new Set(commits.map((commit) => commit.hash));
  let lanes: (WorkspaceGitGraphLane | null)[] = [];
  let nextColor = 0;
  let width = 0;
  const claim = (hash: string): number => {
    const index = firstFreeLane(lanes);
    lanes[index] = { hash, color: nextColor++ % colorCount };
    return index;
  };
  const rows = commits.map((commit) => {
    const top = lanes.slice();
    let lane = laneOf(lanes, commit.hash);
    if (lane === -1) lane = claim(commit.hash);
    const color = lanes[lane]!.color;
    const incoming = top.flatMap((entry, index) =>
      entry?.hash === commit.hash ? [index] : [],
    );
    for (const index of incoming) lanes[index] = null;
    lanes[lane] = null;
    const outgoing: number[] = [];
    commit.parents
      .filter((parent) => visible.has(parent))
      .forEach((parent, position) => {
        if (position === 0) {
          lanes[lane] = { hash: parent, color };
          outgoing.push(lane);
          return;
        }
        const existing = laneOf(lanes, parent);
        outgoing.push(existing === -1 ? claim(parent) : existing);
      });
    lanes = trimmed(lanes);
    width = Math.max(width, top.length, lanes.length, lane + 1);
    return {
      commit,
      lane,
      color,
      top,
      bottom: lanes.slice(),
      incoming,
      outgoing,
    };
  });
  return { rows, width };
};
