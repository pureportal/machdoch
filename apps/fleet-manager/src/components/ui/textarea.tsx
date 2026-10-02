import type * as React from "react";
import { cn } from "@/lib/utils";

export function Textarea({
  className,
  ...props
}: React.ComponentProps<"textarea">): React.ReactElement {
  return (
    <textarea
      className={cn(
        "min-h-28 min-w-0 w-full resize-y rounded-xl border border-input bg-card px-3.5 py-3 text-base leading-relaxed transition-shadow outline-none placeholder:text-muted-foreground/80 focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-ring/15 disabled:bg-muted disabled:opacity-60 sm:text-sm",
        className,
      )}
      {...props}
    />
  );
}
