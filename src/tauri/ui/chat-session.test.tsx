import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { ChatSession } from "./chat-session";
import { ConversationFeed } from "./chat-session/components/conversation-feed";
import {
  createInitialShellState,
  createSession,
  type ShellPersistedState,
} from "./chat-session.model";
import {
  createMockExecutionFixture,
  createPreviewFixture,
} from "./preview/fixtures";
import * as runtime from "./runtime";
import type { RuntimeSnapshot } from "./runtime";
import {
  desktopEventListeners,
  isTauriMock,
  listenMock,
  openMock,
  openUrlMock,
} from "./test/tauri-test-mocks";

class ResizeObserverMock {
  observe(): void {}

  unobserve(): void {}

  disconnect(): void {}
}

class SpeechSynthesisUtteranceMock {
  text: string;
  rate = 1;
  lang = "";
  voice: SpeechSynthesisVoice | null = null;
  onstart: ((event: Event) => void) | null = null;
  onend: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(text: string) {
    this.text = text;
  }
}

const speechVoices: SpeechSynthesisVoice[] = [
  {
    default: true,
    lang: "en-US",
    localService: true,
    name: "Machdoch Voice",
    voiceURI: "voice-default",
  } as SpeechSynthesisVoice,
  {
    default: false,
    lang: "en-GB",
    localService: true,
    name: "Review Voice",
    voiceURI: "voice-review",
  } as SpeechSynthesisVoice,
];

const speechVoiceListeners = new Set<() => void>();

const speechSynthesisMock = {
  paused: false,
  pending: false,
  speaking: false,
  lastUtterance: null as SpeechSynthesisUtteranceMock | null,
  getVoices: vi.fn(() => speechVoices),
  cancel: vi.fn(() => {
    speechSynthesisMock.speaking = false;
    speechSynthesisMock.lastUtterance = null;
  }),
  speak: vi.fn((utterance: SpeechSynthesisUtteranceMock) => {
    speechSynthesisMock.speaking = true;
    speechSynthesisMock.lastUtterance = utterance;
    utterance.onstart?.(new Event("start"));
  }),
  addEventListener: vi.fn((eventName: string, listener: () => void) => {
    if (eventName === "voiceschanged") {
      speechVoiceListeners.add(listener);
    }
  }),
  removeEventListener: vi.fn((eventName: string, listener: () => void) => {
    if (eventName === "voiceschanged") {
      speechVoiceListeners.delete(listener);
    }
  }),
};

const createdAudioElements: AudioMock[] = [];

class AudioMock {
  src: string;
  currentTime = 0;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  pause = vi.fn(() => undefined);
  play = vi.fn(async () => undefined);

  constructor(src = "") {
    this.src = src;
    createdAudioElements.push(this);
  }
}

const disableSpeechSynthesisSupport = (): void => {
  vi.stubGlobal("SpeechSynthesisUtterance", undefined);
  Object.defineProperty(window, "speechSynthesis", {
    value: undefined,
    writable: true,
    configurable: true,
  });
};

const enableSpeechSynthesisSupport = (): void => {
  vi.stubGlobal("SpeechSynthesisUtterance", SpeechSynthesisUtteranceMock);
  Object.defineProperty(window, "speechSynthesis", {
    value: speechSynthesisMock,
    writable: true,
    configurable: true,
  });
};

const resetSpeechSynthesisMock = (): void => {
  speechSynthesisMock.paused = false;
  speechSynthesisMock.pending = false;
  speechSynthesisMock.speaking = false;
  speechSynthesisMock.lastUtterance = null;
  speechSynthesisMock.getVoices.mockClear();
  speechSynthesisMock.cancel.mockClear();
  speechSynthesisMock.speak.mockClear();
  speechSynthesisMock.addEventListener.mockClear();
  speechSynthesisMock.removeEventListener.mockClear();
  speechVoiceListeners.clear();
};

const resetAudioPlaybackMock = (): void => {
  createdAudioElements.length = 0;
};

const AI_AUDIO_BASE64 = "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  vi.stubGlobal("Audio", AudioMock as unknown as typeof Audio);
  disableSpeechSynthesisSupport();
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  cleanup();
  disableSpeechSynthesisSupport();
  resetSpeechSynthesisMock();
  resetAudioPlaybackMock();
  isTauriMock.mockReturnValue(true);
  openMock.mockResolvedValue("/mocked/tauri/path");
  openMock.mockClear();
  openUrlMock.mockClear();
  listenMock.mockClear();
  desktopEventListeners.clear();
  window.localStorage.clear();
});

afterEach(() => {
  try {
    act(() => {
      vi.runOnlyPendingTimers();
    });
  } catch {
    vi.useRealTimers();
  }
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const selectWorkspace = async (): Promise<void> => {
  fireEvent.click(screen.getByRole("button", { name: /Choose workspace/i }));

  await waitFor(() => {
    const dialogOpened = openMock.mock.calls.length > 0;
    const workspaceLabelUpdated =
      screen.queryByRole("button", { name: /Choose workspace/i }) === null;

    expect(dialogOpened || workspaceLabelUpdated).toBe(true);
  });
};

const SHELL_STATE_STORAGE_KEY = "machdoch.desktop.shell-state";

const storeShellState = (state: ShellPersistedState): void => {
  window.localStorage.setItem(SHELL_STATE_STORAGE_KEY, JSON.stringify(state));
};

const storeAutoReadVoiceShellState = (): void => {
  const baseState = createInitialShellState();

  storeShellState({
    ...baseState,
    voice: {
      ...baseState.voice,
      autoSpeakResponses: true,
    },
  });
};

const flushShellHydration = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const createRuntimeSnapshot = (
  overrides: Partial<RuntimeSnapshot> = {},
): RuntimeSnapshot => {
  return {
    workspaceRoot: "/mocked/tauri/path",
    availableProfiles: [],
    mode: "ask",
    enabledTools: ["filesystem", "shell"],
    provider: "openai",
    model: "gpt-5.4-mini",
    offline: false,
    compatibility: {
      discoverGithubCustomizations: false,
    },
    providerAvailability: [],
    webSearch: {
      activeProvider: "none",
      providerAvailability: [],
    },
    ...overrides,
  };
};

const createStoredShellState = (): ShellPersistedState => {
  const baseState = createInitialShellState();
  const now = 1_713_260_000_000;
  const buildExecutionMessage = (
    taskId: string,
    title: string,
    createdAt: number,
    status: "executed" | "approval-required",
  ) => ({
    id: `${taskId}-agent`,
    taskId,
    role: "agent" as const,
    content: title,
    createdAt,
    source: {
      kind: "execution" as const,
      execution: {
        ...createMockExecutionFixture(title, "/mocked/tauri/path"),
        task: title,
        status,
        summary:
          status === "approval-required"
            ? "Approval required before continuing."
            : "Task finished cleanly.",
      },
    },
  });

  const emptySession = createSession({
    id: "empty-session",
    manualTitle: "Empty session",
    updatedAt: now - 5_000,
  });

  const runningSession = createSession({
    id: "running-session",
    manualTitle: "Running session",
    updatedAt: now - 4_000,
    messages: [
      {
        id: "running-task-user",
        taskId: "running-task",
        role: "user",
        content: "Continue running task",
        createdAt: now - 4_100,
      },
    ],
  });

  const waitingSession = createSession({
    id: "waiting-session",
    manualTitle: "Waiting session",
    updatedAt: now - 3_000,
    messages: [
      {
        id: "waiting-task-user",
        taskId: "waiting-task",
        role: "user",
        content: "Need approval",
        createdAt: now - 3_100,
      },
      buildExecutionMessage(
        "waiting-task",
        "Need approval",
        now - 3_000,
        "approval-required",
      ),
    ],
  });

  const doneSession = createSession({
    id: "done-session",
    manualTitle: "Done session",
    updatedAt: now - 2_000,
    messages: [
      {
        id: "done-task-user",
        taskId: "done-task",
        role: "user",
        content: "Finish task",
        createdAt: now - 2_100,
      },
      buildExecutionMessage(
        "done-task",
        "Finish task",
        now - 2_000,
        "executed",
      ),
    ],
  });

  const archivedSession = createSession({
    id: "archived-session",
    manualTitle: "Archived session",
    archivedAt: now - 900,
    updatedAt: now - 1_000,
    messages: [
      {
        id: "archived-task-user",
        taskId: "archived-task",
        role: "user",
        content: "Archived task",
        createdAt: now - 1_100,
      },
      buildExecutionMessage(
        "archived-task",
        "Archived task",
        now - 1_000,
        "executed",
      ),
    ],
  });

  return {
    ...baseState,
    activeSessionId: runningSession.id,
    sessions: [
      archivedSession,
      doneSession,
      waitingSession,
      runningSession,
      emptySession,
    ],
  };
};

const getSessionRow = (title: string): HTMLElement => {
  const sessionButton = screen.getByRole("button", {
    name: `Open session ${title}`,
  });
  const row = sessionButton.parentElement;

  expect(row).not.toBeNull();

  return row as HTMLElement;
};

const getVisibleSessionButtonLabels = (): string[] => {
  return screen.getAllByRole("button").flatMap((button) => {
    const label = button.getAttribute("aria-label");

    return label?.startsWith("Open session ") ? [label] : [];
  });
};

const SLOW_UI_TEST_TIMEOUT_MS = 15_000;

const emitDesktopTaskProgress = (payload: {
  taskId: string;
  line: string;
  timestamp: number;
}): void => {
  const handler = desktopEventListeners.get("desktop-task-progress");

  expect(handler).toBeDefined();

  act(() => {
    handler?.({ payload });
  });
};

describe("ChatSession component", () => {
  it("renders empty state initially", () => {
    render(<ChatSession />);
    expect(screen.getByText(/Ready to automate/i)).toBeDefined();
    expect(
      screen.getByText(/Pick a workspace anytime, or start from your home/i),
    ).toBeDefined();
    expect(
      screen.getByPlaceholderText(/What should machdoch do next\?/i),
    ).toBeDefined();
    expect(screen.queryByText(/Prompt history/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /History/i })).toBeNull();
    expect(screen.queryByText(/Task activity timeline/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Send message" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it(
    "shows live thinking updates with a running spinner before the final response arrives",
    async () => {
      const runDesktopTaskSpy = vi
        .spyOn(runtime, "runDesktopTask")
        .mockImplementation(
          () => new Promise<DesktopTaskRunResponse>(() => {}),
        );

      const { container } = render(<ChatSession />);

      const input = screen.getByPlaceholderText(
        /What should machdoch do next\?/i,
      );
      fireEvent.change(input, {
        target: { value: "scan this workspace and explain the setup" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));

      await waitFor(() => {
        expect(runDesktopTaskSpy).toHaveBeenCalledTimes(1);
      });
      await waitFor(() => {
        expect(desktopEventListeners.has("desktop-task-progress")).toBe(true);
      });

      const taskId = runDesktopTaskSpy.mock.calls[0]?.[2]?.taskId;

      expect(typeof taskId).toBe("string");
      expect(
        screen.getByText(/Submitting the task to the desktop runtime\./i),
      ).toBeDefined();
      expect(container.querySelector(".animate-spin")).not.toBeNull();

      emitDesktopTaskProgress({
        taskId: taskId as string,
        line: "[executing] Reading workspace files",
        timestamp: 1,
      });

      expect(screen.getByText(/Reading workspace files/i)).toBeDefined();
      expect(screen.queryByText(/Workspace scan complete\./i)).toBeNull();

      runDesktopTaskSpy.mockRestore();
    },
    SLOW_UI_TEST_TIMEOUT_MS,
  );

  it(
    "allows sending a task before a folder is selected",
    async () => {
      const runDesktopTaskSpy = vi
        .spyOn(runtime, "runDesktopTask")
        .mockResolvedValue({
          execution: createMockExecutionFixture(
            "scan this workspace and explain the setup",
            "/mock/home/path",
          ),
        });

      render(<ChatSession />);

      const input = screen.getByPlaceholderText(
        /What should machdoch do next\?/i,
      );
      fireEvent.change(input, {
        target: { value: "scan this workspace and explain the setup" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));

      expect(
        await screen.findByText(
          /Workspace scan complete\./i,
          {},
          { timeout: SLOW_UI_TEST_TIMEOUT_MS },
        ),
      ).toBeDefined();
      expect(openMock).not.toHaveBeenCalled();
      expect(runDesktopTaskSpy).toHaveBeenCalledWith(
        null,
        "scan this workspace and explain the setup",
        expect.objectContaining({
          model: expect.any(String),
          provider: expect.any(String),
        }),
      );

      runDesktopTaskSpy.mockRestore();
    },
    SLOW_UI_TEST_TIMEOUT_MS,
  );

  it(
    "lets you switch the task mode from the composer",
    async () => {
      const runDesktopTaskSpy = vi
        .spyOn(runtime, "runDesktopTask")
        .mockResolvedValue({
          execution: createMockExecutionFixture(
            "scan this workspace and explain the setup",
            "/mock/home/path",
            { mode: "auto" },
          ),
        });

      render(<ChatSession />);

      fireEvent.click(
        screen.getByRole("button", { name: /Execution mode: Ask mode/i }),
      );
      fireEvent.click(
        screen.getByRole("button", { name: /Choose Autopilot/i }),
      );

      expect(
        screen.getByRole("button", { name: /Execution mode: Autopilot/i }),
      ).toBeDefined();

      const input = screen.getByPlaceholderText(
        /What should machdoch do next\?/i,
      );
      fireEvent.change(input, {
        target: { value: "scan this workspace and explain the setup" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));

      await waitFor(() => {
        expect(runDesktopTaskSpy).toHaveBeenCalledWith(
          null,
          "scan this workspace and explain the setup",
          expect.objectContaining({
            mode: "auto",
            model: expect.any(String),
            provider: expect.any(String),
          }),
        );
      });

      runDesktopTaskSpy.mockRestore();
    },
    SLOW_UI_TEST_TIMEOUT_MS,
  );

  it(
    "lets you apply a named profile from the runtime popover",
    async () => {
      const loadWorkspaceRuntimeSnapshotSpy = vi
        .spyOn(runtime, "loadWorkspaceRuntimeSnapshot")
        .mockImplementation(async (workspaceRoot, profile) => {
          return createRuntimeSnapshot({
            workspaceRoot: workspaceRoot ?? "/mocked/tauri/path",
            availableProfiles: [
              {
                name: "offline",
                description: "Safer local review defaults.",
              },
            ],
            ...(profile ? { activeProfile: profile } : {}),
            mode: profile === "offline" ? "safe" : "ask",
            provider: profile === "offline" ? "anthropic" : "openai",
            model:
              profile === "offline"
                ? "claude-sonnet-4-20250514"
                : "gpt-5.4-mini",
            providerAvailability: [
              { provider: "openai", configured: true },
              { provider: "anthropic", configured: true },
            ],
          });
        });
      const runDesktopTaskSpy = vi
        .spyOn(runtime, "runDesktopTask")
        .mockResolvedValue({
          execution: createMockExecutionFixture(
            "review the workspace defaults",
            "/mocked/tauri/path",
            {
              provider: "anthropic",
              model: "claude-sonnet-4-20250514",
            },
          ),
        });

      render(<ChatSession />);
      await selectWorkspace();

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /Execution mode: Safe mode/i }),
        ).toBeDefined();
      });

      const input = screen.getByPlaceholderText(
        /What should machdoch do next\?/i,
      );
      fireEvent.change(input, {
        target: { value: "review the workspace defaults" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));

      await waitFor(() => {
        expect(runDesktopTaskSpy).toHaveBeenCalledWith(
          "/mocked/tauri/path",
          "review the workspace defaults",
          expect.objectContaining({
            profile: "offline",
            provider: "anthropic",
            model: "claude-sonnet-4-20250514",
          }),
        );
      });

      loadWorkspaceRuntimeSnapshotSpy.mockRestore();
      runDesktopTaskSpy.mockRestore();
    },
    SLOW_UI_TEST_TIMEOUT_MS,
  );

  it(
    "selects a folder via Tauri dialog",
    async () => {
      render(<ChatSession />);
      await selectWorkspace();

      expect(
        screen.getByPlaceholderText(/What should machdoch do next\?/i),
      ).toBeDefined();
    },
    SLOW_UI_TEST_TIMEOUT_MS,
  );

  it(
    "shows preview-only execution state for unsupported tasks",
    async () => {
      render(<ChatSession />);
      await selectWorkspace();

      const input = screen.getByPlaceholderText(
        /What should machdoch do next\?/i,
      );
      fireEvent.change(input, {
        target: { value: "install dependencies and commit the changes" },
      });

      const sendBtn = screen.getByRole("button", { name: "Send message" });
      expect(sendBtn).toHaveProperty("disabled", false);
      fireEvent.click(sendBtn);

      expect(
        screen.getAllByText("install dependencies and commit the changes")
          .length,
      ).toBeGreaterThan(0);

      await waitFor(
        () => {
          expect(screen.getAllByText(/Preview only/i).length).toBeGreaterThan(
            0,
          );
        },
        { timeout: SLOW_UI_TEST_TIMEOUT_MS },
      );
      expect(screen.queryByText(/Task preview/i)).toBeNull();
      expect(screen.queryByText(/compact task preview/i)).toBeNull();
      expect(screen.queryByText(/Task execution/i)).toBeNull();
      expect(
        screen.getByText(
          /The shell kept the response explicit instead of pretending the task already ran/i,
        ),
      ).toBeDefined();
    },
    SLOW_UI_TEST_TIMEOUT_MS,
  );

  it(
    "keeps preview staging hidden while the final response is queued",
    async () => {
      vi.useFakeTimers();

      const runDesktopTaskSpy = vi
        .spyOn(runtime, "runDesktopTask")
        .mockResolvedValue({
          preview: createPreviewFixture("install dependencies and commit the changes"),
          execution: createMockExecutionFixture(
            "install dependencies and commit the changes",
            "/mocked/tauri/path",
          ),
        });

      render(<ChatSession />);

      const input = screen.getByPlaceholderText(
        /What should machdoch do next\?/i,
      );
      fireEvent.change(input, {
        target: { value: "install dependencies and commit the changes" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));

      expect(
        screen.getByText(/Submitting the task to the desktop runtime\./i),
      ).toBeDefined();

      await act(async () => {
        await Promise.resolve();
        vi.advanceTimersByTime(100);
      });

      expect(screen.queryByText(/Task preview/i)).toBeNull();
      expect(screen.queryByText(/compact task preview/i)).toBeNull();
      expect(
        screen.getByRole("button", { name: /Collapse thinking process/i }),
      ).toBeDefined();

      await act(async () => {
        vi.advanceTimersByTime(200);
        await Promise.resolve();
      });

      expect(screen.getByText(/Preview only\./i)).toBeDefined();
      expect(
        screen.getByRole("button", { name: /Expand thinking process/i }),
      ).toBeDefined();

      runDesktopTaskSpy.mockRestore();
    },
    SLOW_UI_TEST_TIMEOUT_MS,
  );

  it(
    "shows executed task state for read-only inspection tasks",
    async () => {
      render(<ChatSession />);
      await selectWorkspace();

      const input = screen.getByPlaceholderText(
        /What should machdoch do next\?/i,
      );
      fireEvent.change(input, {
        target: { value: "scan this workspace and explain the setup" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));

      expect(
        await screen.findByText(
          /Workspace scan complete\./i,
          {},
          { timeout: SLOW_UI_TEST_TIMEOUT_MS },
        ),
      ).toBeDefined();
      expect(screen.queryByText(/Task execution/i)).toBeNull();
      const expandThinkingButtons = screen.getAllByRole("button", {
        name: /Expand thinking process/i,
      });
      const expandThinkingButton =
        expandThinkingButtons[expandThinkingButtons.length - 1];

      expect(expandThinkingButton).toBeDefined();

      fireEvent.click(expandThinkingButton);

      expect(
        screen.getAllByRole("button", { name: /Collapse thinking process/i })
          .length,
      ).toBeGreaterThan(0);
      expect(screen.getByText(/1 check/i)).toBeDefined();
      expect(
        screen.getByTitle(
          /Desktop chat shell message rendering and compact feedback layout\./i,
        ),
      ).toBeDefined();
    },
    SLOW_UI_TEST_TIMEOUT_MS,
  );

  it(
    "renders markdown execution feedback and opens related workspace files from compact chips",
    async () => {
      const runDesktopTaskSpy = vi
        .spyOn(runtime, "runDesktopTask")
        .mockResolvedValue({
          execution: {
            ...createMockExecutionFixture(
              "refresh the desktop feedback surface",
              "/mocked/tauri/path",
              { mode: "auto" },
            ),
            summary: "Updated the chat shell response surface.",
            response: {
              markdown: [
                "**Updated the chat shell.**",
                "",
                "- Added Markdown rendering for agent replies",
                "- Added compact related-file chips",
              ].join("\n"),
              highlights: ["Kept the richer feedback compact."],
              relatedFiles: [
                {
                  path: "src/tauri/ui/chat-session-shell.tsx",
                  description: "Desktop chat shell response rendering.",
                },
              ],
              verification: ["Ran focused UI checks."],
              followUps: [],
            },
          },
        });
      const openWorkspacePathSpy = vi
        .spyOn(runtime, "openWorkspacePath")
        .mockResolvedValue();

      render(<ChatSession />);

      const input = screen.getByPlaceholderText(
        /What should machdoch do next\?/i,
      );
      fireEvent.change(input, {
        target: { value: "refresh the desktop feedback surface" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));

      expect(
        await screen.findByText(/Updated the chat shell\./i),
      ).toBeDefined();
      expect(
        screen.getByText(/Added Markdown rendering for agent replies/i),
      ).toBeDefined();
      expect(screen.getAllByText(/1 check/i).length).toBeGreaterThan(0);

      const relatedFileButton = screen.getByTitle(
        /Desktop chat shell response rendering\./i,
      );

      fireEvent.click(relatedFileButton);

      expect(openWorkspacePathSpy).toHaveBeenCalledWith(
        null,
        "src/tauri/ui/chat-session-shell.tsx",
      );

      runDesktopTaskSpy.mockRestore();
      openWorkspacePathSpy.mockRestore();
    },
    SLOW_UI_TEST_TIMEOUT_MS,
  );

  it(
    "passes prior session history into later desktop task runs",
    async () => {
      const runDesktopTaskSpy = vi
        .spyOn(runtime, "runDesktopTask")
        .mockImplementation(async (workspaceRoot, task, context = {}) => {
          return {
            execution: createMockExecutionFixture(
              task,
              workspaceRoot ?? undefined,
              {
                mode: context.mode,
                model: context.model,
                provider: context.provider,
              },
            ),
          };
        });

      render(<ChatSession />);
      runDesktopTaskSpy.mockClear();

      const input = screen.getByPlaceholderText(
        /What should machdoch do next\?/i,
      );
      const sendButton = screen.getByRole("button", { name: "Send message" });

      fireEvent.change(input, {
        target: { value: "scan this workspace and explain the setup" },
      });
      fireEvent.click(sendButton);

      fireEvent.change(input, {
        target: { value: "continue with the next step" },
      });
      fireEvent.click(sendButton);

      await waitFor(() => {
        expect(runDesktopTaskSpy).toHaveBeenCalledTimes(2);
      });

      expect(
        runDesktopTaskSpy.mock.calls[1]?.[2]?.conversationContext,
      ).toMatchObject({
        sessionMemoryEnabled: true,
        globalMemoryEnabled: false,
      });
      expect(
        runDesktopTaskSpy.mock.calls[1]?.[2]?.conversationContext?.history.some(
          (entry) =>
            entry.content.includes("scan this workspace and explain the setup"),
        ),
      ).toBe(true);

      runDesktopTaskSpy.mockRestore();
    },
    SLOW_UI_TEST_TIMEOUT_MS,
  );

  it(
    "switches settings sections with navbar buttons and keeps saved keys hidden",
    async () => {
      const loadUserWebSearchSettingsSpy = vi
        .spyOn(runtime, "loadUserWebSearchSettings")
        .mockResolvedValue({
          activeProvider: "perplexity",
          apiKeys: { perplexity: "pplx-real-key-1234567890" },
          providerAvailability: [
            { provider: "perplexity", configured: true },
            { provider: "tavily", configured: false },
          ],
        });

      render(<ChatSession />);

      fireEvent.click(screen.getByRole("button", { name: /Settings/i }));

      expect(await screen.findByText(/Model providers/i)).toBeDefined();

      fireEvent.click(screen.getByRole("button", { name: /^Web search$/i }));

      expect(
        await screen.findByText(/Active web search provider/i),
      ).toBeDefined();
      expect(
        screen.getByPlaceholderText(/Paste your Perplexity API key/i),
      ).toBeDefined();
      expect(
        (
          screen.getByPlaceholderText(
            /Paste your Perplexity API key/i,
          ) as HTMLInputElement
        ).value,
      ).toBe("");
      expect(screen.getByText(/The executor hides web search/i)).toBeDefined();
      expect(screen.queryByText(/Missing key/i)).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: /^Memory$/i }));

      expect(await screen.findByText(/^Global memory$/i)).toBeDefined();

      loadUserWebSearchSettingsSpy.mockRestore();
    },
    SLOW_UI_TEST_TIMEOUT_MS,
  );

  it(
    "saves the selected AI voice provider from global settings",
    async () => {
      const loadUserVoiceSettingsSpy = vi
        .spyOn(runtime, "loadUserVoiceSettings")
        .mockResolvedValue({
          activeProvider: "none",
          providerAvailability: [
            { provider: "openai", configured: true },
            { provider: "google", configured: false },
          ],
        });
      const saveUserVoiceActiveProviderSpy = vi
        .spyOn(runtime, "saveUserVoiceActiveProvider")
        .mockResolvedValue({
          activeProvider: "openai",
          providerAvailability: [
            { provider: "openai", configured: true },
            { provider: "google", configured: false },
          ],
        });

      render(<ChatSession />);

      fireEvent.click(screen.getByRole("button", { name: /Settings/i }));
      fireEvent.click(await screen.findByRole("button", { name: /^Voice$/i }));
      fireEvent.click(screen.getByRole("button", { name: /^OpenAI$/i }));

      await waitFor(() => {
        expect(saveUserVoiceActiveProviderSpy).toHaveBeenCalledWith("openai");
      });
      expect(
        await screen.findByText(/OpenAI will handle new spoken replies\./i),
      ).toBeDefined();

      loadUserVoiceSettingsSpy.mockRestore();
      saveUserVoiceActiveProviderSpy.mockRestore();
    },
    SLOW_UI_TEST_TIMEOUT_MS,
  );

  it(
    "auto-reads new assistant replies with AI voice when the provider is configured",
    async () => {
      storeAutoReadVoiceShellState();

      const loadUserVoiceSettingsSpy = vi
        .spyOn(runtime, "loadUserVoiceSettings")
        .mockResolvedValue({
          activeProvider: "openai",
          providerAvailability: [
            { provider: "openai", configured: true },
            { provider: "google", configured: false },
          ],
        });
      const synthesizeUserVoiceAudioSpy = vi
        .spyOn(runtime, "synthesizeUserVoiceAudio")
        .mockResolvedValue({
          provider: "openai",
          mimeType: "audio/wav",
          audioBase64: AI_AUDIO_BASE64,
        });
      const runDesktopTaskSpy = vi
        .spyOn(runtime, "runDesktopTask")
        .mockResolvedValue({
          execution: {
            ...createMockExecutionFixture(
              "summarize the latest changes",
              "/mock/home/path",
            ),
            summary: "Spoke the latest response.",
            response: {
              markdown: "**Voice reply.** Hello from AI speech.",
              highlights: [],
              relatedFiles: [],
              verification: [],
              followUps: [],
            },
          },
        });

      render(<ChatSession />);
      await flushShellHydration();

      await waitFor(() => {
        expect(loadUserVoiceSettingsSpy).toHaveBeenCalled();
      });

      const input = screen.getByPlaceholderText(
        /What should machdoch do next\?/i,
      );
      fireEvent.change(input, {
        target: { value: "summarize the latest changes" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));

      await waitFor(() => {
        expect(synthesizeUserVoiceAudioSpy).toHaveBeenCalledTimes(1);
      });

      expect(createdAudioElements.length).toBeGreaterThan(0);
      expect(createdAudioElements[0]?.play).toHaveBeenCalledTimes(1);
      expect(speechSynthesisMock.speak).toHaveBeenCalledTimes(0);

      loadUserVoiceSettingsSpy.mockRestore();
      synthesizeUserVoiceAudioSpy.mockRestore();
      runDesktopTaskSpy.mockRestore();
    },
    SLOW_UI_TEST_TIMEOUT_MS,
  );

  it(
    "falls back to system speech when the selected AI voice provider is unavailable",
    async () => {
      enableSpeechSynthesisSupport();
      storeAutoReadVoiceShellState();

      const loadUserVoiceSettingsSpy = vi
        .spyOn(runtime, "loadUserVoiceSettings")
        .mockResolvedValue({
          activeProvider: "google",
          providerAvailability: [
            { provider: "openai", configured: false },
            { provider: "google", configured: false },
          ],
        });
      const synthesizeUserVoiceAudioSpy = vi.spyOn(
        runtime,
        "synthesizeUserVoiceAudio",
      );
      const runDesktopTaskSpy = vi
        .spyOn(runtime, "runDesktopTask")
        .mockResolvedValue({
          execution: {
            ...createMockExecutionFixture(
              "read the latest assistant reply",
              "/mock/home/path",
            ),
            summary: "Fallback speech is ready.",
            response: {
              markdown: "**Voice reply.** Fallback speech is ready.",
              highlights: [],
              relatedFiles: [],
              verification: [],
              followUps: [],
            },
          },
        });

      render(<ChatSession />);
      await flushShellHydration();

      await waitFor(() => {
        expect(loadUserVoiceSettingsSpy).toHaveBeenCalled();
      });

      const input = screen.getByPlaceholderText(
        /What should machdoch do next\?/i,
      );
      fireEvent.change(input, {
        target: { value: "read the latest assistant reply" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));

      await waitFor(() => {
        expect(speechSynthesisMock.speak).toHaveBeenCalledTimes(1);
      });

      expect(synthesizeUserVoiceAudioSpy).not.toHaveBeenCalled();
      expect(speechSynthesisMock.lastUtterance?.text).toContain(
        "Voice reply. Fallback speech is ready.",
      );

      loadUserVoiceSettingsSpy.mockRestore();
      synthesizeUserVoiceAudioSpy.mockRestore();
      runDesktopTaskSpy.mockRestore();
    },
    SLOW_UI_TEST_TIMEOUT_MS,
  );

  it("renders a compact in-bubble replay control for assistant replies", () => {
    const onSpeakMessage = vi.fn();
    const onStopSpeaking = vi.fn();

    render(
      <ConversationFeed
        visibleMessages={[
          {
            id: "agent-reply-1",
            role: "agent",
            content: "**Voice reply.** Ready for manual playback.",
          },
        ]}
        bottomRef={{ current: null }}
        onOpenWorkspaceFile={() => {}}
        voicePlayback={{
          supported: true,
          speakingMessageId: null,
          onSpeakMessage,
          onStopSpeaking,
        }}
      />,
    );

    expect(screen.queryByText(/^Speak$/i)).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: /Read response aloud/i }),
    );

    expect(onSpeakMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-reply-1" }),
    );
    expect(onStopSpeaking).not.toHaveBeenCalled();
  });

  it(
    "opens the selected provider API key portal from settings",
    async () => {
      render(<ChatSession />);

      fireEvent.click(screen.getByRole("button", { name: /Settings/i }));

      fireEvent.click(
        await screen.findByRole("button", {
          name: /Open OpenAI API key settings/i,
        }),
      );

      expect(openUrlMock).toHaveBeenCalledWith(
        "https://platform.openai.com/api-keys",
      );

      fireEvent.click(screen.getByRole("button", { name: /^Anthropic$/i }));
      fireEvent.click(
        screen.getByRole("button", {
          name: /Open Anthropic API key settings/i,
        }),
      );

      expect(openUrlMock).toHaveBeenLastCalledWith(
        "https://platform.claude.com/settings/keys",
      );

      fireEvent.click(screen.getByRole("button", { name: /^Google$/i }));
      fireEvent.click(
        screen.getByRole("button", {
          name: /Open Google API key settings/i,
        }),
      );

      expect(openUrlMock).toHaveBeenLastCalledWith(
        "https://aistudio.google.com/app/apikey",
      );
    },
    SLOW_UI_TEST_TIMEOUT_MS,
  );

  it(
    "toggles session and global memory from composer shortcuts",
    async () => {
      const loadUserMemorySettingsSpy = vi
        .spyOn(runtime, "loadUserMemorySettings")
        .mockResolvedValue({
          globalEnabled: true,
          entries: [
            {
              id: "global-fact-1",
              scope: "global",
              content: "Remember the user's preferred folder layout.",
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          ],
        });
      const runDesktopTaskSpy = vi
        .spyOn(runtime, "runDesktopTask")
        .mockResolvedValue({
          execution: createMockExecutionFixture(
            "scan this workspace and explain the setup",
            "/mocked/tauri/path",
          ),
        });

      render(<ChatSession />);

      const sessionMemoryButton = await screen.findByRole("button", {
        name: /^Session memory$/i,
      });
      const globalMemoryButton = await screen.findByRole("button", {
        name: /^Global memory$/i,
      });

      await waitFor(() => {
        expect(globalMemoryButton.getAttribute("aria-pressed")).toBe("true");
      });
      expect(sessionMemoryButton.getAttribute("aria-pressed")).toBe("true");

      fireEvent.click(sessionMemoryButton);
      fireEvent.click(globalMemoryButton);

      expect(sessionMemoryButton.getAttribute("aria-pressed")).toBe("false");
      expect(globalMemoryButton.getAttribute("aria-pressed")).toBe("false");

      await selectWorkspace();

      const input = screen.getByPlaceholderText(
        /What should machdoch do next\?/i,
      );

      fireEvent.change(input, {
        target: { value: "scan this workspace and explain the setup" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));

      await waitFor(() => {
        expect(runDesktopTaskSpy).toHaveBeenCalledTimes(1);
      });

      expect(
        runDesktopTaskSpy.mock.calls[0]?.[2]?.conversationContext,
      ).toMatchObject({
        sessionMemoryEnabled: false,
        globalMemoryEnabled: false,
      });

      loadUserMemorySettingsSpy.mockRestore();
      runDesktopTaskSpy.mockRestore();
    },
    SLOW_UI_TEST_TIMEOUT_MS,
  );

  it(
    "enables UI control from the composer when the desktop runtime supports it",
    async () => {
      const loadWorkspaceRuntimeSnapshotSpy = vi
        .spyOn(runtime, "loadWorkspaceRuntimeSnapshot")
        .mockResolvedValue(
          createRuntimeSnapshot({
            providerAvailability: [{ provider: "openai", configured: true }],
            uiControl: {
              available: true,
              platform: "windows",
              supportsScreenshots: true,
              supportsWindowEnumeration: true,
              supportsInput: true,
              supportsWindowHandles: true,
            },
          }),
        );
      const runDesktopTaskSpy = vi
        .spyOn(runtime, "runDesktopTask")
        .mockResolvedValue({
          execution: createMockExecutionFixture(
            "open Notepad and inspect it",
            "/mocked/tauri/path",
          ),
        });

      render(<ChatSession />);

      await waitFor(
        () => {
          expect(
            screen.getByPlaceholderText(/What should machdoch do next\?/i),
          ).toBeTruthy();
        },
        {
          timeout: SLOW_UI_TEST_TIMEOUT_MS,
        },
      );

      await waitFor(
        () => {
          expect(
            screen.getByRole("button", {
              name: /^UI control$/i,
            }),
          ).toBeTruthy();
        },
        {
          timeout: SLOW_UI_TEST_TIMEOUT_MS,
        },
      );

      await waitFor(() => {
        expect(
          screen
            .getByRole("button", { name: /^UI control$/i })
            .getAttribute("aria-disabled"),
        ).toBeNull();
      });

      const uiControlButton = screen.getByRole("button", {
        name: /^UI control$/i,
      });

      fireEvent.click(uiControlButton);

      await waitFor(() => {
        expect(
          screen
            .getByRole("button", { name: /^UI control$/i })
            .getAttribute("aria-pressed"),
        ).toBe("true");
      });

      const input = screen.getByPlaceholderText(
        /What should machdoch do next\?/i,
      );

      fireEvent.change(input, {
        target: { value: "open Notepad and inspect it" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));

      await waitFor(() => {
        expect(runDesktopTaskSpy).toHaveBeenCalledTimes(1);
      });

      expect(
        runDesktopTaskSpy.mock.calls[0]?.[2]?.conversationContext,
      ).toMatchObject({
        uiControlEnabled: true,
        uiControl: {
          available: true,
          platform: "windows",
          supportsScreenshots: true,
          supportsWindowEnumeration: true,
          supportsInput: true,
          supportsWindowHandles: true,
        },
      });

      loadWorkspaceRuntimeSnapshotSpy.mockRestore();
      runDesktopTaskSpy.mockRestore();
    },
    SLOW_UI_TEST_TIMEOUT_MS,
  );

  it(
    "shows session statuses in the slim overview and filters open sessions by default",
    async () => {
      storeShellState(createStoredShellState());

      render(<ChatSession />);

      await waitFor(() => {
        expect(
          screen.getByRole("button", {
            name: "Open session Running session",
          }),
        ).toBeDefined();
      });

      expect(screen.queryByText(/^Saved sessions$/i)).toBeNull();
      expect(
        screen.queryByRole("button", {
          name: "Open session Archived session",
        }),
      ).toBeNull();

      expect(
        within(getSessionRow("Empty session")).getByLabelText(
          "Session status: Empty",
        ),
      ).toBeDefined();
      expect(
        within(getSessionRow("Running session")).getByLabelText(
          "Session status: Running",
        ),
      ).toBeDefined();
      expect(
        within(getSessionRow("Waiting session")).getByLabelText(
          "Session status: Waiting for approval",
        ),
      ).toBeDefined();
      expect(
        within(getSessionRow("Done session")).getByLabelText(
          "Session status: Done",
        ),
      ).toBeDefined();
      expect(
        screen.queryByRole("button", {
          name: "Archive Running session",
        }),
      ).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Status: Running" }));

      expect(
        screen.getByRole("button", { name: "Open session Running session" }),
      ).toBeDefined();
      expect(
        screen.queryByRole("button", { name: "Open session Done session" }),
      ).toBeNull();

      fireEvent.click(
        screen.getByRole("button", { name: "Status: Any status" }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Scope: Archived" }));
      const archivedScopeButton = screen.getByRole("button", {
        name: "Scope: Archived",
      });

      await waitFor(() => {
        expect(archivedScopeButton.getAttribute("aria-pressed")).toBe("true");
      });

      expect(
        await screen.findByRole("button", {
          name: "Open session Archived session",
        }),
      ).toBeDefined();
      expect(
        within(getSessionRow("Archived session")).getByLabelText(
          "Archived session",
        ),
      ).toBeDefined();
      expect(
        screen.queryByRole("button", {
          name: "Open session Running session",
        }),
      ).toBeNull();
    },
    SLOW_UI_TEST_TIMEOUT_MS,
  );

  it(
    "keeps archived sessions in timestamp order and removes the archive flag when chat continues",
    async () => {
      const runDesktopTaskSpy = vi
        .spyOn(runtime, "runDesktopTask")
        .mockResolvedValue({
          execution: createMockExecutionFixture(
            "continue archived conversation",
            "/mocked/tauri/path",
          ),
        });

      storeShellState(createStoredShellState());

      render(<ChatSession />);

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: "Open session Done session" }),
        ).toBeDefined();
      });

      fireEvent.click(
        screen.getByRole("button", { name: "Archive Done session" }),
      );

      expect(
        screen.queryByRole("button", { name: "Open session Done session" }),
      ).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Scope: Archived" }));
      const archivedScopeButton = screen.getByRole("button", {
        name: "Scope: Archived",
      });

      await waitFor(() => {
        expect(archivedScopeButton.getAttribute("aria-pressed")).toBe("true");
        expect(getVisibleSessionButtonLabels()).toEqual([
          "Open session Archived session",
          "Open session Done session",
        ]);
      });

      fireEvent.click(
        screen.getByRole("button", { name: "Open session Archived session" }),
      );

      const input = screen.getByPlaceholderText(
        /What should machdoch do next\?/i,
      );

      fireEvent.change(input, {
        target: { value: "continue archived conversation" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));

      await waitFor(() => {
        expect(runDesktopTaskSpy).toHaveBeenCalled();
      });

      expect(
        screen.getByRole("button", {
          name: "Open session Archived session",
        }),
      ).toBeDefined();

      fireEvent.click(screen.getByRole("button", { name: "Scope: Archived" }));

      expect(
        screen.queryByRole("button", {
          name: "Open session Archived session",
        }),
      ).toBeNull();

      runDesktopTaskSpy.mockRestore();
    },
    SLOW_UI_TEST_TIMEOUT_MS,
  );

  it("keeps saved provider API keys hidden when settings open", async () => {
    render(<ChatSession />);

    fireEvent.click(screen.getByRole("button", { name: /Settings/i }));

    const input = (await screen.findByPlaceholderText(
      /Paste your OpenAI API key/i,
    )) as HTMLInputElement;

    expect(input.value).toBe("");
  });
});
