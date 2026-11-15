import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CirclePause,
  CircleX,
  Clock3,
  GitMerge,
  GitPullRequest,
  LoaderCircle,
  ShieldCheck,
  Upload,
  type LucideIcon,
} from "lucide-react";
import type {
  CloudRun,
  RunState,
} from "@machdoch/fleet-protocol/cloud-execution";
import type { DeliveryState } from "@machdoch/fleet-protocol/cloud-delivery";

const icons: Record<RunState, LucideIcon> = {
  queued: CircleDashed,
  preparing: LoaderCircle,
  running: LoaderCircle,
  waiting: CirclePause,
  validating: ShieldCheck,
  publishing: Upload,
  cancel_requested: CirclePause,
  reconciling: CirclePause,
  succeeded: CircleCheck,
  failed: CircleX,
  canceled: CircleX,
  timed_out: Clock3,
};

export function TaskState({ state }: { state: RunState }) {
  const Icon = icons[state];
  return (
    <span className="cloud-task-state" data-state={state}>
      <Icon size={14} aria-hidden="true" />
      {state.replaceAll("_", " ")}
    </span>
  );
}

const deliveryLabels: Record<
  DeliveryState,
  { label: string; state: RunState; icon: LucideIcon }
> = {
  publishing: { label: "Opening PR", state: "publishing", icon: Upload },
  reported: { label: "Checked", state: "succeeded", icon: ShieldCheck },
  open: { label: "In review", state: "waiting", icon: GitPullRequest },
  merging: { label: "Merging", state: "publishing", icon: GitMerge },
  merged: { label: "Merged", state: "succeeded", icon: GitMerge },
  needs_person: { label: "Needs you", state: "waiting", icon: CircleAlert },
  closed: { label: "Closed", state: "canceled", icon: CircleX },
  failed: { label: "Publish failed", state: "failed", icon: CircleX },
};

export function TaskBadge({ run }: { run: CloudRun }) {
  if (!run.deliverySummary) return <TaskState state={run.state} />;
  const delivery = deliveryLabels[run.deliverySummary.state];
  const Icon = delivery.icon;
  return (
    <span className="cloud-task-state" data-state={delivery.state}>
      <Icon size={14} aria-hidden="true" />
      {delivery.label}
      {run.deliverySummary.pullRequestNumber
        ? ` · #${run.deliverySummary.pullRequestNumber}`
        : ""}
    </span>
  );
}
