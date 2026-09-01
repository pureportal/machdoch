import type { ProductSnapshot } from "@machdoch/fleet-protocol";
import {
  Aperture,
  ArrowLeft,
  CalendarClock,
  LoaderCircle,
  PanelLeft,
  PanelRight,
  RefreshCw,
  TerminalSquare,
  MessageSquareText,
  WifiOff,
  Workflow,
} from "lucide-react";
import { useState } from "react";
import { Composer } from "./composer";
import { Conversation } from "./conversation";
import { Inspector } from "./inspector";
import { MediaStudio } from "./media-studio";
import type { ProductCommandHandler } from "./product-runtime";
import { ProductRail, type ProductView } from "./product-rail";
import { Ralph } from "./ralph";
import { Scheduler } from "./scheduler";
import { SessionHeader } from "./session-header";
import { SessionSidebar } from "./session-sidebar";

export function ProductShell({
  instanceName,
  snapshot,
  error,
  pendingCommands,
  onCommand,
  onRefresh,
}: {
  instanceName: string;
  snapshot: ProductSnapshot | null;
  error: string | null;
  pendingCommands: number;
  onCommand: ProductCommandHandler;
  onRefresh: () => Promise<void>;
}): React.ReactElement {
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [requestedView, setRequestedView] = useState<ProductView>("chat");

  if (!snapshot) {
    return (
      <div className="machdoch-product m-product-loading">
        <LoaderCircle aria-hidden="true" />
        <span>{error ?? "Connecting"}</span>
        {error ? (
          <button type="button" onClick={() => void onRefresh()}>
            Retry
          </button>
        ) : null}
      </div>
    );
  }

  const shell = snapshot.shell;
  const activeSession = shell?.sessions.find(
    (session) => session.id === shell.activeSessionId,
  );
  const workspace = activeSession?.workspace ?? shell?.composer?.workspace;
  const activeView: ProductView =
    requestedView === "media" && !shell?.media
      ? "chat"
      : requestedView === "scheduler" && !shell?.scheduler
        ? "chat"
        : requestedView === "ralph" && !shell?.ralph
          ? "chat"
          : requestedView;

  return (
    <div className="machdoch-product">
      <header className="m-product-topbar">
        <a href="/instances" className="m-product-back" aria-label="Instances">
          <ArrowLeft aria-hidden="true" />
        </a>
        <div className="m-product-brand" aria-label="Machdoch">
          <TerminalSquare aria-hidden="true" />
          <span>Machdoch</span>
        </div>
        <div className="m-product-topbar-divider" />
        <div className="m-product-instance">
          <strong>{instanceName}</strong>
          <span data-connected={error === null}>
            {error ? "Disconnected" : "Connected"}
          </span>
        </div>
        {shell ? (
          <div className="m-product-mobile-nav" aria-label="Product view">
            <button
              type="button"
              data-active={activeView === "chat"}
              aria-label="Chat"
              onClick={() => setRequestedView("chat")}
            >
              <MessageSquareText aria-hidden="true" />
            </button>
            {shell.media ? (
              <button
                type="button"
                data-active={activeView === "media"}
                aria-label="Media Studio"
                onClick={() => setRequestedView("media")}
              >
                <Aperture aria-hidden="true" />
              </button>
            ) : null}
            {shell.scheduler ? (
              <button
                type="button"
                data-active={activeView === "scheduler"}
                aria-label="Smart Scheduler"
                onClick={() => setRequestedView("scheduler")}
              >
                <CalendarClock aria-hidden="true" />
              </button>
            ) : null}
            {shell.ralph ? (
              <button
                type="button"
                data-active={activeView === "ralph"}
                aria-label="RALPH"
                onClick={() => setRequestedView("ralph")}
              >
                <Workflow aria-hidden="true" />
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="m-product-topbar-actions">
          {pendingCommands > 0 ? (
            <LoaderCircle className="m-product-spin" aria-label="Updating" />
          ) : null}
          <button
            type="button"
            className="m-product-icon-button"
            aria-label="Refresh"
            onClick={() => void onRefresh()}
          >
            <RefreshCw aria-hidden="true" />
          </button>
          {shell && activeView === "chat" ? (
            <button
              type="button"
              className="m-product-icon-button m-product-sidebar-toggle"
              data-active={sessionsOpen}
              aria-label="Sessions"
              aria-pressed={sessionsOpen}
              onClick={() => setSessionsOpen((current) => !current)}
            >
              <PanelLeft aria-hidden="true" />
            </button>
          ) : null}
          {shell ? (
            <button
              type="button"
              className="m-product-icon-button m-product-inspector-toggle"
              data-active={inspectorOpen}
              aria-label="Activity"
              aria-pressed={inspectorOpen}
              onClick={() => setInspectorOpen((current) => !current)}
            >
              <PanelRight aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </header>
      {error ? (
        <div className="m-product-connection-error" role="alert">
          <WifiOff aria-hidden="true" />
          <span>{error}</span>
          <button type="button" onClick={() => void onRefresh()}>
            Retry
          </button>
        </div>
      ) : null}
      {shell ? (
        <div
          className="m-product-layout"
          data-inspector-open={inspectorOpen}
          data-sessions-open={sessionsOpen}
          data-view={activeView}
        >
          <ProductRail
            inspectorOpen={inspectorOpen}
            activeView={activeView}
            mediaAvailable={shell.media !== undefined}
            schedulerAvailable={shell.scheduler !== undefined}
            ralphAvailable={shell.ralph !== undefined}
            onSelectView={(view) => {
              setRequestedView(view);
              setSessionsOpen(false);
            }}
            onToggleInspector={() => setInspectorOpen((current) => !current)}
          />
          {activeView === "chat" ? (
            <>
              <SessionSidebar
                activeSessionId={shell.activeSessionId}
                sessions={shell.sessions}
                workspace={workspace}
                onCommand={async (command) => {
                  setSessionsOpen(false);
                  return onCommand(command);
                }}
              />
              {sessionsOpen ? (
                <button
                  type="button"
                  className="m-product-sidebar-scrim"
                  aria-label="Close sessions"
                  onClick={() => setSessionsOpen(false)}
                />
              ) : null}
              <main className="m-product-main">
                {activeSession ? (
                  <>
                    <SessionHeader
                      session={activeSession}
                      onCommand={onCommand}
                    />
                    <Conversation
                      messages={shell.visibleMessages}
                      sessionId={activeSession.id}
                      onCommand={onCommand}
                    />
                    {shell.composer?.sessionId === activeSession.id ? (
                      <Composer
                        composer={shell.composer}
                        session={activeSession}
                        contextPacks={shell.contextPacks}
                        workspaces={shell.workspaces}
                        webSearchAvailable={
                          shell.runtime?.webSearch?.available === true
                        }
                        pending={pendingCommands > 0}
                        onCommand={onCommand}
                      />
                    ) : null}
                  </>
                ) : (
                  <div className="m-product-empty">Select a session</div>
                )}
              </main>
            </>
          ) : null}
          {activeView === "media" && shell.media ? (
            <main className="m-product-feature-main">
              <MediaStudio
                media={shell.media}
                pending={pendingCommands > 0}
                onCommand={onCommand}
              />
            </main>
          ) : null}
          {activeView === "scheduler" && shell.scheduler ? (
            <main className="m-product-feature-main">
              <Scheduler
                scheduler={shell.scheduler}
                pending={pendingCommands > 0}
                onCommand={onCommand}
              />
            </main>
          ) : null}
          {activeView === "ralph" && shell.ralph ? (
            <main className="m-product-feature-main">
              <Ralph
                ralph={shell.ralph}
                {...(shell.composer ? { composer: shell.composer } : {})}
                pending={pendingCommands > 0}
                onCommand={onCommand}
              />
            </main>
          ) : null}
          {inspectorOpen ? (
            <button
              type="button"
              className="m-product-inspector-scrim"
              aria-label="Close activity"
              onClick={() => setInspectorOpen(false)}
            />
          ) : null}
          <Inspector
            snapshot={snapshot}
            shell={shell}
            activeSessionId={shell.activeSessionId}
            onCommand={onCommand}
          />
        </div>
      ) : (
        <div className="m-product-no-state">
          <p>Product state is not ready.</p>
          <button type="button" onClick={() => void onRefresh()}>
            Retry
          </button>
        </div>
      )}
    </div>
  );
}
