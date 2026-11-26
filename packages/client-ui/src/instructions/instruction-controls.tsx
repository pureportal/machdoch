import type { JSX } from "react";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";

export const InstructionSwitch = ({
  label,
  checked,
  disabled,
  tooltip,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  tooltip?: string;
  onCheckedChange: (checked: boolean) => void;
}): JSX.Element => (
  <button
    type="button"
    role="switch"
    aria-label={label}
    aria-checked={checked}
    disabled={disabled}
    title={tooltip}
    onClick={(event) => {
      event.stopPropagation();
      onCheckedChange(!checked);
    }}
    className="inline-flex h-7 shrink-0 items-center rounded-md px-1 outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60 disabled:cursor-not-allowed disabled:opacity-40"
  >
    <span
      className={cn(
        "flex h-4.5 w-8 items-center rounded-full border border-slate-700 bg-slate-800 p-0.5 transition-colors",
        checked && "border-sky-500 bg-sky-500",
      )}
    >
      <span
        className={cn(
          "size-3.5 rounded-full bg-white shadow-sm transition-transform",
          checked && "translate-x-3",
        )}
      />
    </span>
  </button>
);

export const SegmentedControl = <Value extends string>({
  label,
  value,
  options,
  disabled,
  className,
  onChange,
}: {
  label: string;
  value: Value;
  options: readonly { value: Value; label: string; title?: string }[];
  disabled?: boolean;
  className?: string;
  onChange: (value: Value) => void;
}): JSX.Element => (
  <div
    role="group"
    aria-label={label}
    className={cn(
      "inline-flex shrink-0 rounded-lg border border-slate-800 bg-slate-950 p-0.5",
      className,
    )}
  >
    {options.map((option) => (
      <button
        key={option.value}
        type="button"
        aria-pressed={value === option.value}
        title={option.title}
        disabled={disabled}
        onClick={() => onChange(option.value)}
        className={cn(
          "h-7 flex-1 rounded-md px-2.5 text-xs whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sky-500/60 disabled:cursor-not-allowed disabled:opacity-50",
          value === option.value
            ? "bg-slate-800 text-slate-100"
            : "text-slate-400 hover:text-slate-200",
        )}
      >
        {option.label}
      </button>
    ))}
  </div>
);
