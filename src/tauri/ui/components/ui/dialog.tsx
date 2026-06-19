import * as React from "react"
import { XIcon } from "lucide-react"
import { Dialog as DialogPrimitive } from "radix-ui"

import { cn } from "../../lib/utils"
import { Button } from "./button"

interface DialogInteractOutsideConfirmationOptions {
  title?: string
  description?: string
  cancelLabel?: string
  confirmLabel?: string
}

type DialogInteractOutsideConfirmation =
  | boolean
  | DialogInteractOutsideConfirmationOptions

type DialogContentProps =
  React.ComponentProps<typeof DialogPrimitive.Content> & {
    showCloseButton?: boolean
    confirmOnInteractOutside?: DialogInteractOutsideConfirmation
  }

const getDialogInteractOutsideConfirmationOptions = (
  value: DialogInteractOutsideConfirmation | undefined,
): DialogInteractOutsideConfirmationOptions | null => {
  if (!value) {
    return null
  }

  return {
    title: "Close dialog?",
    description: "This dialog has unsaved state.",
    cancelLabel: "Stay",
    confirmLabel: "Close",
    ...(typeof value === "object" ? value : {}),
  }
}

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  confirmOnInteractOutside,
  onInteractOutside,
  onPointerDownOutside,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...props
}: DialogContentProps) {
  const [showInteractOutsideConfirmation, setShowInteractOutsideConfirmation] =
    React.useState(false)
  const interactOutsideConfirmation =
    getDialogInteractOutsideConfirmationOptions(confirmOnInteractOutside)
  const confirmationTitleId = React.useId()
  const confirmationDescriptionId = React.useId()

  const requestInteractOutsideConfirmation = (
    event: Event,
  ): void => {
    if (!interactOutsideConfirmation || event.defaultPrevented) {
      return
    }

    event.preventDefault()
    setShowInteractOutsideConfirmation(true)
  }

  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border border-slate-200 bg-white p-6 text-slate-950 shadow-2xl duration-200 outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:max-w-lg dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100",
          className
        )}
        onOpenAutoFocus={(event) => {
          setShowInteractOutsideConfirmation(false)
          onOpenAutoFocus?.(event)
        }}
        onCloseAutoFocus={(event) => {
          setShowInteractOutsideConfirmation(false)
          onCloseAutoFocus?.(event)
        }}
        onInteractOutside={(event) => {
          onInteractOutside?.(event)
          requestInteractOutsideConfirmation(event)
        }}
        onPointerDownOutside={(event) => {
          onPointerDownOutside?.(event)
          requestInteractOutsideConfirmation(event)
        }}
        {...props}
      >
        {children}
        {showInteractOutsideConfirmation && interactOutsideConfirmation ? (
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={confirmationTitleId}
            aria-describedby={
              interactOutsideConfirmation.description
                ? confirmationDescriptionId
                : undefined
            }
            className="absolute inset-0 z-20 grid place-items-center bg-slate-950/70 px-4 backdrop-blur-sm"
          >
            <div className="grid w-full max-w-sm gap-4 rounded-lg border border-slate-200 bg-white p-4 text-slate-950 shadow-2xl shadow-black/20 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:shadow-black/45">
              <div className="grid gap-1.5">
                <div id={confirmationTitleId} className="text-sm font-semibold">
                  {interactOutsideConfirmation.title}
                </div>
                {interactOutsideConfirmation.description ? (
                  <div
                    id={confirmationDescriptionId}
                    className="text-sm leading-5 text-slate-600 dark:text-slate-300"
                  >
                    {interactOutsideConfirmation.description}
                  </div>
                ) : null}
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowInteractOutsideConfirmation(false)}
                  className="text-slate-600 hover:bg-slate-100 hover:text-slate-950 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white"
                >
                  {interactOutsideConfirmation.cancelLabel}
                </Button>
                <DialogPrimitive.Close asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="border-slate-300 bg-white text-slate-950 hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100 dark:hover:bg-slate-800"
                  >
                    {interactOutsideConfirmation.confirmLabel}
                  </Button>
                </DialogPrimitive.Close>
              </div>
            </div>
          </div>
        ) : null}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="absolute top-4 right-4 cursor-pointer rounded-md p-1 text-slate-500 opacity-80 ring-offset-white transition hover:bg-slate-100 hover:text-slate-950 hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-cyan-500/45 focus:ring-offset-2 disabled:pointer-events-none dark:text-slate-400 dark:ring-offset-slate-950 dark:hover:bg-slate-800 dark:hover:text-white [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg leading-none font-semibold", className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm text-oklch(0.552 0.016 285.938) dark:text-oklch(0.705 0.015 286.067)", className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
