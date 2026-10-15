import type { ComponentProps, ReactElement } from "react";
import "./loading-state.css";

export interface LoadingStateProps extends Omit<
  ComponentProps<"div">,
  "children"
> {
  label: string;
}

export function LoadingState({
  label,
  className,
  ...props
}: LoadingStateProps): ReactElement {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      {...props}
      className={["m-loading-state", className].filter(Boolean).join(" ")}
    >
      <span className="m-loading-state-indicator" aria-hidden="true">
        <svg viewBox="0 0 40 40" fill="none">
          <circle className="m-loading-state-track" cx="20" cy="20" r="16" />
          <circle className="m-loading-state-arc" cx="20" cy="20" r="16" />
        </svg>
      </span>
      <span className="m-loading-state-label">{label}</span>
    </div>
  );
}
