import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "../../lib/utils"

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-oklch(0.92 0.004 286.32) border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:border-oklch(0.705 0.015 286.067) focus-visible:ring-[3px] focus-visible:ring-oklch(0.705 0.015 286.067)/50 aria-invalid:border-oklch(0.577 0.245 27.325) aria-invalid:ring-oklch(0.577 0.245 27.325)/20 dark:aria-invalid:ring-oklch(0.577 0.245 27.325)/40 [&>svg]:pointer-events-none [&>svg]:size-3 dark:border-oklch(1 0 0 / 10%) dark:focus-visible:border-oklch(0.552 0.016 285.938) dark:focus-visible:ring-oklch(0.552 0.016 285.938)/50 dark:aria-invalid:border-oklch(0.704 0.191 22.216) dark:aria-invalid:ring-oklch(0.704 0.191 22.216)/20 dark:dark:aria-invalid:ring-oklch(0.704 0.191 22.216)/40",
  {
    variants: {
      variant: {
        default: "bg-oklch(0.21 0.006 285.885) text-oklch(0.985 0 0) [a&]:hover:bg-oklch(0.21 0.006 285.885)/90 dark:bg-oklch(0.92 0.004 286.32) dark:text-oklch(0.21 0.006 285.885) dark:[a&]:hover:bg-oklch(0.92 0.004 286.32)/90",
        secondary:
          "bg-oklch(0.967 0.001 286.375) text-oklch(0.21 0.006 285.885) [a&]:hover:bg-oklch(0.967 0.001 286.375)/90 dark:bg-oklch(0.274 0.006 286.033) dark:text-oklch(0.985 0 0) dark:[a&]:hover:bg-oklch(0.274 0.006 286.033)/90",
        destructive:
          "bg-oklch(0.577 0.245 27.325) text-white focus-visible:ring-oklch(0.577 0.245 27.325)/20 dark:bg-oklch(0.577 0.245 27.325)/60 dark:focus-visible:ring-oklch(0.577 0.245 27.325)/40 [a&]:hover:bg-oklch(0.577 0.245 27.325)/90 dark:bg-oklch(0.704 0.191 22.216) dark:focus-visible:ring-oklch(0.704 0.191 22.216)/20 dark:dark:bg-oklch(0.704 0.191 22.216)/60 dark:dark:focus-visible:ring-oklch(0.704 0.191 22.216)/40 dark:[a&]:hover:bg-oklch(0.704 0.191 22.216)/90",
        outline:
          "border-oklch(0.92 0.004 286.32) text-oklch(0.141 0.005 285.823) [a&]:hover:bg-oklch(0.967 0.001 286.375) [a&]:hover:text-oklch(0.21 0.006 285.885) dark:border-oklch(1 0 0 / 10%) dark:text-oklch(0.985 0 0) dark:[a&]:hover:bg-oklch(0.274 0.006 286.033) dark:[a&]:hover:text-oklch(0.985 0 0)",
        ghost: "[a&]:hover:bg-oklch(0.967 0.001 286.375) [a&]:hover:text-oklch(0.21 0.006 285.885) dark:[a&]:hover:bg-oklch(0.274 0.006 286.033) dark:[a&]:hover:text-oklch(0.985 0 0)",
        link: "text-oklch(0.21 0.006 285.885) underline-offset-4 [a&]:hover:underline dark:text-oklch(0.92 0.004 286.32)",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
