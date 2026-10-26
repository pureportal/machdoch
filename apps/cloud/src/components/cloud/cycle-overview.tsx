import type { CSSProperties } from "react";
import { CircleCheck, Gauge } from "lucide-react";
import type { CycleDetail } from "@/lib/cloud-cycle-contract";

export function CycleOverview({ detail }: { detail: CycleDetail }) {
  const { cycle, totals, committedTotals, issues } = detail;
  const completed = totals.issues
    ? Math.round((totals.completed / totals.issues) * 100)
    : 0;
  const overCapacity =
    cycle.capacity !== null && totals.points > cycle.capacity;
  const statuses = new Map<string, { state: string; count: number }>();
  for (const issue of issues) {
    const name = detail.statusNames[issue.id]!;
    const current = statuses.get(name);
    statuses.set(name, {
      state: issue.state,
      count: (current?.count ?? 0) + 1,
    });
  }
  return (
    <div className="cloud-cycle-overview">
      <section className="cloud-cycle-completion" aria-label="Cycle progress">
        <h2>
          <CircleCheck size={16} aria-hidden="true" />
          Progress
        </h2>
        <div className="cloud-cycle-completion-body">
          <div
            className="cloud-progress-ring"
            style={{ "--progress": `${completed}%` } as CSSProperties}
            role="progressbar"
            aria-label="Completed issues"
            aria-valuenow={totals.completed}
            aria-valuemin={0}
            aria-valuemax={Math.max(1, totals.issues)}
            aria-valuetext={`${totals.completed} of ${totals.issues} issues completed`}
          >
            <span aria-hidden="true">
              <strong>{completed}%</strong>
              <span>complete</span>
            </span>
          </div>
          <dl className="cloud-cycle-metrics">
            <div>
              <dt>Completed issues</dt>
              <dd>
                {totals.completed}
                <span> / {totals.issues}</span>
              </dd>
            </div>
            <div>
              <dt>Completed points</dt>
              <dd>
                {totals.completedPoints}
                <span> / {totals.points}</span>
              </dd>
            </div>
          </dl>
        </div>
        {statuses.size > 0 && (
          <ul
            className="cloud-cycle-breakdown"
            aria-label="Issue status counts"
          >
            {[...statuses].map(([name, { state, count }]) => (
              <li key={name}>
                <span className="cloud-state" data-state={state}>
                  {name}
                </span>
                <strong>{count}</strong>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="cloud-cycle-workload" aria-label="Cycle workload">
        <h2>
          <Gauge size={16} aria-hidden="true" />
          Workload
        </h2>
        <dl className="cloud-cycle-metrics">
          <div>
            <dt>Planned points</dt>
            <dd>
              {totals.points}
              {cycle.capacity !== null && <span> / {cycle.capacity}</span>}
            </dd>
          </div>
        </dl>
        {cycle.capacity !== null && (
          <>
            <progress
              className="cloud-capacity-progress"
              aria-label="Capacity used"
              value={totals.points}
              max={Math.max(1, cycle.capacity, totals.points)}
              data-over-capacity={overCapacity}
              aria-valuetext={`${totals.points} planned points; ${cycle.capacity} points capacity`}
            />
            <p
              className="cloud-capacity-note"
              data-over-capacity={overCapacity}
            >
              {overCapacity
                ? `${Number((totals.points - cycle.capacity).toFixed(2))} points over capacity`
                : `${Number((cycle.capacity - totals.points).toFixed(2))} points available`}
            </p>
          </>
        )}
        <dl className="cloud-cycle-workload-details">
          {cycle.status !== "planned" && (
            <div>
              <dt>Committed points</dt>
              <dd>{committedTotals.points}</dd>
            </div>
          )}
          <div>
            <dt>Unestimated issues</dt>
            <dd>{totals.unestimated}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
