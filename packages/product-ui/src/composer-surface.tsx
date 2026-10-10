import { useId, useState, type ReactNode } from "react";
import { SlidersHorizontal } from "lucide-react";
import "./composer-surface.css";

export interface ComposerSurfaceProps {
  modelPicker: ReactNode;
  controls: ReactNode;
  children: ReactNode;
  busy?: boolean;
  disabled?: boolean;
  className?: string;
}

export function ComposerSurface({
  modelPicker,
  controls,
  children,
  busy = false,
  disabled = false,
  className,
}: ComposerSurfaceProps): React.ReactElement {
  const optionsId = useId();
  const [optionsOpen, setOptionsOpen] = useState(false);
  return (
    <div
      className={["m-composer-surface", "app-agent-composer", className]
        .filter(Boolean)
        .join(" ")}
      data-variant="session"
      aria-busy={busy}
      aria-disabled={disabled}
      data-options-open={optionsOpen}
    >
      <div className="m-composer-surface-toolbar app-composer-toolbar">
        <div className="m-composer-surface-model">{modelPicker}</div>
        <button
          type="button"
          className="m-composer-options-toggle"
          aria-label="Composer options"
          aria-expanded={optionsOpen}
          aria-controls={optionsId}
          onClick={() => setOptionsOpen((open) => !open)}
        >
          <SlidersHorizontal aria-hidden="true" />
          <span>Options</span>
        </button>
        <div id={optionsId} className="m-composer-surface-controls">
          {controls}
        </div>
      </div>
      <div className="m-composer-surface-body app-composer-body">
        {children}
      </div>
    </div>
  );
}
