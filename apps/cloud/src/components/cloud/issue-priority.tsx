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
}: {
  priority: CloudIssue["priority"];
}) {
  const Icon = icons[priority];
  return (
    <span className="cloud-priority" data-priority={priority}>
      <Icon size={14} aria-hidden="true" />
      <span>{priority === "none" ? "No priority" : priority}</span>
    </span>
  );
}
