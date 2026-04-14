import * as React from "react"

import { cn } from "../../lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-md border border-oklch(0.92 0.004 286.32) bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none selection:bg-oklch(0.21 0.006 285.885) selection:text-oklch(0.985 0 0) file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-oklch(0.141 0.005 285.823) placeholder:text-oklch(0.552 0.016 285.938) disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-oklch(0.92 0.004 286.32)/30 dark:border-oklch(1 0 0 / 10%) dark:border-oklch(1 0 0 / 15%) dark:selection:bg-oklch(0.92 0.004 286.32) dark:selection:text-oklch(0.21 0.006 285.885) dark:file:text-oklch(0.985 0 0) dark:placeholder:text-oklch(0.705 0.015 286.067) dark:dark:bg-oklch(1 0 0 / 15%)/30",
        "focus-visible:border-oklch(0.705 0.015 286.067) focus-visible:ring-[3px] focus-visible:ring-oklch(0.705 0.015 286.067)/50 dark:focus-visible:border-oklch(0.552 0.016 285.938) dark:focus-visible:ring-oklch(0.552 0.016 285.938)/50",
        "aria-invalid:border-oklch(0.577 0.245 27.325) aria-invalid:ring-oklch(0.577 0.245 27.325)/20 dark:aria-invalid:ring-oklch(0.577 0.245 27.325)/40 dark:aria-invalid:border-oklch(0.704 0.191 22.216) dark:aria-invalid:ring-oklch(0.704 0.191 22.216)/20 dark:dark:aria-invalid:ring-oklch(0.704 0.191 22.216)/40",
        className
      )}
      {...props}
    />
  )
}

export { Input }
