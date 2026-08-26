import * as React from "react";
import { Tooltip as TooltipPrimitive } from "radix-ui";

import { cn } from "../../lib/utils";

function TooltipProvider({
  delayDuration = 300,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  );
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className,
  sideOffset = 8,
  collisionPadding = 8,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          "app-tooltip-content z-50 w-fit max-w-[min(220px,calc(100vw-16px))] origin-(--radix-tooltip-content-transform-origin) whitespace-normal break-words rounded-[6px] border px-2 py-1.5 text-xs font-medium leading-4 tracking-[0] outline-none data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          className,
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow
          width={8}
          height={4}
          className="app-tooltip-arrow"
        />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

function ControlTooltip({
  content,
  children,
  ...props
}: Omit<React.ComponentProps<typeof TooltipContent>, "children" | "content"> & {
  content?: React.ReactNode;
  children: React.ReactElement;
}) {
  if (!content) {
    return children;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent {...props}>{content}</TooltipContent>
    </Tooltip>
  );
}

export {
  ControlTooltip,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
};
