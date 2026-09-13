import type { ProductSnapshot } from "@machdoch/fleet-protocol";
import {
  Aperture,
  FolderKanban,
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
import { useEffect, useState } from "react";
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
import { ProductPanel } from "./product-panel";
import { useMediaQuery, useProductViewport } from "./responsive-layout";
import { ProjectLibrary } from "./project-library";
import type { ComposerDraftStore } from "./use-composer-draft";

export function ProductShell({
  instanceName,
  servicesHref,
  settingsHref,
  snapshot,
  error,
  commandError,
  onDismissCommandError,
  pendingCommands,
  drafts,
  onCommand,
  onRefresh,
}: {
  instanceName: string;
  servicesHref?: string | undefined;
  settingsHref?: string | undefined;
  snapshot: ProductSnapshot | null;
  error: string | null;
  commandError?: string | null;
  onDismissCommandError?: () => void;
  pendingCommands: number;
  drafts: ComposerDraftStore;
  onCommand: ProductCommandHandler;
  onRefresh: () => Promise<void>;
}): React.ReactElement {
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [requestedView, setRequestedView] = useState<ProductView>("projects");
  const compact = useMediaQuery("(max-width: 900px)");
  const viewportRef = useProductViewport();
  useEffect(() => {
    setSessionsOpen(false);
  }, [compact]);
  const selectView = (view: ProductView): void => {
    setRequestedView(view);
    setSessionsOpen(false);
    setInspectorOpen(false);
  };

  const shell = snapshot?.shell;
  const commandsBlocked = error !== null || pendingCommands > 0;
  const activeSession = shell?.sessions.find(
    (session) => session.id === shell.activeSessionId,
  );
  const workspace = activeSession?.workspace ?? shell?.composer?.workspace;
  const activeView: ProductView =
    requestedView === "projects" && !shell?.projectLibrary
      ? "chat"
      : requestedView === "media" && !shell?.media
        ? "chat"
        : requestedView === "scheduler" && !shell?.scheduler
          ? "chat"
          : requestedView === "ralph" && !shell?.ralph
            ? "chat"
            : requestedView;

  return (
    <div ref={viewportRef} className="machdoch-product">
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
          <strong title={instanceName}>{instanceName}</strong>
          <span
            data-connected={snapshot !== null && error === null}
            role="status"
          >
            {error ? "Disconnected" : snapshot ? "Connected" : "Connecting"}
          </span>
        </div>
        {shell ? (
          <nav className="m-product-mobile-nav" aria-label="Product view">
            {shell.projectLibrary ? (
              <button
                type="button"
                data-active={activeView === "projects"}
                aria-label="Projects"
                aria-pressed={activeView === "projects"}
                onClick={() => selectView("projects")}
              >
                <FolderKanban aria-hidden="true" />
                <span>Projects</span>
              </button>
            ) : null}
            <button
              type="button"
              data-active={activeView === "chat"}
              aria-label="Chat"
              aria-pressed={activeView === "chat"}
              onClick={() => selectView("chat")}
            >
              <MessageSquareText aria-hidden="true" />
              <span>Chat</span>
            </button>
            {shell.media ? (
              <button
                type="button"
                data-active={activeView === "media"}
                aria-label="Media Studio"
                aria-pressed={activeView === "media"}
                onClick={() => selectView("media")}
              >
                <Aperture aria-hidden="true" />
                <span>Media</span>
              </button>
            ) : null}
            {shell.scheduler ? (
              <button
                type="button"
                data-active={activeView === "scheduler"}
                aria-label="Smart Scheduler"
                aria-pressed={activeView === "scheduler"}
                onClick={() => selectView("scheduler")}
              >
                <CalendarClock aria-hidden="true" />
                <span>Scheduler</span>
              </button>
            ) : null}
            {shell.ralph ? (
              <button
                type="button"
                data-active={activeView === "ralph"}
                aria-label="RALPH"
                aria-pressed={activeView === "ralph"}
                onClick={() => selectView("ralph")}
              >
                <Workflow aria-hidden="true" />
                <span>RALPH</span>
              </button>
            ) : null}
          </nav>
        ) : null}
        <div className="m-product-topbar-actions">
          {servicesHref ? (
            <a
              href={servicesHref}
              className="m-product-icon-button"
              aria-label="Services and previews"
              title="Services and previews"
            >
              <TerminalSquare aria-hidden="true" />
            </a>
          ) : null}
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
              aria-expanded={sessionsOpen}
              aria-haspopup="dialog"
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
              aria-expanded={inspectorOpen}
              aria-haspopup="dialog"
              onClick={() => setInspectorOpen((current) => !current)}
            >
              <PanelRight aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </header>
      {error && snapshot ? (
        <div className="m-product-connection-error" role="alert">
          <WifiOff aria-hidden="true" />
          <span>{error}</span>
          <button type="button" onClick={() => void onRefresh()}>
            Retry
          </button>
        </div>
      ) : null}
      {commandError ? (
        <div className="m-product-connection-error" role="alert">
          <span>{commandError}</span>
          <button type="button" onClick={onDismissCommandError}>
            Dismiss
          </button>
        </div>
      ) : null}
      {!snapshot ? (
        <main className="m-product-loading" role={error ? "alert" : "status"}>
          {error ? (
            <WifiOff aria-hidden="true" />
          ) : (
            <LoaderCircle className="m-product-spin" aria-hidden="true" />
          )}
          <span>{error ?? "Connecting"}</span>
          {error ? (
            <button type="button" onClick={() => void onRefresh()}>
              Retry
            </button>
          ) : null}
        </main>
      ) : shell ? (
        <div
          className="m-product-layout"
          data-inspector-open={inspectorOpen}
          data-sessions-open={sessionsOpen}
          data-view={activeView}
        >
          <ProductRail
            settingsHref={settingsHref}
            inspectorOpen={inspectorOpen}
            activeView={activeView}
            mediaAvailable={shell.media !== undefined}
            schedulerAvailable={shell.scheduler !== undefined}
            ralphAvailable={shell.ralph !== undefined}
            projectsAvailable={shell.projectLibrary !== undefined}
            onSelectView={selectView}
            onToggleInspector={() => setInspectorOpen((current) => !current)}
          />
          {activeView === "chat" ? (
            <>
              {compact ? (
                <ProductPanel
                  open={sessionsOpen}
                  onOpenChange={setSessionsOpen}
                  title="Sessions"
                  side="left"
                >
                  <SessionSidebar
                    activeSessionId={shell.activeSessionId}
                    sessions={shell.sessions}
                    workspace={workspace}
                    pending={commandsBlocked}
                    onCommand={async (command) => {
                      const accepted = await onCommand(command);
                      if (accepted) setSessionsOpen(false);
                      return accepted;
                    }}
                  />
                </ProductPanel>
              ) : (
                <SessionSidebar
                  activeSessionId={shell.activeSessionId}
                  sessions={shell.sessions}
                  workspace={workspace}
                  pending={commandsBlocked}
                  onCommand={async (command) => {
                    const accepted = await onCommand(command);
                    if (accepted) setSessionsOpen(false);
                    return accepted;
                  }}
                />
              )}
              <main className="m-product-main">
                {activeSession ? (
                  <>
                    <SessionHeader
                      key={activeSession.id}
                      session={activeSession}
                      pending={commandsBlocked}
                      onCommand={onCommand}
                    />
                    <Conversation
                      messages={shell.visibleMessages}
                      sessionId={activeSession.id}
                      pending={commandsBlocked}
                      onCommand={onCommand}
                    />
                    {shell.composer?.sessionId === activeSession.id ? (
                      <Composer
                        drafts={drafts}
                        composer={shell.composer}
                        session={activeSession}
                        contextPacks={shell.contextPacks}
                        workspaces={shell.workspaces}
                        webSearchAvailable={
                          shell.runtime?.webSearch?.available === true
                        }
                        canCancel={snapshot.sessions.some(
                          (task) =>
                            task.taskId === activeSession.runningTaskId &&
                            task.cancellable,
                        )}
                        pending={commandsBlocked}
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
          {activeView === "projects" && shell.projectLibrary ? (
            <main className="m-product-feature-main">
              <ProjectLibrary
                servicesHref={servicesHref}
                library={shell.projectLibrary}
                sessions={shell.sessions}
                pending={commandsBlocked}
                error={commandError ?? null}
                onCommand={onCommand}
                onOpenChat={() => selectView("chat")}
              />
            </main>
          ) : null}
          {activeView === "media" && shell.media ? (
            <main className="m-product-feature-main">
              <MediaStudio
                media={shell.media}
                pending={commandsBlocked}
                onCommand={onCommand}
              />
            </main>
          ) : null}
          {activeView === "scheduler" && shell.scheduler ? (
            <main className="m-product-feature-main">
              <Scheduler
                scheduler={shell.scheduler}
                pending={commandsBlocked}
                onCommand={onCommand}
              />
            </main>
          ) : null}
          {activeView === "ralph" && shell.ralph ? (
            <main className="m-product-feature-main">
              <Ralph
                ralph={shell.ralph}
                {...(shell.composer ? { composer: shell.composer } : {})}
                pending={commandsBlocked}
                onCommand={onCommand}
              />
            </main>
          ) : null}
          <ProductPanel
            open={inspectorOpen}
            onOpenChange={setInspectorOpen}
            title="Activity"
            side="right"
          >
            <Inspector
              snapshot={snapshot}
              shell={shell}
              activeSessionId={shell.activeSessionId}
              pending={commandsBlocked}
              onCommand={async (command) => {
                const accepted = await onCommand(command);
                if (
                  accepted &&
                  (command.kind === "create-session" ||
                    command.kind === "activate-session")
                )
                  selectView("chat");
                return accepted;
              }}
              onRefresh={onRefresh}
            />
          </ProductPanel>
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
