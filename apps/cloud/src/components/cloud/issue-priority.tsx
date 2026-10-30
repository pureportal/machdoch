import { ArrowDown, ArrowUp, Equal, Minus, OctagonAlert } from "lucide-react";
import type { CloudIssue } from "@/lib/cloud-contract";

const icons = {
  urgent: OctagonAlert,
  high: ArrowUp,
  normal: Equal,
  low: ArrowDown,
  none: Minus,
};

export function IssuePriority({
  priority,
  compact = false,
}: {
  priority: CloudIssue["priority"];
  compact?: boolean;
}) {
  const Icon = icons[priority];
  const label = priority === "none" ? "No priority" : priority;
  return (
    <span
      className="cloud-priority"
      data-priority={priority}
      title={compact ? label : undefined}
    >
      <Icon size={14} aria-hidden="true" />
      <span className={compact ? "sr-only" : undefined}>{label}</span>
    </span>
  );
}
