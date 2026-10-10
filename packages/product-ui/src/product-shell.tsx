import { ApplicationShell } from "./application-shell";
import {
  productCommandSchema,
  type ProductSnapshot,
} from "@machdoch/fleet-protocol";
import {
  ArrowLeft,
  LoaderCircle,
  MessageSquare,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  RefreshCw,
  TerminalSquare,
  WifiOff,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DropdownMenu } from "radix-ui";
import type { ComponentType } from "react";
import type { RemoteComposerProps } from "./remote-composer-props";
import type { RemoteConversationProps } from "./conversation";
import { Inspector } from "./inspector";
import type { ProductCommandHandler } from "./product-runtime";
import { ProductRail, type ProductView } from "./product-rail";
import { Ralph } from "./ralph";
import { SessionHeader } from "./session-header";
import { SessionSidebar } from "./session-sidebar";
import { ProductPanel } from "./product-panel";
import { useMediaQuery } from "./responsive-layout";
import { ProjectLibrary } from "./project-library";
import type { ComposerDraftStore } from "./use-composer-draft";
import type { SessionDataSource } from "./session-data";
import type { SessionSidebarCommandState } from "./session-sidebar-commands-state";

export function ProductShell({
  Composer,
  Conversation,
  SidebarCommands,
  initialView = "projects",
  instanceName,
  mediaHref,
  ralphHref,
  schedulerHref,
  instructionsHref,
  workspaceHref,
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
  sessionData,
}: {
  Composer: ComponentType<RemoteComposerProps>;
  Conversation: ComponentType<RemoteConversationProps>;
  SidebarCommands?: ComponentType<SessionSidebarCommandState> | undefined;
  initialView?: ProductView;
  instanceName: string;
  mediaHref?: string | undefined;
  ralphHref?: string | undefined;
  schedulerHref?: string | undefined;
  instructionsHref?: string | undefined;
  workspaceHref?: string | undefined;
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
  sessionData?: SessionDataSource | undefined;
}): React.ReactElement {
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsFrameRef = useRef<HTMLIFrameElement>(null);
  const [mediaOpened, setMediaOpened] = useState(false);
  const [ralphOpened, setRalphOpened] = useState(initialView === "ralph");
  const [schedulerOpened, setSchedulerOpened] = useState(
    initialView === "scheduler",
  );
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [instructionsOpened, setInstructionsOpened] = useState(
    initialView === "instructions",
  );
  const [requestedView, setRequestedView] = useState<ProductView>(initialView);
  const [workspaceOpened, setWorkspaceOpened] = useState(
    initialView === "workspaces",
  );
  const [pendingPoseChat, setPendingPoseChat] = useState<{
    previousSessionId: string | null;
    hasScene: boolean;
  } | null>(null);
  const mediaFrameRef = useRef<HTMLIFrameElement>(null);
  const [mediaRequest, setMediaRequest] = useState<{
    id: string;
    section: "library" | "generate";
    prompt?: string;
  } | null>(null);
  useEffect(() => {
    const receiveMedia = (event: MessageEvent): void => {
      if (
        event.origin !== window.location.origin ||
        event.source !== mediaFrameRef.current?.contentWindow
      )
        return;
      const data = event.data as { type?: unknown; id?: unknown } | null;
      if (data?.type === "machdoch:media-ready" && mediaRequest) {
        mediaFrameRef.current?.contentWindow?.postMessage(
          { type: "machdoch:media-compose", ...mediaRequest },
          window.location.origin,
        );
      } else if (
        data?.type === "machdoch:media-compose-received" &&
        data.id === mediaRequest?.id
      ) {
        setMediaRequest(null);
      }
    };
    window.addEventListener("message", receiveMedia);
    if (mediaRequest)
      mediaFrameRef.current?.contentWindow?.postMessage(
        { type: "machdoch:media-compose", ...mediaRequest },
        window.location.origin,
      );
    return () => window.removeEventListener("message", receiveMedia);
  }, [mediaRequest]);
  const instructionsFrameRef = useRef<HTMLIFrameElement>(null);
  const workspaceFrameRef = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const receiveSettings = (event: MessageEvent): void => {
      if (event.origin !== window.location.origin || !settingsHref) return;
      const data = event.data as { type?: unknown } | null;
      if (
        event.source === mediaFrameRef.current?.contentWindow &&
        data?.type === "machdoch:open-settings"
      ) {
        setSettingsOpen(true);
      } else if (
        event.source === settingsFrameRef.current?.contentWindow &&
        data?.type === "machdoch:close-settings"
      ) {
        setSettingsOpen(false);
      }
    };
    window.addEventListener("message", receiveSettings);
    return () => window.removeEventListener("message", receiveSettings);
  }, [settingsHref]);
  const compact = useMediaQuery("(max-width: 1100px)");
  useEffect(() => {
    setSessionsOpen(false);
  }, [compact]);
  const selectView = (view: ProductView): void => {
    setRequestedView(view);
    if (view === "media") setMediaOpened(true);
    if (view === "ralph") setRalphOpened(true);
    if (view === "scheduler") setSchedulerOpened(true);
    if (view === "instructions") setInstructionsOpened(true);
    if (view === "workspaces") setWorkspaceOpened(true);
    setSessionsOpen(false);
    setInspectorOpen(false);
  };

  const shell = snapshot?.shell;
  const commandsBlocked = error !== null || pendingCommands > 0;
  const activeSession = shell?.sessions.find(
    (session) => session.id === shell.activeSessionId,
  );
  const workspace = activeSession?.workspace ?? shell?.composer?.workspace;
  useEffect(() => {
    instructionsFrameRef.current?.contentWindow?.postMessage(
      { type: "machdoch:instruction-workspace", workspace: workspace ?? null },
      window.location.origin,
    );
  }, [workspace]);
  useEffect(() => {
    workspaceFrameRef.current?.contentWindow?.postMessage(
      {
        type: "machdoch:workspace-tools-workspace",
        workspace: workspace ?? null,
      },
      window.location.origin,
    );
  }, [workspace]);
  const activeView: ProductView =
    requestedView === "projects" && !shell?.projectLibrary
      ? "chat"
      : requestedView === "media" && !mediaHref
        ? "chat"
        : requestedView === "scheduler" && !schedulerHref
          ? "chat"
          : requestedView === "workspaces" && !workspaceHref
            ? "chat"
            : requestedView === "instructions" && !instructionsHref
              ? "chat"
              : requestedView === "ralph" && !shell?.ralph
                ? "chat"
                : requestedView;

  useEffect(() => {
    const receivePoseChat = (event: MessageEvent): void => {
      if (
        event.origin !== window.location.origin ||
        event.source !== mediaFrameRef.current?.contentWindow
      )
        return;
      const data = event.data as { type?: unknown; map?: unknown } | null;
      if (
        data?.type !== "machdoch:pose-chat" ||
        (data.map !== null &&
          (typeof data.map !== "object" || data.map === undefined))
      )
        return;
      const command = productCommandSchema.safeParse({
        kind: "create-session",
        specialKind: "pose",
        ...(data.map ? { poseScene: data.map } : {}),
      });
      if (!command.success || command.data.kind !== "create-session") return;
      const previousSessionId = snapshot?.shell?.activeSessionId ?? null;
      void onCommand(command.data).then((created) => {
        if (created)
          setPendingPoseChat({
            hasScene: data.map !== null,
            previousSessionId,
          });
      });
    };
    window.addEventListener("message", receivePoseChat);
    return () => window.removeEventListener("message", receivePoseChat);
  }, [onCommand, snapshot?.shell?.activeSessionId]);

  useEffect(() => {
    const sessionId = snapshot?.shell?.activeSessionId;
    if (
      !pendingPoseChat ||
      !sessionId ||
      sessionId === pendingPoseChat.previousSessionId
    )
      return;
    setPendingPoseChat(null);
    void (async () => {
      if (
        !(await onCommand({
          kind: "set-session-mode",
          sessionId,
          mode: "machdoch",
        }))
      )
        return;
      const prompt = pendingPoseChat.hasScene
        ? "Refine this pose scene"
        : "Create a pose scene";
      if (await onCommand({ kind: "update-draft", sessionId, prompt }))
        selectView("chat");
    })();
  }, [pendingPoseChat, snapshot?.shell?.activeSessionId, onCommand]);

  return (
    <ApplicationShell
      className="machdoch-product"
      topbar={
        <header className="m-product-topbar">
          <a
            href="/instances"
            className="m-product-back"
            aria-label="Instances"
          >
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
          <div className="m-product-topbar-actions">
            {!compact && servicesHref ? (
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
            {!compact ? (
              <button
                type="button"
                className="m-product-icon-button"
                aria-label="Refresh"
                onClick={() => void onRefresh()}
              >
                <RefreshCw aria-hidden="true" />
              </button>
            ) : null}
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
            {!compact && shell?.quickTask ? (
              <button
                type="button"
                className="m-product-icon-button"
                aria-label="Quick Chat"
                disabled={commandsBlocked}
                onClick={async () => {
                  if (await onCommand({ kind: "open-quick-chat" }))
                    selectView("chat");
                }}
              >
                <MessageSquare aria-hidden="true" />
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
            {compact ? (
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button
                    type="button"
                    className="m-product-icon-button"
                    aria-label="Device actions"
                  >
                    <MoreHorizontal aria-hidden="true" />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    className="m-navigation-menu"
                    align="end"
                    sideOffset={4}
                  >
                    <DropdownMenu.Item onSelect={() => void onRefresh()}>
                      <RefreshCw aria-hidden="true" />
                      Refresh
                    </DropdownMenu.Item>
                    {servicesHref ? (
                      <DropdownMenu.Item asChild>
                        <a href={servicesHref}>
                          <TerminalSquare aria-hidden="true" />
                          Services and previews
                        </a>
                      </DropdownMenu.Item>
                    ) : null}
                    {shell?.quickTask ? (
                      <DropdownMenu.Item
                        disabled={commandsBlocked}
                        onSelect={() => {
                          void onCommand({ kind: "open-quick-chat" }).then(
                            (accepted) => {
                              if (accepted) selectView("chat");
                            },
                          );
                        }}
                      >
                        <MessageSquare aria-hidden="true" />
                        Quick Chat
                      </DropdownMenu.Item>
                    ) : null}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            ) : null}
          </div>
        </header>
      }
      navigation={
        shell ? (
          <ProductRail
            settingsAvailable={Boolean(settingsHref)}
            onOpenSettings={() => setSettingsOpen(true)}
            inspectorOpen={inspectorOpen}
            activeView={activeView}
            mediaAvailable={Boolean(mediaHref)}
            schedulerAvailable={Boolean(schedulerHref)}
            instructionsAvailable={Boolean(instructionsHref)}
            workspaceAvailable={Boolean(workspaceHref)}
            ralphAvailable={shell.ralph !== undefined}
            projectsAvailable={shell.projectLibrary !== undefined}
            onSelectView={selectView}
            onToggleInspector={() => setInspectorOpen((current) => !current)}
          />
        ) : null
      }
      notices={
        <>
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
        </>
      }
    >
      {settingsHref && settingsOpen ? (
        <iframe
          ref={settingsFrameRef}
          src={settingsHref}
          title="Settings"
          className="m-product-settings-frame"
          allow="clipboard-read; clipboard-write"
        />
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
                    Commands={SidebarCommands}
                    activeSessionId={shell.activeSessionId}
                    dataSource={sessionData}
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
                  Commands={SidebarCommands}
                  activeSessionId={shell.activeSessionId}
                  dataSource={sessionData}
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
              <main
                className="m-product-main"
                data-pose-scene={
                  activeSession?.specialKind === "pose" &&
                  Boolean(shell.poseSceneSvg)
                }
              >
                {activeSession ? (
                  <>
                    <SessionHeader
                      key={activeSession.id}
                      session={activeSession}
                      pending={commandsBlocked}
                      onCommand={onCommand}
                    />
                    {activeSession.specialKind === "pose" &&
                    shell.poseSceneSvg ? (
                      <div className="m-product-pose-scene">
                        <img
                          alt="Current pose scene"
                          src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(shell.poseSceneSvg)}`}
                        />
                      </div>
                    ) : null}
                    <Conversation
                      historyAvailable={sessionData !== undefined}
                      messages={shell.visibleMessages}
                      session={activeSession}
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
                        voice={shell.voice}
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
                        onBrowseMediaAssets={
                          mediaHref
                            ? () => {
                                setMediaRequest({
                                  id: crypto.randomUUID(),
                                  section: "library",
                                });
                                selectView("media");
                              }
                            : undefined
                        }
                        onCreateMediaAsset={
                          mediaHref
                            ? (prompt) => {
                                setMediaRequest({
                                  id: crypto.randomUUID(),
                                  section: "generate",
                                  prompt,
                                });
                                selectView("media");
                              }
                            : undefined
                        }
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
          {mediaHref && mediaOpened ? (
            <main
              className="m-product-feature-main"
              hidden={activeView !== "media"}
              style={activeView !== "media" ? { display: "none" } : undefined}
            >
              <iframe
                ref={mediaFrameRef}
                src={mediaHref}
                title="Media Studio"
                className="m-product-media-frame"
                allow="clipboard-read; clipboard-write"
              />
            </main>
          ) : null}
          {instructionsHref && instructionsOpened ? (
            <main
              className="m-product-feature-main"
              hidden={activeView !== "instructions"}
              style={
                activeView !== "instructions" ? { display: "none" } : undefined
              }
            >
              <iframe
                ref={instructionsFrameRef}
                src={instructionsHref}
                onLoad={(event) =>
                  event.currentTarget.contentWindow?.postMessage(
                    {
                      type: "machdoch:instruction-workspace",
                      workspace: workspace ?? null,
                    },
                    window.location.origin,
                  )
                }
                title="Instructions"
                className="m-product-media-frame"
                allow="clipboard-read; clipboard-write"
              />
            </main>
          ) : null}
          {workspaceHref && workspaceOpened ? (
            <main
              className="m-product-feature-main"
              hidden={activeView !== "workspaces"}
              style={
                activeView !== "workspaces" ? { display: "none" } : undefined
              }
            >
              <iframe
                ref={workspaceFrameRef}
                src={workspaceHref}
                onLoad={(event) =>
                  event.currentTarget.contentWindow?.postMessage(
                    {
                      type: "machdoch:workspace-tools-workspace",
                      workspace: workspace ?? null,
                    },
                    window.location.origin,
                  )
                }
                title="Workspace Management"
                className="m-product-media-frame"
                allow="clipboard-read; clipboard-write"
              />
            </main>
          ) : null}
          {schedulerHref && schedulerOpened ? (
            <main
              className="m-product-feature-main"
              hidden={activeView !== "scheduler"}
              style={
                activeView !== "scheduler" ? { display: "none" } : undefined
              }
            >
              <iframe
                src={
                  workspace
                    ? `${schedulerHref}${schedulerHref.includes("?") ? "&" : "?"}workspace=${encodeURIComponent(workspace)}`
                    : schedulerHref
                }
                title="Smart Scheduler"
                className="m-product-media-frame"
              />
            </main>
          ) : null}
          {ralphHref && shell.ralph?.editorAvailable && ralphOpened ? (
            <main
              className="m-product-feature-main"
              hidden={activeView !== "ralph"}
              style={activeView !== "ralph" ? { display: "none" } : undefined}
            >
              <iframe
                src={ralphHref}
                title="RALPH"
                className="m-product-media-frame"
                allow="clipboard-read; clipboard-write"
              />
            </main>
          ) : null}
          {activeView === "ralph" &&
          shell.ralph &&
          !(ralphHref && shell.ralph.editorAvailable) ? (
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
    </ApplicationShell>
  );
}
