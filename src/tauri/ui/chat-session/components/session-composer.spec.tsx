import { render, within } from "@testing-library/react";
import type { ChatSessionRecord } from "../../chat-session.model";
import { TooltipProvider } from "../../components/ui/tooltip";
import { RUN_MODE_META } from "../_helpers/session-shell";
import { SessionComposer } from "./session-composer";

vi.mock("../../runtime", () => ({
  listRalphFlows: vi.fn(),
  loadProviderModelCatalog: vi.fn().mockResolvedValue({
    generatedAt: 1,
    providers: [],
  }),
  showRalphFlow: vi.fn(),
}));

const createSession = (
  overrides: Partial<ChatSessionRecord> = {},
): ChatSessionRecord => ({
  id: "session-1",
  createdAt: 1,
  updatedAt: 2,
  workspace: "C:\\Project",
  provider: "openai",
  model: "gpt-5.5",
  mode: "machdoch",
  reasoning: "default",
  draft: "",
  draftContextAttachments: [],
  tags: [],
  messages: [],
  promptHistory: [],
  promptContextHistory: [],
  sessionMemoryEnabled: true,
  useGlobalMemory: true,
  uiControlEnabled: true,
  sessionMemory: [],
  ...overrides,
});

const renderSessionComposer = (
  activeSession: ChatSessionRecord = createSession(),
): void => {
  render(
    <TooltipProvider>
      <SessionComposer
        activeSession={activeSession}
        chooserProviders={["openai"]}
        activeRunMode="machdoch"
        activeRunModeMeta={RUN_MODE_META.machdoch}
        defaultRunMode="machdoch"
        defaultReasoning="default"
        activeReasoning="default"
        isUsingWorkspaceDefaultMode
        isUsingWorkspaceDefaultReasoning
        hasActiveWorkspace
        workspaceLocked={false}
        recentWorkspaces={[]}
        composerWorkspaceLabel="Project"
        sessionMemoryDescription="Session memory is enabled."
        globalMemoryDescription="Global memory is enabled."
        uiControlDescription="UI control is enabled."
        interviewDescription="Interview before starting a task."
        isGlobalMemoryAvailable
        isGlobalMemoryActive
        isUiControlAvailable
        interviewEnabled={false}
        interviewDisabled={false}
        contextAttachments={[]}
        contextPacks={[]}
        matchedContextPackIds={[]}
        imageInputSupported
        imageInputDisabledReason={null}
        speechInput={{
          browserSupported: true,
          enabled: true,
          recording: false,
          transcribing: false,
          statusText: null,
          statusTone: null,
          onAction: vi.fn(),
        }}
        canSendMessage={false}
        sendDisabledReason={null}
        runningTaskMessageAction="queue"
        queuedMessages={[]}
        onSelectFolder={vi.fn().mockResolvedValue(undefined)}
        onWorkspaceSelection={vi.fn()}
        onWorkspaceRemoval={vi.fn()}
        onSessionModelSelection={vi.fn()}
        onSessionModeSelection={vi.fn()}
        onSessionReasoningSelection={vi.fn()}
        onSessionMemoryEnabledChange={vi.fn()}
        onUseGlobalMemoryChange={vi.fn()}
        onUiControlEnabledChange={vi.fn()}
        onInterviewEnabledChange={vi.fn()}
        onSelectContextFiles={vi.fn().mockResolvedValue(undefined)}
        onSelectContextFolders={vi.fn().mockResolvedValue(undefined)}
        onSelectContextImages={vi.fn().mockResolvedValue(undefined)}
        onPasteContextImages={vi.fn().mockResolvedValue(undefined)}
        onOpenContextAttachment={vi.fn()}
        onRemoveContextAttachment={vi.fn()}
        onClearContextAttachments={vi.fn()}
        onSaveContextPack={vi.fn()}
        onApplyContextPack={vi.fn()}
        onDeleteContextPack={vi.fn()}
        onExportContextPacks={vi.fn()}
        onImportContextPacks={vi.fn()}
        onDraftChange={vi.fn()}
        onComposerHistoryNavigation={vi.fn()}
        onRunningTaskMessageActionChange={vi.fn()}
        onQueuedMessageChange={vi.fn()}
        onQueuedMessageMove={vi.fn()}
        onQueuedMessageReorder={vi.fn()}
        onQueuedMessageRemove={vi.fn()}
        onQueuedMessageSelectContextAttachments={vi.fn().mockResolvedValue(undefined)}
        onQueuedMessageRemoveContextAttachment={vi.fn()}
        onQueuedMessageClearContextAttachments={vi.fn()}
        onSend={vi.fn()}
        onCancel={vi.fn()}
        isExecuting={false}
      />
    </TooltipProvider>,
  );
};

describe("SessionComposer", () => {
  it("renders the two memory toolbar toggles side by side", () => {
    renderSessionComposer();

    const toolbar = document.querySelector(".app-composer-toolbar");
    expect(toolbar).not.toBeNull();

    const buttonNames = within(toolbar as HTMLElement)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"));

    const sessionMemoryIndex = buttonNames.indexOf("Session memory");
    const globalMemoryIndex = buttonNames.indexOf("Global memory");
    const interviewIndex = buttonNames.indexOf("Interview");

    expect(sessionMemoryIndex).toBeGreaterThan(-1);
    expect(globalMemoryIndex).toBe(sessionMemoryIndex + 1);
    expect(interviewIndex).toBe(globalMemoryIndex + 1);
  });
});
