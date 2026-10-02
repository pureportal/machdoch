import type * as React from "react";
import { cn } from "@/lib/utils";

export function Select({
  className,
  ...props
}: React.ComponentProps<"select">): React.ReactElement {
  return (
    <select
      className={cn(
        "h-11 min-w-0 w-full cursor-pointer rounded-xl border border-input bg-card px-3 text-base transition-shadow outline-none focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-ring/15 disabled:bg-muted disabled:opacity-60 sm:text-sm",
        className,
      )}
      {...props}
    />
  );
}
