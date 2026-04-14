import * as React from "react"

import { cn } from "@/tauri/ui/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-md border border-oklch(0.92 0.004 286.32) bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none placeholder:text-oklch(0.552 0.016 285.938) focus-visible:border-oklch(0.705 0.015 286.067) focus-visible:ring-[3px] focus-visible:ring-oklch(0.705 0.015 286.067)/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-oklch(0.577 0.245 27.325) aria-invalid:ring-oklch(0.577 0.245 27.325)/20 md:text-sm dark:bg-oklch(0.92 0.004 286.32)/30 dark:aria-invalid:ring-oklch(0.577 0.245 27.325)/40 dark:border-oklch(1 0 0 / 10%) dark:border-oklch(1 0 0 / 15%) dark:placeholder:text-oklch(0.705 0.015 286.067) dark:focus-visible:border-oklch(0.552 0.016 285.938) dark:focus-visible:ring-oklch(0.552 0.016 285.938)/50 dark:aria-invalid:border-oklch(0.704 0.191 22.216) dark:aria-invalid:ring-oklch(0.704 0.191 22.216)/20 dark:dark:bg-oklch(1 0 0 / 15%)/30 dark:dark:aria-invalid:ring-oklch(0.704 0.191 22.216)/40",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
