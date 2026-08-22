import type { LucideIcon } from "lucide-react";
import type { ComponentProps, JSX, ReactNode } from "react";

import { cn } from "../../lib/utils";

type EmptyStateSize = "compact" | "default" | "large";
type EmptyStateTitleElement = "h2" | "h3" | "p";

const EMPTY_STATE_SIZE_CLASS: Record<EmptyStateSize, string> = {
  compact: "gap-2 px-4 py-5",
  default: "min-h-44 gap-3 px-6 py-8",
  large: "min-h-64 gap-4 px-6 py-12",
};

const EMPTY_STATE_ICON_CONTAINER_CLASS: Record<EmptyStateSize, string> = {
  compact: "size-8 rounded-lg",
  default: "size-10 rounded-xl",
  large: "size-12 rounded-2xl",
};

const EMPTY_STATE_ICON_CLASS: Record<EmptyStateSize, string> = {
  compact: "size-4",
  default: "size-5",
  large: "size-6",
};

const EMPTY_STATE_TITLE_CLASS: Record<EmptyStateSize, string> = {
  compact: "text-xs",
  default: "text-sm",
  large: "text-base",
};

export interface EmptyStateProps extends Omit<ComponentProps<"div">, "title"> {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  size?: EmptyStateSize;
  titleAs?: EmptyStateTitleElement;
}

export const EmptyState = ({
  icon: Icon,
  title,
  description,
  action,
  size = "default",
  titleAs: Title = "p",
  className,
  ...props
}: EmptyStateProps): JSX.Element => {
  return (
    <div
      data-slot="empty-state"
      data-size={size}
      className={cn(
        "flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-800 bg-slate-900/20 text-center",
        EMPTY_STATE_SIZE_CLASS[size],
        className,
      )}
      {...props}
    >
      {Icon ? (
        <span
          data-slot="empty-state-icon"
          className={cn(
            "flex shrink-0 items-center justify-center border border-slate-800 bg-slate-950/70 text-slate-500 shadow-sm",
            EMPTY_STATE_ICON_CONTAINER_CLASS[size],
          )}
        >
          <Icon aria-hidden="true" className={EMPTY_STATE_ICON_CLASS[size]} />
        </span>
      ) : null}
      <div className="grid max-w-md gap-1.5">
        <Title
          data-slot="empty-state-title"
          className={cn(
            "font-medium text-slate-200",
            EMPTY_STATE_TITLE_CLASS[size],
          )}
        >
          {title}
        </Title>
        {description ? (
          <p
            data-slot="empty-state-description"
            className="text-xs leading-5 text-slate-500"
          >
            {description}
          </p>
        ) : null}
      </div>
      {action ? (
        <div data-slot="empty-state-action" className="mt-1 flex">
          {action}
        </div>
      ) : null}
    </div>
  );
};
