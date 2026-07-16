import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReasoningMode } from "../../../../core/runtime-contract.generated.js";
import type { ChatSessionRecord } from "../../chat-session.model";
import { TooltipProvider } from "../../components/ui/tooltip";
import type { RuntimeProvider } from "../../model-catalog";
import { RUN_MODE_META } from "../_helpers/session-shell";
import { SessionComposer } from "./session-composer";

vi.mock("../../runtime", () => ({
  listRalphFlows: vi.fn(),
  loadProviderModelCatalog: vi.fn(
    () => new Promise<never>(() => undefined),
  ),
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

const renderSessionComposer = ({
  activeSession = createSession(),
  chooserProviders = ["openai"],
  activeReasoning = activeSession.reasoning ?? "default",
  defaultReasoning = "default",
  isUsingWorkspaceDefaultReasoning = !activeSession.reasoning,
  canSendMessage = false,
  onSend = vi.fn(),
  onDraftChange = vi.fn(),
  onCreateMediaAsset,
  statusMessage = null,
  onStatusMessageDismiss = vi.fn(),
}: {
  activeSession?: ChatSessionRecord;
  chooserProviders?: RuntimeProvider[];
  activeReasoning?: ReasoningMode;
  defaultReasoning?: ReasoningMode;
  isUsingWorkspaceDefaultReasoning?: boolean;
  canSendMessage?: boolean;
  onSend?: (draft: string) => void;
  onDraftChange?: (draft: string) => void;
  onCreateMediaAsset?: (prompt: string) => void;
  statusMessage?: {
    text: string;
    tone: "success" | "error" | "info" | null;
  } | null;
  onStatusMessageDismiss?: () => void;
} = {}): void => {
  render(
    <TooltipProvider>
      <SessionComposer
        activeSession={activeSession}
        chooserProviders={chooserProviders}
        activeRunMode="machdoch"
        activeRunModeMeta={RUN_MODE_META.machdoch}
        defaultRunMode="machdoch"
        defaultReasoning={defaultReasoning}
        activeReasoning={activeReasoning}
        isUsingWorkspaceDefaultMode
        isUsingWorkspaceDefaultReasoning={isUsingWorkspaceDefaultReasoning}
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
        promptEnhancementMode="off"
        promptEnhancementWebSearchAvailable
        promptEnhancementWebSearchUnavailableReason="Configure web search."
        statusMessage={statusMessage}
        onStatusMessageDismiss={onStatusMessageDismiss}
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
        canSendMessage={canSendMessage}
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
        onPromptEnhancementModeChange={vi.fn()}
        onSelectContextFiles={vi.fn().mockResolvedValue(undefined)}
        onSelectContextFolders={vi.fn().mockResolvedValue(undefined)}
        onSelectContextImages={vi.fn().mockResolvedValue(undefined)}
        onCreateMediaAsset={onCreateMediaAsset}
        onPasteContextImages={vi.fn().mockResolvedValue(undefined)}
        onOpenContextAttachment={vi.fn()}
        onRemoveContextAttachment={vi.fn()}
        onClearContextAttachments={vi.fn()}
        onSaveContextPack={vi.fn()}
        onApplyContextPack={vi.fn()}
        onDeleteContextPack={vi.fn()}
        onExportContextPacks={vi.fn()}
        onImportContextPacks={vi.fn()}
        onDraftChange={onDraftChange}
        onComposerHistoryNavigation={vi.fn()}
        onRunningTaskMessageActionChange={vi.fn()}
        onQueuedMessageChange={vi.fn()}
        onQueuedMessageMove={vi.fn()}
        onQueuedMessageReorder={vi.fn()}
        onQueuedMessageRemove={vi.fn()}
        onQueuedMessageSelectContextAttachments={vi.fn().mockResolvedValue(undefined)}
        onQueuedMessageRemoveContextAttachment={vi.fn()}
        onQueuedMessageClearContextAttachments={vi.fn()}
        onSend={onSend}
        onCancel={vi.fn()}
        isExecuting={false}
      />
    </TooltipProvider>,
  );
};

describe("SessionComposer", () => {
  it("hands the current creative brief to Media Studio", async () => {
    const onCreateMediaAsset = vi.fn();
    renderSessionComposer({
      activeSession: createSession({ draft: "A moonlit glass pavilion" }),
      onCreateMediaAsset,
    });

    fireEvent.pointerDown(screen.getByRole("button", { name: "Add context" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: "Create in Media Studio",
      }),
    );

    expect(onCreateMediaAsset).toHaveBeenCalledWith(
      "A moonlit glass pavilion",
    );
  });

  it("updates the textarea immediately and publishes canonical state", () => {
    const onDraftChange = vi.fn();
    renderSessionComposer({ canSendMessage: true, onDraftChange });
    const textarea = screen.getByRole("textbox", { name: "Task composer" });

    fireEvent.change(textarea, { target: { value: "responsive draft" } });

    expect((textarea as HTMLTextAreaElement).value).toBe("responsive draft");
    expect(onDraftChange).toHaveBeenCalledWith("responsive draft");
  });

  it("flushes and submits the latest local draft on Enter", () => {
    const onDraftChange = vi.fn();
    const onSend = vi.fn();
    renderSessionComposer({
      canSendMessage: true,
      onDraftChange,
      onSend,
    });
    const textarea = screen.getByRole("textbox", { name: "Task composer" });

    fireEvent.change(textarea, { target: { value: "send immediately" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onDraftChange).toHaveBeenCalledWith("send immediately");
    expect(onSend).toHaveBeenCalledWith("send immediately");
  });

  it("does not submit an IME composition candidate on Enter", () => {
    const onSend = vi.fn();
    renderSessionComposer({
      activeSession: createSession({ draft: "編集中" }),
      canSendMessage: true,
      onSend,
    });

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Task composer" }), {
      key: "Enter",
      keyCode: 229,
      isComposing: true,
    });

    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows errors in a dismissible overlay without changing composer layout", () => {
    const onStatusMessageDismiss = vi.fn();

    renderSessionComposer({
      statusMessage: {
        text: "The request could not start because the session is already running.",
        tone: "error",
      },
      onStatusMessageDismiss,
    });

    const notification = screen.getByRole("alert");
    const overlay = notification.parentElement;

    expect(notification.className).toContain("app-session-notification");
    expect(overlay?.className).toContain("absolute");
    expect(document.querySelector(".app-composer-status")).toBeNull();

    fireEvent.click(
      within(notification).getByRole("button", {
        name: "Dismiss notification",
      }),
    );

    expect(onStatusMessageDismiss).toHaveBeenCalledOnce();
  });

  it("places the reasoning icon next to the selected session model", () => {
    renderSessionComposer();

    const toolbar = document.querySelector(".app-composer-toolbar");
    expect(toolbar).not.toBeNull();

    const buttonNames = within(toolbar as HTMLElement)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"));

    expect(buttonNames[0]).toMatch(/^Session model: OpenAI /u);
    expect(buttonNames[1]).toBe("Reasoning mode: Provider default");
    expect(buttonNames[2]).toBe("Execution mode: Machdoch");
    expect(buttonNames[3]).toBe("Prompt enhancement: Off");
  });

  it("filters session reasoning choices for the selected provider and model", () => {
    renderSessionComposer({
      activeSession: createSession({
        provider: "google",
        model: "gemini-2.5-pro",
      }),
      chooserProviders: ["openai", "google"],
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Reasoning mode: Provider default" }),
    );

    expect(
      screen.queryByRole("button", { name: "Choose XHigh reasoning" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Choose High reasoning" }),
    ).toBeTruthy();
  });

  it("shows OpenAI-only XHigh reasoning for GPT-5.5 sessions", () => {
    renderSessionComposer({
      activeSession: createSession({
        provider: "openai",
        model: "gpt-5.5",
      }),
      chooserProviders: ["openai", "google"],
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Reasoning mode: Provider default" }),
    );

    expect(
      screen.getByRole("button", { name: "Choose XHigh reasoning" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Choose Ultra reasoning" }),
    ).toBeNull();
  });

  it("shows Max and Ultra only for GPT-5.6-capable sessions", () => {
    renderSessionComposer({
      activeSession: createSession({
        provider: "openai",
        model: "gpt-5.6-sol",
      }),
      chooserProviders: ["openai", "anthropic"],
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Reasoning mode: Provider default" }),
    );

    expect(
      screen.getByRole("button", { name: "Choose Max reasoning" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Choose Ultra reasoning" }),
    ).toBeTruthy();
  });

  it("shows the effective workspace-default reasoning mode in the toolbar", () => {
    renderSessionComposer({
      activeSession: createSession({
        reasoning: undefined,
      }),
      activeReasoning: "xhigh",
      defaultReasoning: "xhigh",
      isUsingWorkspaceDefaultReasoning: true,
    });

    const reasoningButton = screen.getByRole("button", {
      name: "Reasoning mode: XHigh",
    });

    expect(reasoningButton.getAttribute("data-reasoning-mode")).toBe("xhigh");
    expect(reasoningButton.getAttribute("data-reasoning-source")).toBe(
      "workspace",
    );
    expect(reasoningButton.getAttribute("title")).toBe(
      "Reasoning mode: XHigh (workspace default)",
    );

    fireEvent.click(reasoningButton);

    const workspaceDefaultOption = screen.getByRole("button", {
      name: "Use workspace default reasoning",
    });

    expect(within(workspaceDefaultOption).getByText("Current")).toBeTruthy();
    expect(
      within(workspaceDefaultOption).getByText(
        "Currently XHigh. Use workspace config or environment default.",
      ),
    ).toBeTruthy();
  });

  it("lets you choose prompt enhancement mode from the composer", () => {
    renderSessionComposer();

    fireEvent.click(
      screen.getByRole("button", { name: "Prompt enhancement: Off" }),
    );

    expect(
      screen.getByRole("button", { name: "Choose Simple enhance" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Choose Enhance with web search" }),
    ).toBeTruthy();
  });

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
