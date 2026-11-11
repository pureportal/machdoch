import { AlertTriangle } from "lucide-react";
import { useId, type JSX, type ReactNode } from "react";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import type { ValidationIssue } from "./mcp-config-model";

export const MCP_INPUT_CLASS =
  "h-9 rounded-lg border-slate-800 bg-slate-950 font-mono text-sm text-slate-100 placeholder:text-slate-600";
export const MCP_TEXTAREA_CLASS =
  "min-h-24 rounded-lg border-slate-800 bg-slate-950 font-mono text-sm leading-6 text-slate-100 placeholder:text-slate-600";
export const MCP_TEXT_INPUT_CLASS =
  "h-9 rounded-lg border-slate-800 bg-slate-950 text-sm text-slate-100 placeholder:text-slate-600";
export const MCP_PROSE_TEXTAREA_CLASS =
  "min-h-20 rounded-lg border-slate-800 bg-slate-950 text-sm leading-6 text-slate-100 placeholder:text-slate-600";
export const MCP_SELECT_CLASS =
  "h-9 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 text-sm text-slate-100 outline-none transition focus:border-sky-500/40 focus:ring-2 focus:ring-sky-500/15 disabled:cursor-not-allowed disabled:opacity-60";
export const MCP_SECONDARY_BUTTON_CLASS =
  "h-9 rounded-lg border-slate-800 bg-slate-950 px-3 text-sm text-slate-200 shadow-none hover:border-slate-700 hover:bg-slate-900";

export const Field = ({
  label,
  detail,
  className,
  children,
}: {
  label: string;
  detail?: string;
  className?: string;
  children: JSX.Element;
}): JSX.Element => {
  return (
    <label
      className={cn(
        "grid min-w-0 content-start gap-1.5 text-xs font-medium text-slate-400",
        className,
      )}
    >
      <span className="text-slate-300">{label}</span>
      {children}
      {detail ? (
        <span aria-hidden="true" className="text-xs leading-5 text-slate-500">
          {detail}
        </span>
      ) : null}
    </label>
  );
};

export const ToggleField = ({
  label,
  detail,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  detail?: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}): JSX.Element => {
  const detailId = useId();

  return (
    <label className="flex min-h-9 items-start gap-3 rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-200 has-[:disabled]:opacity-60">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-describedby={detail ? detailId : undefined}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-4 shrink-0 rounded border-slate-700 bg-slate-950 accent-sky-400"
      />
      <span className="grid min-w-0 gap-0.5">
        <span className="font-medium">{label}</span>
        {detail ? (
          <span id={detailId} className="text-xs leading-5 text-slate-500">
            {detail}
          </span>
        ) : null}
      </span>
    </label>
  );
};

export const McpSection = ({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}): JSX.Element => {
  const titleId = useId();

  return (
    <section
      aria-labelledby={titleId}
      className="grid min-w-0 gap-4 rounded-xl border border-slate-800/80 bg-slate-900/40 p-4"
    >
      <div className="flex min-h-6 flex-wrap items-center justify-between gap-2">
        <h3 id={titleId} className="text-sm font-semibold text-slate-100">
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
};

export const IssueList = ({
  issues,
}: {
  issues: readonly ValidationIssue[];
}): JSX.Element | null => {
  if (issues.length === 0) {
    return null;
  }

  return (
    <ul className="grid gap-1.5 rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
      {issues.map((issue) => (
        <li key={`${issue.serverKey}-${issue.text}`} className="flex gap-2">
          <AlertTriangle
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-amber-300"
          />
          <span>{issue.text}</span>
        </li>
      ))}
    </ul>
  );
};
