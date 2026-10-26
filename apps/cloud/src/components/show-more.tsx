import { ChevronDown } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function ShowMore({
  children,
  className,
  onInvalidCapture,
  ...props
}: ComponentProps<"details">): React.ReactElement {
  return (
    <details
      className={cn("fleet-disclosure group min-w-0", className)}
      {...props}
      onInvalidCapture={(event) => {
        event.currentTarget.open = true;
        onInvalidCapture?.(event);
      }}
    >
      <summary className="flex min-h-11 w-fit cursor-pointer list-none items-center gap-2 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <span className="group-open:hidden">Show more</span>
        <span className="hidden group-open:inline">Show less</span>
        <ChevronDown
          className="size-4 transition-transform group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="grid min-w-0 gap-5 pt-3">{children}</div>
    </details>
  );
}
