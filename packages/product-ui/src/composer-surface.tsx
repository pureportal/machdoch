import type { ReactNode } from "react";
import "./composer-surface.css";

export interface ComposerSurfaceProps {
  toolbar: ReactNode;
  children: ReactNode;
  busy?: boolean;
  disabled?: boolean;
  className?: string;
}

export function ComposerSurface({
  toolbar,
  children,
  busy = false,
  disabled = false,
  className,
}: ComposerSurfaceProps): React.ReactElement {
  return (
    <div
      className={["m-composer-surface", "app-agent-composer", className]
        .filter(Boolean)
        .join(" ")}
      data-variant="session"
      aria-busy={busy}
      aria-disabled={disabled}
    >
      <div className="m-composer-surface-toolbar app-composer-toolbar">
        {toolbar}
      </div>
      <div className="m-composer-surface-body app-composer-body">
        {children}
      </div>
    </div>
  );
}
