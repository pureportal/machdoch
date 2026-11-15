import type { JSX, ReactNode } from "react";
import { ChevronDown } from "lucide-react";

export function ShowMore({ children }: { children: ReactNode }): JSX.Element {
  return (
    <details className="group">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-xs text-slate-400 outline-none hover:text-slate-200 focus-visible:ring-2 focus-visible:ring-sky-400 [&::-webkit-details-marker]:hidden">
        <span className="group-open:hidden">Show more</span>
        <span className="hidden group-open:inline">Show less</span>
        <ChevronDown
          className="size-3.5 transition-transform group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="mt-3 grid gap-3">{children}</div>
    </details>
  );
}
