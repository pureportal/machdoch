import type { CloudCycle, IssueSnapshot } from "../../lib/cloud-contract";
import type { CycleBurnupPoint } from "../../lib/cloud-cycle-contract";

export interface IssueChange {
  issueId: string;
  revision: number;
  cycleId: string | null;
  state: string;
  points: number | null;
  archived: boolean;
  changedAt: Date;
}

function localDate(moment: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(moment);
}

function nextDate(date: string): string {
  const moment = new Date(`${date}T00:00:00Z`);
  moment.setUTCDate(moment.getUTCDate() + 1);
  return moment.toISOString().slice(0, 10);
}

function pointFromIssues(
  date: string,
  issues: { state: string; points: number | null }[],
): CycleBurnupPoint {
  const counted = issues.filter((issue) => issue.state !== "canceled");
  const completed = counted.filter((issue) => issue.state === "complete");
  const sum = (entries: typeof counted) =>
    entries.reduce((total, issue) => total + (issue.points ?? 0), 0);
  return {
    date,
    scope: sum(counted),
    completed: sum(completed),
    scopeIssues: counted.length,
    completedIssues: completed.length,
  };
}

export function cycleBurnup(
  cycle: CloudCycle & { closing_snapshot: IssueSnapshot[] | null },
  changes: IssueChange[],
  now: Date,
): CycleBurnupPoint[] {
  const today = localDate(now, cycle.timezone);
  const last = cycle.endsOn < today ? cycle.endsOn : today;
  if (cycle.startsOn > last) return [];
  const latest = new Map<string, IssueChange>();
  const ordered = [...changes].sort(
    (left, right) => left.changedAt.getTime() - right.changedAt.getTime(),
  );
  const points: CycleBurnupPoint[] = [];
  let cursor = 0;
  for (let date = cycle.startsOn; date <= last; date = nextDate(date)) {
    while (
      cursor < ordered.length &&
      localDate(ordered[cursor]!.changedAt, cycle.timezone) <= date
    ) {
      const change = ordered[cursor]!;
      latest.set(change.issueId, change);
      cursor += 1;
    }
    points.push(
      pointFromIssues(
        date,
        [...latest.values()].filter(
          (issue) => issue.cycleId === cycle.id && !issue.archived,
        ),
      ),
    );
  }
  if (cycle.closing_snapshot && points.length)
    points[points.length - 1] = pointFromIssues(
      points.at(-1)!.date,
      cycle.closing_snapshot.map((issue) => ({
        state: issue.state,
        points: issue.estimatePoints,
      })),
    );
  return points;
}
