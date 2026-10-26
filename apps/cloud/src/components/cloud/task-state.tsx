import {
  CircleCheck,
  CircleDashed,
  CirclePause,
  CircleX,
  Clock3,
  LoaderCircle,
  ShieldCheck,
  Upload,
  type LucideIcon,
} from "lucide-react";
import type { RunState } from "@machdoch/fleet-protocol/cloud-execution";

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
