import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { SlidersHorizontal } from "lucide-react";
import "./composer-surface.css";

export interface ComposerSurfaceProps {
  modelPicker: ReactNode;
  workspacePicker?: ReactNode;
  controls: ReactNode;
  toolbarActions?: ReactNode;
  children: ReactNode;
  busy?: boolean;
  disabled?: boolean;
  className?: string;
}

export function ComposerSurface({
  modelPicker,
  workspacePicker,
  controls,
  toolbarActions,
  children,
  busy = false,
  disabled = false,
  className,
}: ComposerSurfaceProps): React.ReactElement {
  const optionsId = useId();
  const [optionsOpen, setOptionsOpen] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!optionsOpen) return undefined;
    const closeOnOutsidePress = (event: PointerEvent): void => {
      const target = event.target;
      if (
        target instanceof Element &&
        !toolbarRef.current?.contains(target) &&
        !target.closest("[data-radix-popper-content-wrapper], [role='dialog']")
      ) {
        setOptionsOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        setOptionsOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [optionsOpen]);

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
      <div ref={toolbarRef} className="m-composer-surface-toolbar app-composer-toolbar">
        <div className="m-composer-surface-model">{modelPicker}</div>
        {workspacePicker ? (
          <div className="m-composer-surface-workspace">{workspacePicker}</div>
        ) : null}
        <button
          type="button"
          className="m-composer-options-toggle"
          aria-label="Composer options"
          aria-expanded={optionsOpen}
          aria-controls={optionsId}
          onClick={() => setOptionsOpen((open) => !open)}
        >
          <SlidersHorizontal aria-hidden="true" />
        </button>
        <div id={optionsId} className="m-composer-surface-controls">
          {controls}
        </div>
        {toolbarActions ? (
          <div className="m-composer-surface-actions">{toolbarActions}</div>
        ) : null}
      </div>
      <div className="m-composer-surface-body app-composer-body">
        {children}
      </div>
    </div>
  );
}
