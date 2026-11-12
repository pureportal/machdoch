import type {
  CloudIssue,
  CloudIssueSummary,
  IssueSort,
} from "./cloud-contract";

export const issueSortLabels: Record<IssueSort, string> = {
  priority: "Priority",
  updated: "Last updated",
  created: "Created",
  due: "Due date",
  estimate: "Estimate",
  status: "Status",
  title: "Title",
  identifier: "ID",
};

const priorityRank: Record<CloudIssue["priority"], number | null> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
  none: null,
};
const stateRank: Record<CloudIssue["state"], number> = {
  triage: 0,
  backlog: 1,
  ready: 2,
  active: 3,
  review: 4,
  blocked: 5,
  complete: 6,
  canceled: 7,
};
const collator = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

const sortRules: Record<
  IssueSort,
  {
    value: (issue: CloudIssueSummary) => string | number | null;
    descending: boolean;
  }
> = {
  priority: {
    value: (issue) => priorityRank[issue.priority],
    descending: false,
  },
  updated: { value: (issue) => issue.updatedAt, descending: true },
  created: { value: (issue) => issue.createdAt, descending: true },
  due: { value: (issue) => issue.dueOn, descending: false },
  estimate: { value: (issue) => issue.estimatePoints, descending: true },
  status: { value: (issue) => stateRank[issue.state], descending: false },
  title: { value: (issue) => issue.title, descending: false },
  identifier: { value: (issue) => issue.identifier, descending: false },
};

function compareValues(left: string | number, right: string | number) {
  return typeof left === "number" && typeof right === "number"
    ? left - right
    : collator.compare(String(left), String(right));
}

export function sortIssues<T extends CloudIssueSummary>(
  issues: T[],
  sort: IssueSort,
  reversed = false,
): T[] {
  const rule = sortRules[sort];
  const direction = (rule.descending ? -1 : 1) * (reversed ? -1 : 1);
  return [...issues].sort((left, right) => {
    const leftValue = rule.value(left);
    const rightValue = rule.value(right);
    if (leftValue === null || rightValue === null) {
      if (leftValue !== rightValue) return leftValue === null ? 1 : -1;
    } else {
      const order = compareValues(leftValue, rightValue);
      if (order) return order * direction;
    }
    return (
      collator.compare(right.updatedAt, left.updatedAt) ||
      collator.compare(left.identifier, right.identifier)
    );
  });
}
