import type { WorkspaceGitBlameRange } from "@machdoch/fleet-protocol/workspace-contract";
import { commitAge } from "./workspace-git-branch-search";

export interface BlameLineLabel {
  text: string;
  title: string;
  uncommitted: boolean;
}

export const blameLabelsByLine = (
  ranges: readonly WorkspaceGitBlameRange[],
  now: number,
): Map<number, BlameLineLabel> => {
  const labels = new Map<number, BlameLineLabel>();
  for (const range of ranges) {
    const author = range.uncommitted ? "Not committed" : range.author;
    const age = range.uncommitted ? null : commitAge(range.authoredAt, now);
    labels.set(range.startLine, {
      text: [range.uncommitted ? "" : range.shortHash, author, age]
        .filter(Boolean)
        .join(" · "),
      title: range.uncommitted
        ? "Not committed"
        : `${range.shortHash} ${range.summary}\n${range.author}, ${range.authoredAt}`,
      uncommitted: range.uncommitted,
    });
  }
  return labels;
};
