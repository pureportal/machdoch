import {
  CalendarClock,
  Cog,
  MessageSquareText,
  RadioTower,
  Store,
  TerminalSquare,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { JSX } from "react";
import { Button } from "../components/ui/button";
import { Separator } from "../components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import type { MainAppId } from "../lib/shell-store";

declare const __MACHDOCH_VERSION__: string | undefined;

export type AppActivityState =
  | "idle"
  | "running"
  | "completed"
  | "running-and-completed";

interface AppRailProps {
  activeApp: MainAppId;
  chatActivity: AppActivityState;
  ralphActivity: AppActivityState;
  onSelectApp: (app: MainAppId) => void;
  onOpenScheduler: () => void;
  onOpenMissionControl: () => void;
  onOpenSettings: () => void;
}

interface AppRailButtonProps {
  label: string;
  active?: boolean;
  icon: LucideIcon;
  activity?: AppActivityState;
  onClick: () => void;
}

const appVersion =
  typeof __MACHDOCH_VERSION__ === "string" &&
  __MACHDOCH_VERSION__.trim().length > 0
    ? __MACHDOCH_VERSION__.trim()
    : "0.0.0";

const getActivityLabel = (activity: AppActivityState | undefined): string => {
  switch (activity) {
    case "running":
      return "running";
    case "completed":
      return "completed work";
    case "running-and-completed":
      return "running and has completed work";
    case "idle":
    case undefined:
      return "idle";
  }
};

const AppActivityIndicator = ({
  activity = "idle",
}: {
  activity?: AppActivityState;
}): JSX.Element | null => {
  if (activity === "idle") {
    return null;
  }

  const running = activity === "running" || activity === "running-and-completed";
  const completed =
    activity === "completed" || activity === "running-and-completed";

  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute right-2 top-2 h-2.5 w-2.5 rounded-full",
        running
          ? "border border-cyan-200/80 bg-cyan-400/25 shadow-[0_0_10px_rgba(34,211,238,0.35)]"
          : "bg-lime-400 shadow-[0_0_8px_rgba(122,154,97,0.32)]",
        running && "animate-pulse",
      )}
    >
      {completed && running ? (
        <span className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-lime-300" />
      ) : null}
    </span>
  );
};

const AppRailButton = ({
  label,
  active = false,
  icon: Icon,
  activity = "idle",
  onClick,
}: AppRailButtonProps): JSX.Element => {
  const ariaLabel =
    activity === "idle" ? label : `${label}, ${getActivityLabel(activity)}`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={ariaLabel}
          aria-current={active ? "page" : undefined}
          onClick={onClick}
          className={cn(
            "app-shell-rail-button relative h-12 w-12 rounded-2xl border border-transparent text-slate-400 hover:bg-slate-900 hover:text-slate-100",
            active &&
              "border-sky-500/20 bg-slate-900 text-slate-100 shadow-[0_0_18px_rgba(14,165,233,0.08)]",
          )}
        >
          <Icon
            className={cn(
              "h-5 w-5",
              active ? "text-sky-300" : "text-slate-400",
            )}
          />
          <AppActivityIndicator activity={activity} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">
        {activity === "idle"
          ? label
          : `${label}: ${getActivityLabel(activity)}`}
      </TooltipContent>
    </Tooltip>
  );
};

export const AppRail = ({
  activeApp,
  chatActivity,
  ralphActivity,
  onSelectApp,
  onOpenScheduler,
  onOpenMissionControl,
  onOpenSettings,
}: AppRailProps): JSX.Element => {
  return (
    <aside className="app-shell-rail z-10 flex w-20 shrink-0 flex-col items-center justify-between border-r border-slate-900 bg-slate-950 py-6">
      <div className="app-shell-rail-group flex flex-col items-center gap-4">
        <div className="app-shell-logo flex h-12 w-12 items-center justify-center rounded-2xl border border-slate-800 bg-slate-900 shadow-lg shadow-sky-500/10">
          <TerminalSquare className="h-6 w-6 text-sky-400" />
        </div>

        <Separator className="w-10 bg-slate-900" />

        <div className="flex flex-col items-center gap-2">
          <AppRailButton
            label="Chat"
            icon={MessageSquareText}
            active={activeApp === "chat"}
            activity={chatActivity}
            onClick={() => onSelectApp("chat")}
          />
          <AppRailButton
            label="Ralph"
            icon={Workflow}
            active={activeApp === "ralph"}
            activity={ralphActivity}
            onClick={() => onSelectApp("ralph")}
          />
          <AppRailButton
            label="Marketplace"
            icon={Store}
            active={activeApp === "marketplace"}
            onClick={() => onSelectApp("marketplace")}
          />
        </div>
      </div>

      <div className="app-shell-rail-group flex flex-col items-center gap-3">
        <AppRailButton
          label="Smart Scheduler"
          icon={CalendarClock}
          onClick={onOpenScheduler}
        />
        <AppRailButton
          label="Mission Control"
          icon={RadioTower}
          onClick={onOpenMissionControl}
        />
        <AppRailButton
          label="Settings"
          icon={Cog}
          onClick={onOpenSettings}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="mt-1 inline-flex h-5 min-w-12 items-center justify-center rounded-full border border-slate-900/80 bg-slate-950/40 px-1.5 text-[9px] font-medium leading-none text-slate-600 transition-colors hover:text-slate-500"
              title={`machdoch ${appVersion}`}
            >
              v{appVersion}
            </span>
          </TooltipTrigger>
          <TooltipContent side="right">machdoch {appVersion}</TooltipContent>
        </Tooltip>
      </div>
    </aside>
  );
};
