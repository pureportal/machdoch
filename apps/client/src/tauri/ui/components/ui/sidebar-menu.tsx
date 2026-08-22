"use client";

import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import * as React from "react";

import { cn } from "../../lib/utils";
import { Skeleton } from "./skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";
import { useSidebar } from "./sidebar-provider";

const sidebarMenuButtonVariants = cva(
  "peer/menu-button flex w-full cursor-pointer items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm ring-oklch(0.705 0.015 286.067) outline-hidden transition-[width,height,padding] group-has-data-[sidebar=menu-action]/menu-item:pr-8 group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2! hover:bg-oklch(0.967 0.001 286.375) hover:text-oklch(0.21 0.006 285.885) focus-visible:ring-2 active:bg-oklch(0.967 0.001 286.375) active:text-oklch(0.21 0.006 285.885) disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[active=true]:bg-oklch(0.967 0.001 286.375) data-[active=true]:font-medium data-[active=true]:text-oklch(0.21 0.006 285.885) data-[state=open]:hover:bg-oklch(0.967 0.001 286.375) data-[state=open]:hover:text-oklch(0.21 0.006 285.885) [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0 dark:ring-oklch(0.552 0.016 285.938) dark:hover:bg-oklch(0.274 0.006 286.033) dark:hover:text-oklch(0.985 0 0) dark:active:bg-oklch(0.274 0.006 286.033) dark:active:text-oklch(0.985 0 0) dark:data-[active=true]:bg-oklch(0.274 0.006 286.033) dark:data-[active=true]:text-oklch(0.985 0 0) dark:data-[state=open]:hover:bg-oklch(0.274 0.006 286.033) dark:data-[state=open]:hover:text-oklch(0.985 0 0)",
  {
    variants: {
      variant: {
        default:
          "hover:bg-oklch(0.967 0.001 286.375) hover:text-oklch(0.21 0.006 285.885) dark:hover:bg-oklch(0.274 0.006 286.033) dark:hover:text-oklch(0.985 0 0)",
        outline:
          "bg-oklch(1 0 0) shadow-[0_0_0_1px_hsl(var(--sidebar-border))] hover:bg-oklch(0.967 0.001 286.375) hover:text-oklch(0.21 0.006 285.885) hover:shadow-[0_0_0_1px_hsl(var(--sidebar-accent))] dark:bg-oklch(0.141 0.005 285.823) dark:hover:bg-oklch(0.274 0.006 286.033) dark:hover:text-oklch(0.985 0 0)",
      },
      size: {
        default: "h-8 text-sm",
        sm: "h-7 text-xs",
        lg: "h-12 text-sm group-data-[collapsible=icon]:p-0!",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="sidebar-menu"
      data-sidebar="menu"
      className={cn("flex w-full min-w-0 flex-col gap-1", className)}
      {...props}
    />
  );
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="sidebar-menu-item"
      data-sidebar="menu-item"
      className={cn("group/menu-item relative", className)}
      {...props}
    />
  );
}

function SidebarMenuButton({
  asChild = false,
  isActive = false,
  variant = "default",
  size = "default",
  tooltip,
  className,
  ...props
}: React.ComponentProps<"button"> & {
  asChild?: boolean;
  isActive?: boolean;
  tooltip?: string | React.ComponentProps<typeof TooltipContent>;
} & VariantProps<typeof sidebarMenuButtonVariants>) {
  const Comp = asChild ? Slot.Root : "button";
  const { isMobile, state } = useSidebar();

  const button = (
    <Comp
      data-slot="sidebar-menu-button"
      data-sidebar="menu-button"
      data-size={size}
      data-active={isActive}
      className={cn(sidebarMenuButtonVariants({ variant, size }), className)}
      {...props}
    />
  );

  if (!tooltip) {
    return button;
  }

  if (typeof tooltip === "string") {
    tooltip = {
      children: tooltip,
    };
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent
        side="right"
        align="center"
        hidden={state !== "collapsed" || isMobile}
        {...tooltip}
      />
    </Tooltip>
  );
}

function SidebarMenuAction({
  className,
  asChild = false,
  showOnHover = false,
  ...props
}: React.ComponentProps<"button"> & {
  asChild?: boolean;
  showOnHover?: boolean;
}) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="sidebar-menu-action"
      data-sidebar="menu-action"
      className={cn(
        "absolute top-1.5 right-1 flex aspect-square w-5 cursor-pointer items-center justify-center rounded-md p-0 text-oklch(0.141 0.005 285.823) ring-oklch(0.705 0.015 286.067) outline-hidden transition-transform peer-hover/menu-button:text-oklch(0.21 0.006 285.885) hover:bg-oklch(0.967 0.001 286.375) hover:text-oklch(0.21 0.006 285.885) focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0 dark:text-oklch(0.985 0 0) dark:ring-oklch(0.552 0.016 285.938) dark:peer-hover/menu-button:text-oklch(0.985 0 0) dark:hover:bg-oklch(0.274 0.006 286.033) dark:hover:text-oklch(0.985 0 0)",
        "after:absolute after:-inset-2 md:after:hidden",
        "peer-data-[size=sm]/menu-button:top-1",
        "peer-data-[size=default]/menu-button:top-1.5",
        "peer-data-[size=lg]/menu-button:top-2.5",
        "group-data-[collapsible=icon]:hidden",
        showOnHover &&
          "group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 peer-data-[active=true]/menu-button:text-oklch(0.21 0.006 285.885) data-[state=open]:opacity-100 md:opacity-0 dark:peer-data-[active=true]/menu-button:text-oklch(0.985 0 0)",
        className,
      )}
      {...props}
    />
  );
}

function SidebarMenuBadge({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-menu-badge"
      data-sidebar="menu-badge"
      className={cn(
        "pointer-events-none absolute right-1 flex h-5 min-w-5 items-center justify-center rounded-md px-1 text-xs font-medium text-oklch(0.141 0.005 285.823) tabular-nums select-none dark:text-oklch(0.985 0 0)",
        "peer-hover/menu-button:text-oklch(0.21 0.006 285.885) peer-data-[active=true]/menu-button:text-oklch(0.21 0.006 285.885) dark:peer-hover/menu-button:text-oklch(0.985 0 0) dark:peer-data-[active=true]/menu-button:text-oklch(0.985 0 0)",
        "peer-data-[size=sm]/menu-button:top-1",
        "peer-data-[size=default]/menu-button:top-1.5",
        "peer-data-[size=lg]/menu-button:top-2.5",
        "group-data-[collapsible=icon]:hidden",
        className,
      )}
      {...props}
    />
  );
}

function SidebarMenuSkeleton({
  className,
  showIcon = false,
  ...props
}: React.ComponentProps<"div"> & {
  showIcon?: boolean;
}) {
  const width = React.useMemo(() => {
    return `${Math.floor(Math.random() * 40) + 50}%`;
  }, []);

  return (
    <div
      data-slot="sidebar-menu-skeleton"
      data-sidebar="menu-skeleton"
      className={cn("flex h-8 items-center gap-2 rounded-md px-2", className)}
      {...props}
    >
      {showIcon && (
        <Skeleton
          className="size-4 rounded-md"
          data-sidebar="menu-skeleton-icon"
        />
      )}
      <Skeleton
        className="h-4 max-w-(--skeleton-width) flex-1"
        data-sidebar="menu-skeleton-text"
        style={
          {
            "--skeleton-width": width,
          } as React.CSSProperties
        }
      />
    </div>
  );
}

function SidebarMenuSub({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="sidebar-menu-sub"
      data-sidebar="menu-sub"
      className={cn(
        "mx-3.5 flex min-w-0 translate-x-px flex-col gap-1 border-l border-oklch(0.92 0.004 286.32) px-2.5 py-0.5 dark:border-oklch(1 0 0 / 10%)",
        "group-data-[collapsible=icon]:hidden",
        className,
      )}
      {...props}
    />
  );
}

function SidebarMenuSubItem({
  className,
  ...props
}: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="sidebar-menu-sub-item"
      data-sidebar="menu-sub-item"
      className={cn("group/menu-sub-item relative", className)}
      {...props}
    />
  );
}

function SidebarMenuSubButton({
  asChild = false,
  size = "md",
  isActive = false,
  className,
  ...props
}: React.ComponentProps<"a"> & {
  asChild?: boolean;
  size?: "sm" | "md";
  isActive?: boolean;
}) {
  const Comp = asChild ? Slot.Root : "a";

  return (
    <Comp
      data-slot="sidebar-menu-sub-button"
      data-sidebar="menu-sub-button"
      data-size={size}
      data-active={isActive}
      className={cn(
        "flex h-7 min-w-0 cursor-pointer -translate-x-px items-center gap-2 overflow-hidden rounded-md px-2 text-oklch(0.141 0.005 285.823) ring-oklch(0.705 0.015 286.067) outline-hidden hover:bg-oklch(0.967 0.001 286.375) hover:text-oklch(0.21 0.006 285.885) focus-visible:ring-2 active:bg-oklch(0.967 0.001 286.375) active:text-oklch(0.21 0.006 285.885) disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-oklch(0.21 0.006 285.885) dark:text-oklch(0.985 0 0) dark:ring-oklch(0.552 0.016 285.938) dark:hover:bg-oklch(0.274 0.006 286.033) dark:hover:text-oklch(0.985 0 0) dark:active:bg-oklch(0.274 0.006 286.033) dark:active:text-oklch(0.985 0 0) dark:[&>svg]:text-oklch(0.985 0 0)",
        "data-[active=true]:bg-oklch(0.967 0.001 286.375) data-[active=true]:text-oklch(0.21 0.006 285.885) dark:data-[active=true]:bg-oklch(0.274 0.006 286.033) dark:data-[active=true]:text-oklch(0.985 0 0)",
        size === "sm" && "text-xs",
        size === "md" && "text-sm",
        "group-data-[collapsible=icon]:hidden",
        className,
      )}
      {...props}
    />
  );
}

export {
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
};
