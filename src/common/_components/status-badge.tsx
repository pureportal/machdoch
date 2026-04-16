import type { ComponentProps, JSX, ReactNode } from "react";
import { Badge } from "../../tauri/ui/components/ui/badge";
import { cn } from "../../tauri/ui/lib/utils";

type BadgeVariant = NonNullable<ComponentProps<typeof Badge>["variant"]>;

export type StatusBadgeTone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "accent";

const STATUS_BADGE_STYLES: Record<
  StatusBadgeTone,
  { variant: BadgeVariant; className: string }
> = {
  neutral: {
    variant: "secondary",
    className: "border-slate-700 bg-slate-900 text-slate-300",
  },
  info: {
    variant: "outline",
    className: "border-sky-500/20 bg-sky-500/10 text-sky-200",
  },
  success: {
    variant: "outline",
    className: "border-emerald-500/20 bg-emerald-500/10 text-emerald-200",
  },
  warning: {
    variant: "outline",
    className: "border-amber-500/20 bg-amber-500/10 text-amber-200",
  },
  danger: {
    variant: "destructive",
    className: "",
  },
  accent: {
    variant: "outline",
    className: "border-violet-500/20 bg-violet-500/10 text-violet-200",
  },
};

export interface StatusBadgeProps
  extends Omit<ComponentProps<typeof Badge>, "variant"> {
  tone?: StatusBadgeTone;
  children: ReactNode;
  variant?: BadgeVariant;
}

export const StatusBadge = ({
  tone = "neutral",
  className,
  variant,
  children,
  ...props
}: StatusBadgeProps): JSX.Element => {
  const defaults = STATUS_BADGE_STYLES[tone];

  return (
    <Badge
      {...props}
      variant={variant ?? defaults.variant}
      className={cn(defaults.className, className)}
    >
      {children}
    </Badge>
  );
};