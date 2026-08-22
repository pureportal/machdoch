import {
  CircleAlert,
  CircleCheck,
  Info,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, type JSX, type ReactNode } from "react";
import { cn } from "../../lib/utils";
import {
  resolveAppNotificationDismissMs,
  scheduleAppNotificationDismiss,
  type AppNotificationTone,
} from "./notification-lifecycle";

interface NotificationToneMeta {
  icon: LucideIcon;
  title: string;
  containerClassName: string;
  iconClassName: string;
}

const NOTIFICATION_TONE_META: Record<
  AppNotificationTone,
  NotificationToneMeta
> = {
  success: {
    icon: CircleCheck,
    title: "Done",
    containerClassName:
      "border-emerald-400/25 bg-emerald-950/90 text-emerald-100",
    iconClassName: "text-emerald-300",
  },
  warning: {
    icon: TriangleAlert,
    title: "Attention",
    containerClassName: "border-amber-400/25 bg-amber-950/90 text-amber-100",
    iconClassName: "text-amber-300",
  },
  error: {
    icon: CircleAlert,
    title: "Something went wrong",
    containerClassName: "border-rose-400/25 bg-rose-950/90 text-rose-100",
    iconClassName: "text-rose-300",
  },
  info: {
    icon: Info,
    title: "Notice",
    containerClassName: "border-sky-400/25 bg-sky-950/90 text-sky-100",
    iconClassName: "text-sky-300",
  },
};

export interface AppNotificationProps {
  tone: AppNotificationTone;
  children: ReactNode;
  title?: ReactNode;
  titleId?: string;
  presentation?: "inline" | "floating";
  dismissAfterMs?: number | null;
  dismissLabel?: string;
  onDismiss?: () => void;
  className?: string;
}

export const AppNotification = ({
  tone,
  children,
  title,
  titleId,
  presentation = "inline",
  dismissAfterMs,
  dismissLabel = "Dismiss notification",
  onDismiss,
  className,
}: AppNotificationProps): JSX.Element => {
  const meta = NOTIFICATION_TONE_META[tone];
  const Icon = meta.icon;
  const resolvedDismissAfterMs = onDismiss
    ? resolveAppNotificationDismissMs(tone, dismissAfterMs)
    : null;

  useEffect(() => {
    if (!onDismiss) {
      return;
    }

    return scheduleAppNotificationDismiss(onDismiss, resolvedDismissAfterMs);
  }, [children, onDismiss, resolvedDismissAfterMs, title, tone]);

  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      aria-live={tone === "error" ? "assertive" : "polite"}
      aria-atomic="true"
      aria-labelledby={titleId}
      data-tone={tone}
      data-presentation={presentation}
      data-dismiss-after-ms={resolvedDismissAfterMs ?? "persistent"}
      className={cn(
        "flex w-full items-start gap-3 rounded-xl border px-4 py-3",
        presentation === "floating" && "shadow-2xl backdrop-blur-xl",
        meta.containerClassName,
        className,
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn("mt-0.5 h-4 w-4 shrink-0", meta.iconClassName)}
      />
      <div className="min-w-0 flex-1">
        <div
          id={titleId}
          className="flex flex-wrap items-center gap-2 text-xs font-semibold leading-5"
        >
          {title ?? meta.title}
        </div>
        <div className="text-xs leading-5 text-current/80">{children}</div>
      </div>
      {onDismiss ? (
        <button
          type="button"
          aria-label={dismissLabel}
          className="-mr-1 -mt-1 inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-current/60 transition-colors hover:bg-white/10 hover:text-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current/40"
          onClick={onDismiss}
        >
          <X aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
};
