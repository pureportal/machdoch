import type { JSX } from "react";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";

export const SettingsToggle = ({
  label,
  checked,
  disabled,
  size = "default",
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  size?: "default" | "sm";
  onCheckedChange: (checked: boolean) => void;
}): JSX.Element => (
  <button
    type="button"
    role="switch"
    aria-label={label}
    aria-checked={checked}
    disabled={disabled}
    onClick={() => onCheckedChange(!checked)}
    className={cn(
      "group inline-flex shrink-0 items-center rounded-lg px-1 outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:cursor-not-allowed disabled:opacity-40",
      size === "sm" ? "h-7" : "h-10",
    )}
  >
    <span
      className={cn(
        "flex shrink-0 items-center rounded-full border border-slate-700 bg-slate-800 p-0.5 transition-colors",
        size === "sm" ? "h-4.5 w-8" : "h-6 w-11",
        checked && "border-sky-500 bg-sky-500",
      )}
    >
      <span
        className={cn(
          "rounded-full bg-white shadow-sm transition-transform",
          size === "sm" ? "size-3.5" : "size-4.5",
          checked && (size === "sm" ? "translate-x-3" : "translate-x-5"),
        )}
      />
    </span>
  </button>
);
