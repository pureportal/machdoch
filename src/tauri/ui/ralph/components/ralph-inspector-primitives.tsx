import { ChevronDown } from "lucide-react";
import type { JSX, ReactNode } from "react";

import { cn } from "../../lib/utils";

interface RalphInspectorFieldProps {
  label: string;
  help?: string;
  className?: string;
  action?: ReactNode;
  children: ReactNode;
}

export const RalphInspectorField = ({
  label,
  help,
  className,
  action,
  children,
}: RalphInspectorFieldProps): JSX.Element => {
  return (
    <div className={cn("grid gap-1.5 text-sm text-slate-100", className)}>
      <span className="flex min-w-0 items-center justify-between gap-2">
        <span className="min-w-0 truncate font-semibold">{label}</span>
        {action ? <span className="shrink-0">{action}</span> : null}
      </span>
      {children}
      {help ? (
        <span className="text-xs leading-4 text-slate-400">{help}</span>
      ) : null}
    </div>
  );
};

interface RalphInspectorDetailsProps {
  title: string;
  help?: string;
  children: ReactNode;
}

export const RalphInspectorDetails = ({
  title,
  help,
  children,
}: RalphInspectorDetailsProps): JSX.Element => {
  return (
    <details className="group grid gap-2 rounded-lg bg-slate-900/35 px-3 py-2 ring-1 ring-slate-800/60">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-cyan-200 [&::-webkit-details-marker]:hidden">
        <span>{title}</span>
        <ChevronDown className="h-3.5 w-3.5 transition group-open:rotate-180" />
      </summary>
      <div className="mt-2 grid gap-2">
        {help ? (
          <p className="text-xs leading-4 text-slate-400">{help}</p>
        ) : null}
        {children}
      </div>
    </details>
  );
};
