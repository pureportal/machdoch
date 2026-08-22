import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createSession } from "../../chat-session.model";
import { RUN_MODE_META } from "../_helpers/session-shell";
import { SessionComposer, type SessionComposerProps } from "./session-composer";

const EDIT_DRAFT = "Original edited request";
const noop = (): void => {};
const noopAsync = async (): Promise<void> => {};

const createProps = (
  overrides: Partial<SessionComposerProps> = {},
): SessionComposerProps => ({
  activeSession: createSession({
    id: "session-1",
    provider: "openai",
    model: "gpt-5.4",
    draft: EDIT_DRAFT,
  }),
  editingMessageId: "message-1",
  chooserProviders: ["openai"],
  activeRunMode: "machdoch",
  activeRunModeMeta: RUN_MODE_META.machdoch,
  defaultRunMode: "machdoch",
  defaultReasoning: "default",
  activeReasoning: "default",
  isUsingWorkspaceDefaultMode: true,
  isUsingWorkspaceDefaultReasoning: true,
  hasActiveWorkspace: true,
  workspaceLocked: false,
  recentWorkspaces: [],
  composerWorkspaceLabel: "machdoch",
  sessionMemoryDescription: "",
  globalMemoryDescription: "",
  uiControlDescription: "",
  interviewDescription: "",
  isGlobalMemoryAvailable: true,
  isGlobalMemoryActive: false,
  isUiControlAvailable: true,
  interviewEnabled: false,
  interviewDisabled: false,
  promptEnhancementMode: "simple",
  promptEnhancementWebSearchAvailable: true,
  promptEnhancementWebSearchUnavailableReason: "",
  contextAttachments: [],
  contextPacks: [],
  matchedContextPackIds: [],
  imageInputSupported: true,
  imageInputDisabledReason: null,
  speechInput: {
    browserSupported: true,
    enabled: false,
    recording: false,
    transcribing: false,
    statusText: null,
    statusTone: null,
    onAction: noop,
    onStatusDismiss: noop,
  },
  canSendMessage: false,
  sendDisabledReason: "Prompt enhancement is still running.",
  runningTaskMessageAction: "steer",
  queuedMessages: [],
  onSelectFolder: noopAsync,
  onWorkspaceSelection: noop,
  onWorkspaceRemoval: noop,
  onSessionModelSelection: noop,
  onSessionModeSelection: noop,
  onSessionReasoningSelection: noop,
  onSessionMemoryEnabledChange: noop,
  onUseGlobalMemoryChange: noop,
  onUiControlEnabledChange: noop,
  onInterviewEnabledChange: noop,
  onPromptEnhancementModeChange: noop,
  onSelectContextFiles: noopAsync,
  onSelectContextFolders: noopAsync,
  onSelectContextImages: noopAsync,
  onPasteContextImages: noopAsync,
  onOpenContextAttachment: noop,
  onRemoveContextAttachment: noop,
  onClearContextAttachments: noop,
  onSaveContextPack: noop,
  onApplyContextPack: noop,
  onDeleteContextPack: noop,
  onExportContextPacks: noop,
  onImportContextPacks: noop,
  onDraftChange: noop,
  onComposerHistoryNavigation: noop,
  onRunningTaskMessageActionChange: noop,
  onQueuedMessageChange: noop,
  onQueuedMessageMove: noop,
  onQueuedMessageReorder: noop,
  onQueuedMessageRemove: noop,
  onQueuedMessageRetry: noop,
  onQueuedMessageSend: noop,
  onQueuedMessageSelectContextAttachments: noopAsync,
  onQueuedMessageRemoveContextAttachment: noop,
  onQueuedMessageClearContextAttachments: noop,
  onSend: noop,
  onCancel: noop,
  isExecuting: true,
  ...overrides,
});

describe("SessionComposer enhancement", () => {
  it("keeps the normal composer available while enhancement is shown in the conversation", () => {
    const markup = renderToStaticMarkup(
      createElement(
        SessionComposer,
        createProps({
          editingMessageId: null,
          canSendMessage: true,
          sendDisabledReason: null,
          runningTaskMessageAction: "queue",
          isExecuting: false,
          isPromptEnhancementActive: true,
        }),
      ),
    );

    expect(markup).toContain("<textarea");
    expect(markup).toContain(EDIT_DRAFT);
    expect(markup).toContain("What should machdoch do next?");
    expect(markup).toContain('aria-label="Queue message"');
    expect(markup).not.toContain("Enhancing prompt");
    expect(markup).not.toContain("Running");
  });

  it("keeps the normal composer available outside edit enhancement", () => {
    const markup = renderToStaticMarkup(
      createElement(
        SessionComposer,
        createProps({
          activeSession: createSession({
            id: "session-1",
            provider: "openai",
            model: "gpt-5.4",
            workspace: "C:/workspace",
            draft: EDIT_DRAFT,
          }),
          editingMessageId: null,
          promptEnhancementMode: "off",
          canSendMessage: true,
          sendDisabledReason: null,
          isExecuting: false,
        }),
      ),
    );

    expect(markup).toContain("<textarea");
    expect(markup).toContain(EDIT_DRAFT);
    expect(markup).not.toContain("Enhance ongoing");
    expect(markup).not.toContain('aria-label="Workspace run"');
    expect(markup).not.toContain("Run configuration JSON");
  });
});
