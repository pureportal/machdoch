import { ChevronRight } from "lucide-react";
import {
  createContext,
  useContext,
  useId,
  type JSX,
  type ReactNode,
} from "react";
import { Input } from "@machdoch/media-studio/tauri/ui/components/ui/input.js";
import { Textarea } from "@machdoch/media-studio/tauri/ui/components/ui/textarea.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";

export const RUN_INPUT_CLASS =
  "h-8 rounded-md border-slate-800 bg-slate-950 text-sm text-slate-100 placeholder:text-slate-600";
export const RUN_MONO_INPUT_CLASS = `${RUN_INPUT_CLASS} font-mono text-[13px]`;
export const RUN_TEXTAREA_CLASS =
  "min-h-20 rounded-md border-slate-800 bg-slate-950 font-mono text-[13px] leading-5 text-slate-100 placeholder:text-slate-600";
export const RUN_SELECT_CLASS =
  "h-8 w-full rounded-md border border-slate-800 bg-slate-950 px-2.5 text-sm text-slate-100 outline-none focus-visible:ring-2 focus-visible:ring-sky-500/50 disabled:opacity-60";

export interface RunFieldDraft {
  text: string;
  error: string | null;
}

export const RunFieldDraftContext = createContext<{
  values: Record<string, RunFieldDraft>;
  onChange: (key: string, draft: RunFieldDraft) => void;
} | null>(null);

export const RunField = ({
  label,
  error,
  className,
  children,
}: {
  label: string;
  error?: string | null;
  className?: string;
  children: ReactNode;
}): JSX.Element => (
  <label
    className={cn(
      "grid min-w-0 content-start gap-1.5 text-xs font-medium text-slate-300",
      className,
    )}
  >
    {label}
    {children}
    {error ? (
      <span role="alert" className="font-normal text-red-300">
        {error}
      </span>
    ) : null}
  </label>
);

export const RunSection = ({
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
    <section aria-labelledby={titleId} className="grid min-w-0 gap-3">
      <div className="flex min-h-7 items-center justify-between gap-2 border-b border-slate-800/70 pb-1.5">
        <h3 id={titleId} className="text-[13px] font-semibold text-slate-200">
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
};

export const RunCheckbox = ({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}): JSX.Element => (
  <label className="flex h-8 items-center gap-2 text-sm text-slate-200 has-[:disabled]:opacity-60">
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
      className="size-3.5 accent-sky-500"
    />
    {label}
  </label>
);

export function RunParsedField<T>({
  fieldKey,
  label,
  initialText,
  parse,
  onCommit,
  multiline = false,
  placeholder,
  disabled,
  className,
}: {
  fieldKey: string;
  label: string;
  initialText: string;
  parse: (text: string) => { value: T; error: string | null };
  onCommit: (value: T) => void;
  multiline?: boolean;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}): JSX.Element {
  const fields = useContext(RunFieldDraftContext);
  if (!fields) throw new Error("Run fields require an editor draft context.");
  const text = fields.values[fieldKey]?.text ?? initialText;
  const error = fields.values[fieldKey]?.error ?? null;
  const update = (next: string): void => {
    const result = parse(next);
    fields.onChange(fieldKey, { text: next, error: result.error });
    if (!result.error) onCommit(result.value);
  };
  const shared = {
    value: text,
    disabled,
    placeholder,
    spellCheck: false,
    "aria-invalid": error ? true : undefined,
  };
  return (
    <RunField label={label} error={error} className={className}>
      {multiline ? (
        <Textarea
          {...shared}
          onChange={(event) => update(event.target.value)}
          className={RUN_TEXTAREA_CLASS}
        />
      ) : (
        <Input
          {...shared}
          onChange={(event) => update(event.target.value)}
          className={RUN_MONO_INPUT_CLASS}
        />
      )}
    </RunField>
  );
}

export const RunNumberField = ({
  label,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}): JSX.Element => (
  <RunField label={label}>
    <Input
      type="number"
      min={min}
      max={max}
      value={value}
      disabled={disabled}
      onChange={(event) => {
        const next = Number(event.target.value);
        if (Number.isFinite(next)) {
          onChange(Math.min(max, Math.max(min, Math.trunc(next))));
        }
      }}
      className={RUN_INPUT_CLASS}
    />
  </RunField>
);

export const RunAdvancedDetails = ({
  children,
}: {
  children: ReactNode;
}): JSX.Element => (
  <details className="group">
    <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[13px] font-semibold text-slate-400 outline-none hover:text-slate-200 focus-visible:text-slate-100 [&::-webkit-details-marker]:hidden">
      <ChevronRight
        aria-hidden="true"
        className="size-3.5 transition-transform group-open:rotate-90"
      />
      Advanced
    </summary>
    <div className="mt-4 grid gap-6">{children}</div>
  </details>
);
