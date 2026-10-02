import type * as React from "react";
import { cn } from "@/lib/utils";

export function Card({
  className,
  ...props
}: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      className={cn(
        "min-w-0 rounded-2xl border border-border bg-card shadow-[0_2px_8px_-4px_rgb(15_35_35/0.08)]",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({
  className,
  ...props
}: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      className={cn("flex flex-col gap-1.5 p-5 sm:p-6", className)}
      {...props}
    />
  );
}

export function CardTitle({
  className,
  ...props
}: React.ComponentProps<"h2">): React.ReactElement {
  return <h2 className={cn("text-base font-semibold", className)} {...props} />;
}

export function CardContent({
  className,
  ...props
}: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div className={cn("p-5 pt-0 sm:p-6 sm:pt-0", className)} {...props} />
  );
}
