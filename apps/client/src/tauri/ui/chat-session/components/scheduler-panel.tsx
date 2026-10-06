import { SchedulerPanel as SharedSchedulerPanel } from "@machdoch/client-ui/scheduler";
import {
  DialogContent,
  DialogTitle,
} from "@machdoch/media-studio/tauri/ui/components/ui/dialog.js";
import { schedulerRuntime } from "../../scheduler/scheduler-runtime";

const commandScope = { kind: "overlay" as const, ownerId: "scheduler" };

export const SchedulerPanel = ({
  workspaceRoot,
}: {
  workspaceRoot: string | null | undefined;
}): React.ReactElement => (
  <DialogContent
    className="app-scheduler-dialog h-[min(820px,calc(100dvh-28px))] w-[min(1180px,calc(100vw-28px))] max-w-none gap-0 overflow-hidden rounded-xl border-slate-800 bg-slate-950 p-0 text-slate-100 shadow-2xl sm:max-w-none"
    aria-describedby={undefined}
  >
    <DialogTitle className="sr-only">Smart Scheduler</DialogTitle>
    <SharedSchedulerPanel
      workspaceRoot={workspaceRoot}
      runtime={schedulerRuntime}
      commandScope={commandScope}
    />
  </DialogContent>
);
