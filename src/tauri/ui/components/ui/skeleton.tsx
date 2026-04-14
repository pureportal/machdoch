import { cn } from "../../lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-oklch(0.967 0.001 286.375) dark:bg-oklch(0.274 0.006 286.033)", className)}
      {...props}
    />
  )
}

export { Skeleton }
