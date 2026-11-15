import {
  Check,
  CircleDashed,
  CircleSlash,
  LoaderCircle,
  X,
  type LucideIcon,
} from "lucide-react";
import type { RunDetail } from "@machdoch/fleet-protocol/cloud-execution";
import { taskStages, type StageStatus } from "@/lib/task-progress";

const icons: Record<StageStatus, LucideIcon> = {
  done: Check,
  current: LoaderCircle,
  failed: X,
  waiting: CircleDashed,
  skipped: CircleSlash,
};

const statusLabels: Record<StageStatus, string> = {
  done: "done",
  current: "in progress",
  failed: "needs attention",
  waiting: "not started",
  skipped: "skipped",
};

export function TaskStages({ run }: { run: RunDetail }) {
  return (
    <ol className="cloud-task-stages" aria-label="Progress">
      {taskStages(run).map((stage) => {
        const Icon = icons[stage.status];
        return (
          <li
            key={stage.id}
            data-status={stage.status}
            aria-current={stage.status === "current" ? "step" : undefined}
          >
            <span className="cloud-task-stage-icon">
              <Icon size={14} aria-hidden="true" />
            </span>
            <span className="cloud-task-stage-label">
              {stage.label}
              <span className="sr-only">, {statusLabels[stage.status]}</span>
            </span>
            {stage.detail && (
              <span className="cloud-task-stage-detail">{stage.detail}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
