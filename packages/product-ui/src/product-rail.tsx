import {
  Aperture,
  CalendarClock,
  MessageSquareText,
  PanelRight,
  Settings2,
  TerminalSquare,
  Workflow,
} from "lucide-react";

export type ProductView = "chat" | "media" | "scheduler" | "ralph";

export function ProductRail({
  inspectorOpen,
  activeView,
  mediaAvailable,
  schedulerAvailable,
  ralphAvailable,
  onSelectView,
  onToggleInspector,
}: {
  inspectorOpen: boolean;
  activeView: ProductView;
  mediaAvailable: boolean;
  schedulerAvailable: boolean;
  ralphAvailable: boolean;
  onSelectView: (view: ProductView) => void;
  onToggleInspector: () => void;
}): React.ReactElement {
  return (
    <aside className="m-product-rail" aria-label="Product navigation">
      <div className="m-product-rail-group">
        <div className="m-product-rail-logo" aria-hidden="true">
          <TerminalSquare />
        </div>
        <div className="m-product-rail-separator" />
        <button
          type="button"
          className="m-product-rail-button"
          data-active={activeView === "chat"}
          aria-label="Chat"
          aria-current={activeView === "chat" ? "page" : undefined}
          onClick={() => onSelectView("chat")}
        >
          <MessageSquareText aria-hidden="true" />
        </button>
        {mediaAvailable ? (
          <button
            type="button"
            className="m-product-rail-button"
            data-active={activeView === "media"}
            aria-label="Media Studio"
            aria-current={activeView === "media" ? "page" : undefined}
            onClick={() => onSelectView("media")}
          >
            <Aperture aria-hidden="true" />
          </button>
        ) : null}
        {schedulerAvailable ? (
          <button
            type="button"
            className="m-product-rail-button"
            data-active={activeView === "scheduler"}
            aria-label="Smart Scheduler"
            aria-current={activeView === "scheduler" ? "page" : undefined}
            onClick={() => onSelectView("scheduler")}
          >
            <CalendarClock aria-hidden="true" />
          </button>
        ) : null}
        {ralphAvailable ? (
          <button
            type="button"
            className="m-product-rail-button"
            data-active={activeView === "ralph"}
            aria-label="RALPH"
            aria-current={activeView === "ralph" ? "page" : undefined}
            onClick={() => onSelectView("ralph")}
          >
            <Workflow aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <div className="m-product-rail-group">
        <button
          type="button"
          className="m-product-rail-button"
          data-active={inspectorOpen}
          aria-label="Activity"
          aria-pressed={inspectorOpen}
          onClick={onToggleInspector}
        >
          <PanelRight aria-hidden="true" />
        </button>
        <a
          href="/settings"
          className="m-product-rail-button"
          aria-label="Settings"
        >
          <Settings2 aria-hidden="true" />
        </a>
      </div>
    </aside>
  );
}
