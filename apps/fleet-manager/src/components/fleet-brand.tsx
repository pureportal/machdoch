import { cn } from "@/lib/utils";

export function FleetBrand({
  className,
}: {
  className?: string;
}): React.ReactElement {
  return (
    <div className={cn("flex min-w-0 items-center gap-3", className)}>
      <span className="fleet-mark grid size-11 shrink-0 place-items-center rounded-2xl">
        <svg
          viewBox="0 0 32 32"
          fill="none"
          className="size-7"
          aria-hidden="true"
        >
          <path
            d="M10 10h12v12H10zM16 5v5m0 12v5M5 16h5m12 0h5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d="m16 12 4 4-4 4-4-4 4-4Z" fill="currentColor" />
          <circle cx="16" cy="4" r="2" fill="currentColor" />
          <circle cx="16" cy="28" r="2" fill="currentColor" />
          <circle cx="4" cy="16" r="2" fill="currentColor" />
          <circle cx="28" cy="16" r="2" fill="currentColor" />
        </svg>
      </span>
      <span className="grid gap-0.5">
        <span className="fleet-wordmark text-[11px] font-medium tracking-[0.18em]">
          machdoch
        </span>
        <span className="text-sm font-semibold tracking-tight">
          Fleet Manager
        </span>
      </span>
    </div>
  );
}
