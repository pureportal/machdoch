import type { JSX, ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@machdoch/media-studio/tauri/ui/components/ui/dialog.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";

export interface CompactDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: string;
  className?: string;
  children: ReactNode;
}

/** A dense scrolling dialog for inspecting and editing a list next to the chat. */
export const CompactDialog = ({
  open,
  onOpenChange,
  title,
  description,
  className,
  children,
}: CompactDialogProps): JSX.Element => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        if (event.currentTarget instanceof HTMLElement) {
          event.currentTarget.focus();
        }
      }}
      className={cn(
        "flex max-h-[min(85dvh,48rem)] flex-col gap-0 overflow-hidden rounded-xl p-0 sm:max-w-3xl [&>[data-slot=dialog-close]]:top-2 [&>[data-slot=dialog-close]]:right-2",
        className,
      )}
    >
      <DialogTitle className="flex shrink-0 items-center gap-2 border-b border-slate-800 py-2.5 pr-10 pl-3.5 text-[0.8125rem] leading-5 font-semibold">
        {title}
      </DialogTitle>
      <DialogDescription className="sr-only">{description}</DialogDescription>
      <div className="min-h-0 flex-1 overflow-y-auto p-2.5 [scrollbar-width:thin]">
        {children}
      </div>
    </DialogContent>
  </Dialog>
);
