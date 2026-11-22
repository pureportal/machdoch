import { cn } from "../../lib/utils";

export function ProgressBar({
  label,
  value,
  max,
  className,
}: {
  label: string;
  value: number | null;
  max: number;
  className?: string;
}) {
  const percent =
    value === null || max <= 0 ? null : Math.min(100, (value / max) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value ?? undefined}
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-slate-800", className)}
    >
      <div
        className={cn(
          "h-full rounded-full bg-sky-400 transition-[width] duration-300",
          percent === null && "w-1/3 animate-pulse",
        )}
        style={percent === null ? undefined : { width: `${percent}%` }}
      />
    </div>
  );
}
