import type * as React from "react";
import { cn } from "@/lib/utils";

export function Input({
  className,
  ...props
}: React.ComponentProps<"input">): React.ReactElement {
  return (
    <input
      className={cn(
        "h-11 min-w-0 w-full rounded-xl border border-input bg-card px-3.5 text-base transition-shadow outline-none placeholder:text-muted-foreground/80 focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-ring/15 disabled:bg-muted disabled:opacity-60 sm:text-sm",
        className,
      )}
      {...props}
    />
  );
}
