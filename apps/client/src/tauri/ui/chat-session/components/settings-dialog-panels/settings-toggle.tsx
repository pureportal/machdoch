import type { JSX } from "react";
import { cn } from "../../../lib/utils";

export const SettingsToggle = ({
  label,
  checked,
  disabled,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}): JSX.Element => (
  <button
    type="button"
    role="switch"
    aria-label={label}
    aria-checked={checked}
    disabled={disabled}
    onClick={() => onCheckedChange(!checked)}
    className="group inline-flex h-10 items-center rounded-lg px-1 outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:cursor-not-allowed disabled:opacity-40"
  >
    <span
      className={cn(
        "flex h-6 w-11 shrink-0 items-center rounded-full border border-slate-700 bg-slate-800 p-0.5 transition-colors",
        checked && "border-sky-500 bg-sky-500",
      )}
    >
      <span
        className={cn(
          "size-4.5 rounded-full bg-white shadow-sm transition-transform",
          checked && "translate-x-5",
        )}
      />
    </span>
  </button>
);
