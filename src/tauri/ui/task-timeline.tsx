import type { ComponentProps, JSX } from "react";
import { Badge } from "./components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./components/ui/card";
import { cn } from "./lib/utils";
import type { TaskPanelTone } from "./task-panel.model";
import type { TaskTimelineItem } from "./task-timeline.model";

type BadgeVariant = NonNullable<ComponentProps<typeof Badge>["variant"]>;

const createBadgeToneClasses = (
  tone: TaskPanelTone,
): { variant: BadgeVariant; className?: string } => {
  switch (tone) {
    case "danger":
      return { variant: "destructive" };
    case "success":
      return {
        variant: "outline",
        className: "border-emerald-200 bg-emerald-100 text-emerald-800",
      };
    case "warning":
      return {
        variant: "outline",
        className: "border-amber-200 bg-amber-100 text-amber-800",
      };
    case "info":
      return {
        variant: "outline",
        className: "border-sky-200 bg-sky-100 text-sky-800",
      };
    default:
      return {
        variant: "secondary",
        className: "border-slate-200 bg-slate-100 text-slate-700",
      };
  }
};

const itemToneClasses: Record<TaskPanelTone, string> = {
  neutral: "border-slate-800 bg-slate-950/80",
  info: "border-sky-500/30 bg-sky-500/8",
  success: "border-emerald-500/30 bg-emerald-500/8",
  warning: "border-amber-500/30 bg-amber-500/8",
  danger: "border-rose-500/35 bg-rose-500/8",
};

const eventDotClasses: Record<TaskPanelTone, string> = {
  neutral: "bg-slate-500",
  info: "bg-sky-400",
  success: "bg-emerald-400",
  warning: "bg-amber-400",
  danger: "bg-rose-400",
};

export interface TaskTimelineProps {
  items: TaskTimelineItem[];
}

/**
 * Compact sidebar-oriented activity feed for staged task previews and their
 * latest execution state.
 */
export const TaskTimeline = ({ items }: TaskTimelineProps): JSX.Element => {
  if (items.length === 0) {
    return (
      <Card className="border-slate-800 bg-slate-950/80 text-slate-100 shadow-none">
        <CardHeader className="gap-2 px-4 py-4">
          <CardTitle className="text-sm font-semibold text-slate-100">
            No tasks yet
          </CardTitle>
          <CardDescription className="text-sm leading-6 text-slate-400">
            Launch a task from the composer to build a running preview and
            execution history here.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div aria-label="Task activity timeline" className="grid gap-3">
      {items.map((item) => {
        const statusBadge = createBadgeToneClasses(item.tone);

        return (
          <Card
            key={item.id}
            data-tone={item.tone}
            className={cn(
              "gap-4 rounded-2xl text-slate-100 shadow-none",
              itemToneClasses[item.tone],
            )}
          >
            <CardHeader className="gap-3 px-4 py-4 pb-0">
              <div className="flex items-start justify-between gap-3">
                <div className="grid gap-1">
                  <CardTitle className="text-sm leading-6 font-semibold text-slate-100">
                    {item.title}
                  </CardTitle>
                  <CardDescription className="text-sm leading-6 text-slate-400">
                    {item.summary}
                  </CardDescription>
                </div>
                <Badge
                  variant={statusBadge.variant}
                  className={cn("shrink-0", statusBadge.className)}
                >
                  {item.statusLabel}
                </Badge>
              </div>

              {(item.modeLabel || item.toolsLabel) && (
                <div className="flex flex-wrap gap-2">
                  {item.modeLabel ? (
                    <Badge variant="secondary" className="bg-slate-900 text-slate-300">
                      {item.modeLabel}
                    </Badge>
                  ) : null}
                  {item.toolsLabel ? (
                    <Badge variant="secondary" className="bg-slate-900 text-slate-300">
                      {item.toolsLabel}
                    </Badge>
                  ) : null}
                </div>
              )}
            </CardHeader>

            <CardContent className="px-4 pb-4">
              <ol className="m-0 grid gap-3 p-0 list-none">
                {item.events.map((event, index) => {
                  const isLastEvent = index === item.events.length - 1;

                  return (
                    <li key={event.id} className="grid grid-cols-[auto_1fr] gap-3">
                      <div className="flex min-h-full flex-col items-center">
                        <span
                          className={cn(
                            "mt-1 h-2.5 w-2.5 rounded-full",
                            eventDotClasses[event.tone],
                          )}
                        />
                        {!isLastEvent ? (
                          <span className="mt-1 min-h-6 w-px flex-1 bg-slate-800/80" />
                        ) : null}
                      </div>

                      <div className="pb-1">
                        <p className="m-0 text-[11px] font-semibold tracking-[0.18em] text-slate-500 uppercase">
                          {event.label}
                        </p>
                        <p className="mt-1 text-sm leading-6 text-slate-300">
                          {event.description}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
};
