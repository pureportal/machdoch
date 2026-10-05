// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createSession } from "../../chat-session.model";
import { RUN_MODE_META } from "../_helpers/session-shell";
import { SessionComposer, type SessionComposerProps } from "./session-composer";

const EDIT_DRAFT = "Original edited request";
const noop = (): void => {};
const noopAsync = async (): Promise<void> => {};

afterEach(() => cleanup());

beforeAll(() => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.setAttribute("open", "");
      },
    },
    close: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.removeAttribute("open");
      },
    },
  });
});
afterAll(() => {
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});

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
  memorySourceSessions: [],
  workspaceMemoryEntries: [],
  globalMemoryEntries: [],
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
    autoTranslateToEnglish: false,
    autoFormat: false,
    onAction: noop,
    onProcessingChange: noopAsync,
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
  onForgetSessionMemory: noop,
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
  onQueuedMessageSelectContextAttachments: noopAsync,
  onQueuedMessageRemoveContextAttachment: noop,
  onQueuedMessageClearContextAttachments: noop,
  onSend: noop,
  onCancel: noop,
  isExecuting: true,
  ...overrides,
});

describe("SessionComposer goal", () => {
  it.each([
    "active",
    "paused",
    "blocked",
    "complete",
    "budget-limited",
  ] as const)(
    "keeps a saved %s goal disabled when opening or switching sessions",
    (status) => {
      const onSend = vi.fn();
      const props = createProps({
        editingMessageId: null,
        canSendMessage: true,
        isExecuting: false,
        onSend,
      });
      const goal = {
        id: "saved-goal",
        objective: "All tests pass",
        mode: "machdoch" as const,
        status,
        turns: 1,
        tokensUsed: 10,
        elapsedMs: 1,
        reason: "",
        createdAt: 1,
        updatedAt: 1,
      };
      const view = render(
        createElement(SessionComposer, {
          ...props,
          activeSession: { ...props.activeSession, goal },
        }),
      );
      expect(
        screen
          .getByRole("button", { name: "Goal" })
          .getAttribute("aria-pressed"),
      ).toBe("false");
      expect(
        screen.queryByRole("textbox", { name: "Goal objective" }),
      ).toBeNull();
      view.rerender(
        createElement(SessionComposer, {
          ...props,
          activeSession: { ...props.activeSession, id: "other-session", goal },
        }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      expect(onSend).toHaveBeenCalledExactlyOnceWith(EDIT_DRAFT, 1, "continue");
      fireEvent.click(screen.getByRole("button", { name: "Goal" }));
      expect(
        screen
          .getByRole("button", { name: "Goal" })
          .getAttribute("aria-pressed"),
      ).toBe("true");
      expect(
        screen.getByRole<HTMLTextAreaElement>("textbox", {
          name: "Goal objective",
        }).value,
      ).toBe(goal.objective);
      fireEvent.click(screen.getByRole("button", { name: "Hide goal" }));
      view.rerender(
        createElement(SessionComposer, {
          ...props,
          activeSession: {
            ...props.activeSession,
            id: "other-session",
            goal: { ...goal, id: "new-goal" },
          },
        }),
      );
      expect(
        screen.queryByRole("textbox", { name: "Goal objective" }),
      ).toBeNull();
    },
  );

  it.each(["button", "keyboard"])(
    "starts the drafted goal when sending by %s",
    (method) => {
      const onSend = vi.fn();
      const props = createProps({
        editingMessageId: null,
        canSendMessage: true,
        sendDisabledReason: null,
        isExecuting: false,
        onSend,
      });
      const view = render(createElement(SessionComposer, props));
      fireEvent.click(screen.getByRole("button", { name: "Goal" }));
      fireEvent.change(
        screen.getByRole("textbox", { name: "Goal objective" }),
        {
          target: { value: "All tests pass" },
        },
      );
      if (method === "button") {
        fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      } else {
        fireEvent.keyDown(
          screen.getByRole("textbox", { name: "Task composer" }),
          {
            key: "Enter",
          },
        );
      }
      expect(onSend).toHaveBeenCalledExactlyOnceWith(
        EDIT_DRAFT,
        1,
        "continue",
        "All tests pass",
      );

      const goal = {
        id: "goal",
        objective: "All tests pass",
        mode: "machdoch" as const,
        status: "active" as const,
        turns: 1,
        tokensUsed: 0,
        elapsedMs: 0,
        reason: "",
        createdAt: 1,
        updatedAt: 1,
      };
      view.rerender(
        createElement(SessionComposer, {
          ...props,
          isExecuting: true,
          activeSession: { ...props.activeSession, goal },
        }),
      );
      expect(screen.getByRole("status").textContent).toBe("Active");
      expect(screen.getByRole("button", { name: "Pause goal" })).toBeDefined();
      expect(
        screen
          .getByRole("button", { name: "Goal" })
          .getAttribute("data-active"),
      ).toBe("true");
    },
  );

  it.each(["empty", "hidden", "other-session", "editing"])(
    "does not activate a goal from an %s draft",
    (scenario) => {
      const onSend = vi.fn();
      const props = createProps({
        editingMessageId: null,
        canSendMessage: true,
        sendDisabledReason: null,
        isExecuting: false,
        onSend,
      });
      const view = render(createElement(SessionComposer, props));
      fireEvent.click(screen.getByRole("button", { name: "Goal" }));
      if (scenario !== "empty") {
        fireEvent.change(
          screen.getByRole("textbox", { name: "Goal objective" }),
          {
            target: { value: "All tests pass" },
          },
        );
      }
      if (scenario === "hidden")
        fireEvent.click(screen.getByRole("button", { name: "Hide goal" }));
      if (scenario === "other-session")
        view.rerender(
          createElement(SessionComposer, {
            ...props,
            activeSession: { ...props.activeSession, id: "other-session" },
          }),
        );
      if (scenario === "editing")
        view.rerender(
          createElement(SessionComposer, {
            ...props,
            editingMessageId: "edit",
          }),
        );
      fireEvent.click(
        screen.getByRole("button", {
          name: scenario === "editing" ? "Save and submit" : "Send message",
        }),
      );
      expect(onSend).toHaveBeenCalledExactlyOnceWith(EDIT_DRAFT, 1, "continue");
    },
  );

  it("still starts a goal directly without sending the task draft", () => {
    const onSend = vi.fn();
    render(
      createElement(
        SessionComposer,
        createProps({ editingMessageId: null, isExecuting: false, onSend }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Goal" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Goal objective" }), {
      target: { value: "All tests pass" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start goal" }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith("/goal -- All tests pass");
  });
});

describe("SessionComposer enhancement", () => {
  it("shows enabled speech processing and toggles each option from the microphone menu", async () => {
    const onProcessingChange = vi.fn(async () => {});
    render(
      createElement(
        SessionComposer,
        createProps({
          editingMessageId: null,
          isExecuting: false,
          speechInput: {
            ...createProps().speechInput,
            enabled: true,
            autoTranslateToEnglish: true,
            autoFormat: true,
            onProcessingChange,
          },
        }),
      ),
    );

    const microphone = screen.getByRole("button", {
      name: "Speak to text (translate to English, format and improve text)",
    });
    expect(microphone.querySelector(".lucide-languages")).toBeTruthy();
    expect(microphone.querySelector(".lucide-wand-sparkles")).toBeTruthy();
    fireEvent.contextMenu(microphone);
    const translate = await screen.findByRole("menuitemcheckbox", {
      name: "Translate to English",
    });
    expect(translate.getAttribute("aria-checked")).toBe("true");
    const format = screen.getByRole("menuitemcheckbox", {
      name: "Format and improve text",
    });
    expect(format.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(format);
    expect(onProcessingChange).toHaveBeenCalledWith({
      autoTranslateToEnglish: true,
      autoFormat: false,
    });
  });

  it("uses distinct icons for each enabled speech option", () => {
    const speechInput = createProps().speechInput;
    const { rerender } = render(
      createElement(
        SessionComposer,
        createProps({
          editingMessageId: null,
          isExecuting: false,
          speechInput: {
            ...speechInput,
            enabled: true,
            autoTranslateToEnglish: true,
          },
        }),
      ),
    );

    const translateButton = screen.getByRole("button", {
      name: "Speak to text (translate to English)",
    });
    expect(translateButton.querySelector(".lucide-languages")).toBeTruthy();
    expect(translateButton.querySelector(".lucide-wand-sparkles")).toBeNull();

    rerender(
      createElement(
        SessionComposer,
        createProps({
          editingMessageId: null,
          isExecuting: false,
          speechInput: { ...speechInput, enabled: true, autoFormat: true },
        }),
      ),
    );

    const formatButton = screen.getByRole("button", {
      name: "Speak to text (format and improve text)",
    });
    expect(formatButton.querySelector(".lucide-languages")).toBeNull();
    expect(formatButton.querySelector(".lucide-wand-sparkles")).toBeTruthy();
  });

  it("allows formatting from the speech input menu", async () => {
    const onProcessingChange = vi.fn(async () => {});
    render(
      createElement(
        SessionComposer,
        createProps({
          editingMessageId: null,
          isExecuting: false,
          speechInput: {
            ...createProps().speechInput,
            enabled: true,
            onProcessingChange,
          },
        }),
      ),
    );

    fireEvent.contextMenu(
      screen.getByRole("button", { name: "Speak to text" }),
    );
    const format = await screen.findByRole("menuitemcheckbox", {
      name: "Format and improve text",
    });
    expect(format.getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(format);
    expect(onProcessingChange).toHaveBeenCalledWith({
      autoTranslateToEnglish: false,
      autoFormat: true,
    });
  });

  it("sends the selected iteration count and resets it after submission", () => {
    const onSend = vi.fn();
    render(
      createElement(
        SessionComposer,
        createProps({
          editingMessageId: null,
          canSendMessage: true,
          sendDisabledReason: null,
          isExecuting: false,
          onSend,
        }),
      ),
    );

    expect(screen.queryByRole("combobox", { name: "Iterations" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Iterations" }));
    const iterations = screen.getByRole("combobox", { name: "Iterations" });
    expect(screen.getByRole("combobox", { name: "Loop mode" })).toBeTruthy();
    fireEvent.change(iterations, { target: { value: "3" } });
    expect(screen.getByRole("button", { name: "Iterations: 3" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSend).toHaveBeenCalledWith(EDIT_DRAFT, 3, "continue");
    expect(screen.getByRole("button", { name: "Iterations" })).toBeTruthy();
  });

  it("sends the selected loop mode and resets it after submission", () => {
    const onSend = vi.fn();
    render(
      createElement(
        SessionComposer,
        createProps({
          editingMessageId: null,
          canSendMessage: true,
          sendDisabledReason: null,
          isExecuting: false,
          onSend,
        }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Iterations" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Iterations" }), {
      target: { value: "2" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Loop mode" }), {
      target: { value: "repeat-prompt-and-continue" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(onSend).toHaveBeenCalledWith(
      EDIT_DRAFT,
      2,
      "repeat-prompt-and-continue",
    );
    fireEvent.click(screen.getByRole("button", { name: "Iterations" }));
    expect(
      (screen.getByRole("combobox", { name: "Loop mode" }) as HTMLSelectElement)
        .value,
    ).toBe("continue");
  });

  it("queues repeated requests while a task is running", () => {
    const onRunningTaskMessageActionChange = vi.fn();
    render(
      createElement(
        SessionComposer,
        createProps({
          editingMessageId: null,
          canSendMessage: true,
          isExecuting: true,
          runningTaskMessageAction: "steer",
          onRunningTaskMessageActionChange,
        }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Iterations" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Iterations" }), {
      target: { value: "2" },
    });

    expect(onRunningTaskMessageActionChange).toHaveBeenCalledWith("queue");
  });

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

  it("opens and manages memory for the active session", () => {
    const onForgetSessionMemory = vi.fn();
    const activeSession = createSession({
      id: "session-1",
      provider: "openai",
      model: "gpt-5.4",
    });
    activeSession.sessionMemory = [
      {
        id: "memory-1",
        scope: "session",
        sourceSessionId: "session-1",
        key: "package-manager",
        kind: "fact",
        content: "Package manager: pnpm",
        searchTerms: ["package manager"],
        importance: 3,
        confidence: 1,
        createdAt: Date.UTC(2026, 7, 31, 14, 30),
        updatedAt: Date.UTC(2026, 7, 31, 14, 30),
      },
    ];

    render(
      createElement(
        SessionComposer,
        createProps({
          activeSession,
          editingMessageId: null,
          memorySourceSessions: [
            { id: "session-1", title: "Architecture review" },
          ],
          onForgetSessionMemory,
        }),
      ),
    );

    const memoryButton = screen.getByRole("button", { name: "Session memory" });
    expect(memoryButton.querySelector(".lucide-chevron-down")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Manage session memory" }),
    ).toBeNull();
    fireEvent.contextMenu(memoryButton);

    expect(screen.getByRole("dialog", { name: "Session memory" })).toBeTruthy();
    expect(screen.getByText("Package manager: pnpm")).toBeTruthy();
    expect(screen.getByText("Architecture review")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Forget" }));
    expect(onForgetSessionMemory).toHaveBeenCalledWith("memory-1");
    fireEvent.click(
      screen.getByRole("button", { name: "Close session memory" }),
    );
    expect(document.activeElement).toBe(memoryButton);
  });

  it.each(["workspace", "global"] as const)(
    "opens %s memory without changing its enabled state",
    (scope) => {
      const onEnabledChange = vi.fn();
      const title =
        scope === "workspace" ? "Workspace memory" : "Global memory";
      const entry = {
        id: `${scope}-1`,
        scope,
        content: `${scope} preference`,
        key: "preference",
        kind: "fact" as const,
        searchTerms: [],
        importance: 3,
        confidence: 1,
        createdAt: 1,
        updatedAt: 1,
      };
      render(
        createElement(
          SessionComposer,
          createProps({
            editingMessageId: null,
            isWorkspaceMemoryAvailable: true,
            isWorkspaceMemoryActive: false,
            workspaceMemoryEntries: scope === "workspace" ? [entry] : [],
            globalMemoryEntries: scope === "global" ? [entry] : [],
            onUseWorkspaceMemoryChange: onEnabledChange,
            onUseGlobalMemoryChange: onEnabledChange,
          }),
        ),
      );

      const button = screen.getByRole("button", { name: title });
      expect(button.getAttribute("data-active")).toBe("false");
      fireEvent.contextMenu(button);
      const dialog = screen.getByRole("dialog", { name: title });
      expect(within(dialog).getByText(`${scope} preference`)).toBeTruthy();
      expect(
        within(dialog).queryByRole("button", { name: "Forget" }),
      ).toBeNull();
      expect(onEnabledChange).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByRole("switch", { name: title }));
      expect(onEnabledChange).toHaveBeenCalledWith(true);
      fireEvent.click(
        within(dialog).getByRole("button", {
          name: `Close ${title.toLowerCase()}`,
        }),
      );
      expect(document.activeElement).toBe(button);
      fireEvent.click(button);
      expect(onEnabledChange).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("dialog")).toBeNull();
    },
  );

  it("opens unavailable memory for viewing through the keyboard", () => {
    const onUseGlobalMemoryChange = vi.fn();
    render(
      createElement(
        SessionComposer,
        createProps({
          editingMessageId: null,
          isGlobalMemoryAvailable: false,
          isGlobalMemoryActive: true,
          onUseGlobalMemoryChange,
        }),
      ),
    );
    const button = screen.getByRole("button", { name: "Global memory" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("data-active")).toBe("false");
    fireEvent.click(button);
    expect(onUseGlobalMemoryChange).not.toHaveBeenCalled();
    button.focus();
    fireEvent.keyDown(button, { key: "F10", shiftKey: true });
    const dialog = screen.getByRole("dialog", { name: "Global memory" });
    expect(within(dialog).getByText("No global memory saved.")).toBeTruthy();
    expect(
      within(dialog).getByRole<HTMLButtonElement>("switch", {
        name: "Global memory",
      }).disabled,
    ).toBe(true);
    fireEvent.click(
      within(dialog).getByRole("switch", { name: "Global memory" }),
    );
    expect(onUseGlobalMemoryChange).not.toHaveBeenCalled();
  });

  it("closes memory when changing workspace", () => {
    const props = createProps({ editingMessageId: null });
    const { rerender } = render(createElement(SessionComposer, props));
    fireEvent.contextMenu(
      screen.getByRole("button", { name: "Workspace memory" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Workspace memory" }),
    ).toBeTruthy();
    rerender(
      createElement(SessionComposer, {
        ...props,
        activeSession: {
          ...props.activeSession,
          workspace: "C:/another-workspace",
        },
      }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
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
