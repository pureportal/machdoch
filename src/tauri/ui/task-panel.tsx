import type { JSX } from "react";
import { StatusBadge } from "../../common/_components/status-badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "./components/ui/card";
import { Separator } from "./components/ui/separator";
import { cn } from "./lib/utils";
import {
  createTaskPanelModel,
  type TaskPanelSource,
  type TaskPanelTone,
} from "./task-panel.model";

const sectionToneClasses: Record<TaskPanelTone, string> = {
  neutral: "border-slate-800 bg-slate-950/80",
  info: "border-sky-500/20 bg-sky-500/8",
  success: "border-emerald-500/20 bg-emerald-500/8",
  warning: "border-amber-500/20 bg-amber-500/8",
  danger: "border-rose-500/20 bg-rose-500/8",
};

const sectionHeadingToneClasses: Record<TaskPanelTone, string> = {
  neutral: "text-slate-100",
  info: "text-sky-200",
  success: "text-emerald-200",
  warning: "text-amber-200",
  danger: "text-rose-200",
};

const createArticleClassName = (): string => {
  return "mx-auto w-full max-w-4xl rounded-[1.5rem] border border-slate-800 bg-linear-to-b from-slate-900 to-slate-950 text-slate-50 shadow-2xl shadow-black/30";
};

export interface TaskPanelProps {
  source: TaskPanelSource;
}

/**
 * Renders a future desktop-friendly task details panel for either a staged
 * preview or a deterministic execution result.
 */
export const TaskPanel = ({ source }: TaskPanelProps): JSX.Element => {
  const model = createTaskPanelModel(source);

  return (
    <article
      aria-label={`${model.kind} task panel`}
      data-kind={model.kind}
      className={createArticleClassName()}
    >
      <Card className="overflow-hidden border-transparent bg-transparent shadow-none">
        <CardHeader className="gap-4 p-6 sm:p-7">
          <div className="grid gap-2">
            <p className="m-0 text-xs font-semibold tracking-[0.18em] text-slate-500 uppercase">
              {model.kind === "preview" ? "Task preview" : "Task execution"}
            </p>
            <h2 className="m-0 text-[1.2rem] leading-tight font-semibold text-slate-50 sm:text-[1.45rem]">
              {model.title}
            </h2>
            <CardDescription className="m-0 max-w-3xl text-sm leading-6 text-slate-400">
              {model.summary}
            </CardDescription>
          </div>

          <ul
            aria-label="Task state badges"
            className="m-0 flex flex-wrap gap-2 p-0 list-none"
          >
            {model.badges.map((badge) => {
              return (
                <li key={`${badge.label}-${badge.tone}`}>
                  <StatusBadge data-tone={badge.tone} tone={badge.tone}>
                    {badge.label}
                  </StatusBadge>
                </li>
              );
            })}
          </ul>
        </CardHeader>

        <CardContent className="grid gap-4 p-6 pt-0 sm:p-7 sm:pt-0">
          {model.sections.map((section, index) => {
            const tone = section.tone ?? "neutral";
            const headingId = `task-panel-section-${section.id}`;

            return (
              <div key={section.id} className="grid gap-4">
                {index > 0 ? <Separator className="bg-slate-800/90" /> : null}
                <section aria-labelledby={headingId} data-tone={tone}>
                  <Card
                    className={cn(
                      "gap-4 py-4 shadow-none",
                      sectionToneClasses[tone],
                    )}
                  >
                    <CardHeader className="gap-2 p-4 pb-3">
                      <h3
                        id={headingId}
                        className={cn(
                          "m-0 text-sm font-semibold",
                          sectionHeadingToneClasses[tone],
                        )}
                      >
                        {section.title}
                      </h3>
                    </CardHeader>
                    <CardContent className="p-4 pt-0">
                      <ul className="m-0 grid gap-2 p-0 list-none">
                        {section.lines.map((line, lineIndex) => (
                          <li
                            key={`${section.id}-${lineIndex}`}
                            className="text-sm leading-6 text-slate-300 whitespace-pre-wrap wrap-break-word"
                          >
                            {line}
                          </li>
                        ))}
                      </ul>
                    </CardContent>
                  </Card>
                </section>
              </div>
            );
          })}
        </CardContent>
      </Card>
    </article>
  );
};
