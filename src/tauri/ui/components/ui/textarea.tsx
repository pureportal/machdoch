import * as React from "react"

import { cn } from "@/tauri/ui/lib/utils"

const setRef = <T,>(ref: React.Ref<T> | undefined, value: T): void => {
  if (typeof ref === "function") {
    ref(value)
    return
  }

  if (ref) {
    ref.current = value
  }
}

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea">
>(({ className, onChange, rows = 1, ...props }, forwardedRef) => {
  const internalRef = React.useRef<HTMLTextAreaElement | null>(null)
  const lastMeasuredWidthRef = React.useRef<number | null>(null)
  const lastMeasuredHeightRef = React.useRef<number | null>(null)
  const resizeFrameRef = React.useRef<number | null>(null)

  const resizeToContent = React.useCallback((): void => {
    const node = internalRef.current

    if (!node) {
      return
    }

    node.style.height = "auto"
    const nextHeight = node.scrollHeight

    if (lastMeasuredHeightRef.current !== nextHeight) {
      lastMeasuredHeightRef.current = nextHeight
      node.style.height = `${nextHeight}px`
      return
    }

    node.style.height = `${nextHeight}px`
  }, [])

  const scheduleResizeToContent = React.useCallback((): void => {
    if (typeof window.requestAnimationFrame !== "function") {
      resizeToContent()
      return
    }

    if (resizeFrameRef.current !== null) {
      window.cancelAnimationFrame(resizeFrameRef.current)
    }

    resizeFrameRef.current = window.requestAnimationFrame(() => {
      resizeFrameRef.current = null
      resizeToContent()
    })
  }, [resizeToContent])

  const handleRef = React.useCallback(
    (node: HTMLTextAreaElement | null): void => {
      internalRef.current = node
      setRef(forwardedRef, node)
    },
    [forwardedRef],
  )

  const handleChange = React.useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>): void => {
      onChange?.(event)
      resizeToContent()
    },
    [onChange, resizeToContent],
  )

  React.useLayoutEffect(() => {
    resizeToContent()
  }, [props.value, resizeToContent])

  React.useLayoutEffect(() => {
    const node = internalRef.current

    if (!node || typeof ResizeObserver === "undefined") {
      return
    }

    lastMeasuredWidthRef.current = node.clientWidth

    const observer = new ResizeObserver((entries) => {
      const nextWidth = entries[0]?.contentRect.width ?? node.clientWidth

      if (nextWidth === lastMeasuredWidthRef.current) {
        return
      }

      lastMeasuredWidthRef.current = nextWidth
      resizeToContent()
    })

    observer.observe(node)

    return () => {
      observer.disconnect()
    }
  }, [resizeToContent])

  React.useEffect(() => {
    const handleWindowResize = (): void => {
      scheduleResizeToContent()
    }

    window.addEventListener("resize", handleWindowResize)

    return () => {
      window.removeEventListener("resize", handleWindowResize)
    }
  }, [scheduleResizeToContent])

  React.useEffect(() => {
    return () => {
      if (
        resizeFrameRef.current !== null &&
        typeof window.cancelAnimationFrame === "function"
      ) {
        window.cancelAnimationFrame(resizeFrameRef.current)
      }
    }
  }, [])

  return (
    <textarea
      {...props}
      ref={handleRef}
      rows={rows}
      data-slot="textarea"
      onChange={handleChange}
      className={cn(
        "flex min-h-16 w-full rounded-md border border-oklch(0.92 0.004 286.32) bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none placeholder:text-oklch(0.552 0.016 285.938) focus-visible:border-oklch(0.705 0.015 286.067) focus-visible:ring-[3px] focus-visible:ring-oklch(0.705 0.015 286.067)/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-oklch(0.577 0.245 27.325) aria-invalid:ring-oklch(0.577 0.245 27.325)/20 md:text-sm dark:bg-oklch(0.92 0.004 286.32)/30 dark:aria-invalid:ring-oklch(0.577 0.245 27.325)/40 dark:border-oklch(1 0 0 / 10%) dark:border-oklch(1 0 0 / 15%) dark:placeholder:text-oklch(0.705 0.015 286.067) dark:focus-visible:border-oklch(0.552 0.016 285.938) dark:focus-visible:ring-oklch(0.552 0.016 285.938)/50 dark:aria-invalid:border-oklch(0.704 0.191 22.216) dark:aria-invalid:ring-oklch(0.704 0.191 22.216)/20 dark:dark:bg-oklch(1 0 0 / 15%)/30 dark:dark:aria-invalid:ring-oklch(0.704 0.191 22.216)/40",
        className,
      )}
    />
  )
})

Textarea.displayName = "Textarea"

export { Textarea }
