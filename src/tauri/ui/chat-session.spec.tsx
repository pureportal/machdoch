import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { DEFAULT_USER_DESKTOP_SETTINGS } from "../../core/runtime-contract.generated.js";
import { AssistantPopupShell } from "./assistant-popup-shell";
import { ChatSession } from "./chat-session-shell";
import { ConversationFeed } from "./chat-session/components/conversation-feed";
import { ExecutionInsightRow } from "./chat-session/components/execution-insight-row";
import {
  createInitialShellState,
  createSession,
  QUICK_VOICE_SESSION_KIND,
  type ShellPersistedState,
} from "./chat-session.model";
import { ALL_SESSION_PROJECTS_FILTER } from "./chat-session/_helpers/session-history-index";
import {
  createMockExecutionFixture,
  createPreviewFixture,
} from "./preview/fixtures";
import { resolveAssistantSurfaceLayout } from "./assistant-surface";
import * as runtime from "./runtime";
import type { DesktopTaskRunResponse, RuntimeSnapshot } from "./runtime";
import { createInitialThinkingTrace } from "./task-thinking.model";
import {
  desktopEventListeners,
  isTauriMock,
  listenMock,
  monitorFromPoint,
  openMock,
  openUrlMock,
  windowDragDropListeners,
} from "./test/tauri-test-mocks";
import type { TaskExecutionProgress } from "../../core/types.js";

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
  monitorFromPoint.mockResolvedValue(null);
  listenMock.mockClear();
  desktopEventListeners.clear();
  windowDragDropListeners.clear();
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
const SESSION_RETENTION_DAY_MS = 24 * 60 * 60 * 1_000;

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

const createMonitorSnapshot = (workAreaHeight: number, scaleFactor = 1) => ({
  position: { x: 0, y: 0 },
  size: { width: 1280 * scaleFactor, height: workAreaHeight * scaleFactor },
  workArea: {
    position: { x: 0, y: 0 },
    size: { width: 1280 * scaleFactor, height: workAreaHeight * scaleFactor },
  },
  scaleFactor,
});

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
    mode: "ask",
    provider: "openai",
    model: "gpt-5.5",
    offline: false,
    agentLimits: {
      executorTurns: 64,
      autopilotExecutorIterations: 16,
    },
    compatibility: {
      discoverGithubCustomizations: false,
    },
    providerAvailability: [],
    webSearch: {
      activeProvider: "none",
      providerAvailability: [],
    },
    reviewModel: {
      mode: "base",
    },
    ...overrides,
  };
};

const createStoredShellState = (): ShellPersistedState => {
  const baseState = createInitialShellState();
  const now = Date.now();
  const buildExecutionMessage = (
    taskId: string,
    title: string,
    createdAt: number,
    status: "executed" | "blocked",
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
          status === "blocked"
            ? "Blocked before continuing."
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

  const failedSession = createSession({
    id: "failed-session",
    manualTitle: "Failed session",
    updatedAt: now - 3_000,
    messages: [
      {
        id: "failed-task-user",
        taskId: "failed-task",
        role: "user",
        content: "Needs machdoch mode",
        createdAt: now - 3_100,
      },
      buildExecutionMessage(
        "failed-task",
        "Needs machdoch mode",
        now - 3_000,
        "blocked",
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
      failedSession,
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

const openSessionActionsMenu = async (
  title: string,
  triggerRect?: DOMRect,
  rowRect?: DOMRect,
): Promise<HTMLElement> => {
  const row = getSessionRow(title);
  const menuButton = within(row).getByRole("button", {
    name: `Session actions for ${title}`,
  });

  if (rowRect) {
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue(rowRect);
  }

  if (triggerRect) {
    vi.spyOn(menuButton, "getBoundingClientRect").mockReturnValue(triggerRect);
  }

  fireEvent.click(menuButton);

  return screen.findByRole("menu", {
    name: `Session actions for ${title}`,
  });
};

const getVisibleSessionButtonLabels = (): string[] => {
  return screen.getAllByRole("button").flatMap((button) => {
    const label = button.getAttribute("aria-label");

    return label?.startsWith("Open session ") ? [label] : [];
  });
};

const SLOW_UI_TEST_TIMEOUT_MS = 30_000;

const emitDesktopTaskProgress = (payload: {
  taskId: string;
  progress: TaskExecutionProgress;
  timestamp: number;
}): void => {
  const handler = desktopEventListeners.get("desktop-task-progress");

  expect(handler).toBeDefined();

  act(() => {
    handler?.({ payload });
  });
};

const emitWindowDropEvent = (
  payload:
    | { type: "enter"; paths: string[]; position: { x: number; y: number } }
    | { type: "drop"; paths: string[]; position: { x: number; y: number } }
    | { type: "leave" },
): void => {
  const handler = [...windowDragDropListeners].at(-1);

  expect(handler).toBeDefined();

  act(() => {
    handler?.({ payload });
  });
};

const createDataTransfer = (
  data: Record<string, string>,
  files: File[] = [],
): DataTransfer => {
  const transferData = { ...data };

  return ({
    types: Object.keys(data),
    files,
    dropEffect: "none",
    effectAllowed: "all",
    getData: vi.fn((type: string) => transferData[type] ?? ""),
    setData: vi.fn((type: string, value: string) => {
      transferData[type] = value;
    }),
  }) as unknown as DataTransfer;
};

const dispatchBrowserDrop = (dataTransfer: DataTransfer): void => {
  const event = new Event("drop", {
    bubbles: true,
    cancelable: true,
  }) as DragEvent;

  Object.defineProperty(event, "dataTransfer", {
    value: dataTransfer,
  });

  act(() => {
    window.dispatchEvent(event);
  });
};

describe("ChatSession component", () => {
  it("renders empty state initially", async () => {
    const { container } = render(<ChatSession />);
    await flushShellHydration();

    expect(screen.getByText(/Ready to automate/i)).toBeDefined();
    expect(
      screen.queryByText(/Pick a workspace anytime, or start from your home/i),
    ).toBeNull();
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
    expect(container.querySelector("main")?.className).toContain("min-w-0");
  }, SLOW_UI_TEST_TIMEOUT_MS);

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
        progress: {
          task: "scan this workspace and explain the setup",
          mode: "ask",
          state: "executing",
          message: "Reading workspace files",
          executedTools: [],
          outputSections: [],
          cancellable: true,
        },
        timestamp: 1,
      });

      expect(screen.getByText(/Reading workspace files/i)).toBeDefined();
      expect(screen.queryByText(/Workspace scan complete\./i)).toBeNull();

      runDesktopTaskSpy.mockRestore();
    },
    SLOW_UI_TEST_TIMEOUT_MS,
  );

  it(
    "keeps accepting terminal progress after the desktop task promise resolves",
    async () => {
      let resolveTask: ((value: DesktopTaskRunResponse) => void) | null = null;
      const runDesktopTaskSpy = vi
        .spyOn(runtime, "runDesktopTask")
        .mockImplementation(
          () =>
            new Promise<DesktopTaskRunResponse>((resolve) => {
              resolveTask = resolve;
            }),
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
      expect(container.querySelector(".animate-spin")).not.toBeNull();

      vi.useFakeTimers();

      await act(async () => {
        resolveTask?.({
          execution: createMockExecutionFixture(
            "scan this workspace and explain the setup",
            "/mock/home/path",
          ),
        });
        await Promise.resolve();
      });

      emitDesktopTaskProgress({
        taskId: taskId as string,
        progress: {
          task: "scan this workspace and explain the setup",
          mode: "machdoch",
          state: "completed",
          message: "Workspace scan complete.",
          executedTools: ["filesystem"],
          outputSections: [],
          cancellable: false,
        },
        timestamp: 2,
      });

      expect(container.querySelector(".animate-spin")).toBeNull();
      expect(
        screen.getByRole("button", { name: "Expand thinking process" }),
      ).toBeDefined();

      act(() => {
        vi.advanceTimersByTime(250);
      });

      runDesktopTaskSpy.mockRestore();
    },
    SLOW_UI_TEST_TIMEOUT_MS,
  );

  it(
    "renders terminal progress for a recovered active desktop task",
    async () => {
      const now = Date.now();
      const activeTaskId = "recovered-active-task";
      const recoveredSession = createSession({
        id: "recovered-active-session",
        manualTitle: "Recovered active session",
        updatedAt: now - 1_000,
        messages: [
          {
            id: "recovered-active-user",
            taskId: activeTaskId,
            role: "user",
            content: "Continue recovered active task",
            createdAt: now - 1_100,
          },
          {
            id: "recovered-active-thinking",
            taskId: activeTaskId,
            role: "agent",
            content: "",
            createdAt: now - 1_000,
            source: {
              kind: "thinking",
              thinking: createInitialThinkingTrace("ask", now - 1_000),
            },
          },
        ],
      });

      storeShellState({
        ...createInitialShellState(),
        activeSessionId: recoveredSession.id,
        sessions: [recoveredSession],
      });

      const loadActiveDesktopTaskIdsSpy = vi
        .spyOn(runtime, "loadActiveDesktopTaskIds")
        .mockResolvedValue([activeTaskId]);
      const loadActiveDesktopTasksSpy = vi
        .spyOn(runtime, "loadActiveDesktopTasks")
        .mockResolvedValue([
          {
            id: activeTaskId,
            kind: "desktop",
            workspaceRoot: "/mocked/tauri/path",
            arguments: [],
            startedAt: now - 900,
          },
        ]);

      render(<ChatSession />);
      await flushShellHydration();

      await waitFor(() => {
        expect(loadActiveDesktopTaskIdsSpy).toHaveBeenCalled();
        expect(loadActiveDesktopTasksSpy).toHaveBeenCalled();
        expect(desktopEventListeners.has("desktop-task-progress")).toBe(true);
      });

      emitDesktopTaskProgress({
        taskId: activeTaskId,
        timestamp: now,
        progress: {
          task: "Continue recovered active task",
          mode: "ask",
          state: "completed",
          message: "Recovered task completed.",
          executedTools: [],
          outputSections: [],
          assistantText: "Recovered final response.",
          cancellable: false,
        },
      });

      expect(
        await screen.findByText(
          "Recovered final response.",
          {},
          { timeout: SLOW_UI_TEST_TIMEOUT_MS },
        ),
      ).toBeDefined();
      expect(screen.queryByText(/\*\*Task crashed\.\*\*/i)).toBeNull();

      loadActiveDesktopTasksSpy.mockRestore();
      loadActiveDesktopTaskIdsSpy.mockRestore();
    },
    SLOW_UI_TEST_TIMEOUT_MS,
  );

  it(
    "routes recovered task progress before active-task hydration completes",
    async () => {
      const now = Date.now();
      const activeTaskId = "early-recovered-task";
      const recoveredSession = createSession({
        id: "early-recovered-session",
        manualTitle: "Early recovered session",
        updatedAt: now - 1_000,
        messages: [
          {
            id: "early-recovered-user",
            taskId: activeTaskId,
            role: "user",
            content: "Continue early recovered task",
            createdAt: now - 1_100,
          },
          {
            id: "early-recovered-thinking",
            taskId: activeTaskId,
            role: "agent",
            content: "",
            createdAt: now - 1_000,
            source: {
              kind: "thinking",
              thinking: createInitialThinkingTrace("ask", now - 1_000),
            },
          },
        ],
      });
      let resolveActiveTasks:
        | ((tasks: Awaited<ReturnType<typeof runtime.loadActiveDesktopTasks>>) => void)
        | undefined;

      storeShellState({
        ...createInitialShellState(),
        activeSessionId: recoveredSession.id,
        sessions: [recoveredSession],
      });

      const loadActiveDesktopTaskIdsSpy = vi
        .spyOn(runtime, "loadActiveDesktopTaskIds")
        .mockResolvedValue([activeTaskId]);
      const loadActiveDesktopTasksSpy = vi
        .spyOn(runtime, "loadActiveDesktopTasks")
        .mockImplementation(
          () =>
            new Promise((resolve) => {
              resolveActiveTasks = resolve;
            }),
        );

      render(<ChatSession />);
      await flushShellHydration();

      await waitFor(() => {
        expect(loadActiveDesktopTaskIdsSpy).toHaveBeenCalled();
        expect(loadActiveDesktopTasksSpy).toHaveBeenCalled();
        expect(desktopEventListeners.has("desktop-task-progress")).toBe(true);
      });

      emitDesktopTaskProgress({
        taskId: activeTaskId,
        timestamp: now,
        progress: {
          task: "Continue early recovered task",
          mode: "ask",
          state: "completed",
          message: "Early recovered task completed.",
          executedTools: [],
          outputSections: [],
          assistantText: "Early recovered final response.",
          cancellable: false,
        },
      });

      expect(
        await screen.findByText(
          "Early recovered final response.",
          {},
          { timeout: SLOW_UI_TEST_TIMEOUT_MS },
        ),
      ).toBeDefined();

      await act(async () => {
        resolveActiveTasks?.([]);
        await Promise.resolve();
      });

      expect(screen.getAllByText("Early recovered final response.")).toHaveLength(1);

      loadActiveDesktopTasksSpy.mockRestore();
      loadActiveDesktopTaskIdsSpy.mockRestore();
    },
    SLOW_UI_TEST_TIMEOUT_MS,
  );

  it(
    "replaces terminal fallback text when the desktop response arrives",
    async () => {
      const taskResolvers: Array<(value: DesktopTaskRunResponse) => void> = [];
      const runDesktopTaskSpy = vi
        .spyOn(runtime, "runDesktopTask")
        .mockImplementation(
          () =>
            new Promise<DesktopTaskRunResponse>((resolve) => {
              taskResolvers.push(resolve);
            }),
        );

      render(<ChatSession />);

      const input = screen.getByPlaceholderText(
        /What should machdoch do next\?/i,
      );
      fireEvent.change(input, {
        target: { value: "ask a delegated agent to summarize the repo" },
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

      vi.useFakeTimers();

      emitDesktopTaskProgress({
        taskId: taskId as string,
        progress: {
          task: "ask a delegated agent to summarize the repo",
          mode: "machdoch",
          state: "verifying",
          message: "Codex CLI completed.",
          executedTools: ["shell"],
          outputSections: [],
          cancellable: true,
          assistantText: "Delegated final answer.",
        },
        timestamp: 2,
      });
      emitDesktopTaskProgress({
        taskId: taskId as string,
        progress: {
          task: "ask a delegated agent to summarize the repo",
          mode: "machdoch",
          state: "completed",
          message: "Delegated task completed.",
          executedTools: ["shell"],
          outputSections: [],
          cancellable: false,
        },
        timestamp: 3,
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_600);
      });

      expect(screen.getByText(/Delegated final answer\./i)).toBeDefined();
      expect(screen.queryByText(/Late command response\./i)).toBeNull();

      fireEvent.change(input, {
        target: { value: "follow up after fallback" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));

      expect(runDesktopTaskSpy).toHaveBeenCalledTimes(2);

      await act(async () => {
        const lateExecution = createMockExecutionFixture(
          "ask a delegated agent to summarize the repo",
          "/mock/home/path",
          { mode: "machdoch" },
        );

        taskResolvers[0]?.({
          execution: {
            ...lateExecution,
            summary: "Late command response.",
            response: {
              ...(lateExecution.response ?? {
                highlights: [],
                relatedFiles: [],
                verification: [],
                followUps: [],
              }),
              markdown: "Late command response.",
            },
          },
        });
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(250);
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(screen.queryByText(/Delegated final answer\./i)).toBeNull();
      expect(screen.getByText(/Late command response\./i)).toBeDefined();

      runDesktopTaskSpy.mockRestore();
    },
    SLOW_UI_TEST_TIMEOUT_MS,
  );

  it(
    "replaces a summary-only terminal fallback when the desktop response arrives",
    async () => {
      const taskResolvers: Array<(value: DesktopTaskRunResponse) => void> = [];
      const runDesktopTaskSpy = vi
        .spyOn(runtime, "runDesktopTask")
        .mockImplementation(
          () =>
            new Promise<DesktopTaskRunResponse>((resolve) => {
              taskResolvers.push(resolve);
            }),
        );

      render(<ChatSession />);

      const input = screen.getByPlaceholderText(
        /What should machdoch do next\?/i,
      );
      fireEvent.change(input, {
        target: { value: "ask a model-driven agent to inspect the app" },
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

      vi.useFakeTimers();

      emitDesktopTaskProgress({
        taskId: taskId as string,
        progress: {
          task: "ask a model-driven agent to inspect the app",
          mode: "machdoch",
          state: "completed",
          message: "Summary-only terminal completion.",
          executedTools: ["filesystem"],
          outputSections: [],
          cancellable: false,
        },
        timestamp: 2,
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_600);
      });

      expect(
        screen.getByText(/Summary-only terminal completion\./i),
      ).toBeDefined();
      expect(
        screen.queryByText(/Authoritative final response\./i),
      ).toBeNull();

      await act(async () => {
        const execution = createMockExecutionFixture(
          "ask a model-driven agent to inspect the app",
          "/mock/home/path",
          { mode: "machdoch" },
        );

        taskResolvers[0]?.({
          execution: {
            ...execution,
            summary: "Authoritative summary.",
            response: {
              ...(execution.response ?? {
                highlights: [],
                relatedFiles: [],
                verification: [],
                followUps: [],
              }),
              markdown: "Authoritative final response.",
            },
          },
        });
        await Promise.resolve();
      });

      expect(
        screen.queryByText(/Summary-only terminal completion\./i),
      ).toBeNull();
      expect(
        screen.getByText(/Authoritative final response\./i),
      ).toBeDefined();

      runDesktopTaskSpy.mockRestore();
    },
    SLOW_UI_TEST_TIMEOUT_MS,
  );

  it(
    "queues running-session follow-ups and drains edited reordered messages serially",
    async () => {
      const taskResolvers: Array<(value: DesktopTaskRunResponse) => void> = [];
      const runDesktopTaskSpy = vi
        .spyOn(runtime, "runDesktopTask")
        .mockImplementation(
          () =>
            new Promise<DesktopTaskRunResponse>((resolve) => {
              taskResolvers.push(resolve);
            }),
        );

      render(<ChatSession />);

      const input = screen.getByPlaceholderText(
        /What should machdoch do next\?/i,
      );

      fireEvent.change(input, {
        target: { value: "First running task" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));

      await waitFor(() => {
        expect(runDesktopTaskSpy).toHaveBeenCalledTimes(1);
      });

      fireEvent.change(input, {
        target: { value: "Second queued task" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Queue message" }));

      expect(runDesktopTaskSpy).toHaveBeenCalledTimes(1);

      fireEvent.change(input, {
        target: { value: "Third queued task" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Queue message" }));

      expect(runDesktopTaskSpy).toHaveBeenCalledTimes(1);
      expect(screen.getByLabelText("Queued messages")).toBeDefined();

      fireEvent.change(screen.getByLabelText("Queued message 1"), {
        target: { value: "Edited second queued task" },
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Move queued message 2 up" }),
      );

      await act(async () => {
        taskResolvers[0]?.({
          execution: createMockExecutionFixture(
            "First running task",
            "/mock/home/path",
          ),
        });
        await Promise.resolve();
      });

      await waitFor(
        () => {
          expect(runDesktopTaskSpy).toHaveBeenCalledTimes(2);
        },
        { timeout: SLOW_UI_TEST_TIMEOUT_MS },
      );
      expect(runDesktopTaskSpy.mock.calls[1]?.[1]).toBe("Third queued task");

      await act(async () => {
        taskResolvers[1]?.({
          execution: createMockExecutionFixture(
            "Third queued task",
            "/mock/home/path",
          ),
        });
        await Promise.resolve();
      });

      await waitFor(
        () => {
          expect(runDesktopTaskSpy).toHaveBeenCalledTimes(3);
        },
        { timeout: SLOW_UI_TEST_TIMEOUT_MS },
      );
      expect(runDesktopTaskSpy.mock.calls[2]?.[1]).toBe(
        "Edited second queued task",
      );

      runDesktopTaskSpy.mockRestore();
    },
    SLOW_UI_TEST_TIMEOUT_MS,
  );

  it(
    "reorders queued follow-ups by dragging the queued row handle",
    async () => {
      const taskResolvers: Array<(value: DesktopTaskRunResponse) => void> = [];
      const runDesktopTaskSpy = vi
        .spyOn(runtime, "runDesktopTask")
        .mockImplementation(
          () =>
            new Promise<DesktopTaskRunResponse>((resolve) => {
              taskResolvers.push(resolve);
            }),
        );

      render(<ChatSession />);

      const input = screen.getByPlaceholderText(
        /What should machdoch do next\?/i,
      );

      fireEvent.change(input, {
        target: { value: "First running task" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));

      await waitFor(() => {
        expect(runDesktopTaskSpy).toHaveBeenCalledTimes(1);
      });

      fireEvent.change(input, {
        target: { value: "Second queued task" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Queue message" }));
      fireEvent.change(input, {
        target: { value: "Third queued task" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Queue message" }));

      expect(
        (screen.getByLabelText("Queued message 1") as HTMLTextAreaElement).value,
      ).toBe("Second queued task");
      expect(
        (screen.getByLabelText("Queued message 2") as HTMLTextAreaElement).value,
      ).toBe("Third queued task");

      const dataTransfer = createDataTransfer({});
      const dragHandle = screen.getByRole("button", {
        name: "Drag queued message 2 to reorder",
      });
      const firstQueuedRow = screen.getByLabelText("Queued message 1 of 2");

      fireEvent.dragStart(dragHandle, { dataTransfer });
      fireEvent.dragEnter(firstQueuedRow, { dataTransfer });
      fireEvent.dragOver(firstQueuedRow, { dataTransfer });
      fireEvent.drop(firstQueuedRow, { dataTransfer });

      expect(
        (screen.getByLabelText("Queued message 1") as HTMLTextAreaElement).value,
      ).toBe("Third queued task");
      expect(
        (screen.getByLabelText("Queued message 2") as HTMLTextAreaElement).value,
      ).toBe("Second queued task");

      await act(async () => {
        taskResolvers[0]?.({
          execution: createMockExecutionFixture(
            "First running task",
            "/mock/home/path",
          ),
        });
        await Promise.resolve();
      });

      await waitFor(
        () => {
          expect(runDesktopTaskSpy).toHaveBeenCalledTimes(2);
        },
        { timeout: SLOW_UI_TEST_TIMEOUT_MS },
      );
      expect(runDesktopTaskSpy.mock.calls[1]?.[1]).toBe("Third queued task");

      runDesktopTaskSpy.mockRestore();
    },
    SLOW_UI_TEST_TIMEOUT_MS,
  );

  it(
    "edits attachments on queued follow-ups before they run",
    async () => {
      openMock.mockResolvedValue(["C:\\Docs\\plan.md"]);
      const resolveDroppedPathsSpy = vi
        .spyOn(runtime, "resolveDroppedPaths")
        .mockImplementation(async (paths) => ({
          workspaceRoot: "C:\\Docs",
          entries: paths.map((path) => ({
            path,
            kind: "file",
            name: path.split("\\").at(-1) ?? path,
            parent: "C:\\Docs",
          })),
        }));
      const runDesktopTaskSpy = vi
        .spyOn(runtime, "runDesktopTask")
        .mockImplementation(
          () => new Promise<DesktopTaskRunResponse>(() => {}),
        );

      render(<ChatSession />);

      const input = screen.getByPlaceholderText(
        /What should machdoch do next\?/i,
      );

      fireEvent.change(input, {
        target: { value: "First running task" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));

      await waitFor(() => {
        expect(runDesktopTaskSpy).toHaveBeenCalledTimes(1);
      });

      fireEvent.pointerDown(screen.getByRole("button", { name: "Add context" }), {
        button: 0,
        ctrlKey: false,
      });
      fireEvent.click(await screen.findByRole("menuitem", { name: /Files/i }));

      await waitFor(() => {
        expect(screen.getByText("plan.md")).toBeDefined();
      });

      fireEvent.change(input, {
        target: { value: "Queued task with context" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Queue message" }));

      expect(
        (screen.getByLabelText("Queued message 1") as HTMLTextAreaElement).value,
      ).toBe("Queued task with context");
      expect(
        screen.getByRole("button", { name: "Show file plan.md" }),
      ).toBeDefined();

      fireEvent.click(screen.getByRole("button", { name: "Remove plan.md" }));

      await waitFor(() => {
        expect(screen.queryByText("plan.md")).toBeNull();
        expect(screen.getByText("No attachments")).toBeDefined();
      });

      openMock.mockResolvedValue(["C:\\Docs\\extra.md"]);
      fireEvent.pointerDown(
        screen.getByRole("button", {
          name: "Add attachments to queued message 1",
        }),
        {
          button: 0,
          ctrlKey: false,
        },
      );
      fireEvent.click(await screen.findByRole("menuitem", { name: /Files/i }));

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: "Show file extra.md" }),
        ).toBeDefined();
      });
      expect(resolveDroppedPathsSpy).toHaveBeenLastCalledWith([
        "C:\\Docs\\extra.md",
      ]);

      resolveDroppedPathsSpy.mockRestore();
      runDesktopTaskSpy.mockRestore();
    },
    SLOW_UI_TEST_TIMEOUT_MS,
  );

  it(
    "adds steering notes to the running task timeline without launching another task",
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
        target: { value: "Start a long task" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));

      await waitFor(() => {
        expect(runDesktopTaskSpy).toHaveBeenCalledTimes(1);
      });

      fireEvent.click(screen.getByRole("button", { name: "Steer" }));
      fireEvent.change(input, {
        target: { value: "Use the new log file too" },
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Steer running task" }),
      );

      await waitFor(() => {
        expect(runDesktopTaskSpy).toHaveBeenCalledTimes(1);
      });
      const userBubbles = container.querySelectorAll(".app-user-message-bubble");

      expect(userBubbles).toHaveLength(1);
      expect(userBubbles[0]?.textContent).toContain("Start a long task");
      expect(userBubbles[0]?.textContent).not.toContain(
        "Use the new log file too",
      );
      expect(screen.getByText("Steering note")).toBeDefined();
      expect(screen.getByText("Use the new log file too")).toBeDefined();

      runDesktopTaskSpy.mockRestore();
    },
    SLOW_UI_TEST_TIMEOUT_MS,
  );

  it(
    "stops the running task before sending a stop-and-send follow-up",
    async () => {
      const taskRejecters: Array<(reason?: unknown) => void> = [];
      const runDesktopTaskSpy = vi
        .spyOn(runtime, "runDesktopTask")
        .mockImplementation(
          (_workspaceRoot, task) =>
            new Promise<DesktopTaskRunResponse>((resolve, reject) => {
              taskRejecters.push(reject);

              if (String(task) === "Replacement task") {
                resolve({
                  execution: createMockExecutionFixture(
                    "Replacement task",
                    "/mock/home/path",
                  ),
                });
              }
            }),
        );
      const cancelDesktopTaskSpy = vi
        .spyOn(runtime, "cancelDesktopTask")
        .mockResolvedValue(undefined);

      render(<ChatSession />);

      const input = screen.getByPlaceholderText(
        /What should machdoch do next\?/i,
      );

      fireEvent.change(input, {
        target: { value: "Task to stop" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));

      await waitFor(() => {
        expect(runDesktopTaskSpy).toHaveBeenCalledTimes(1);
      });

      fireEvent.click(screen.getByRole("button", { name: "Stop & Send" }));
      fireEvent.change(input, {
        target: { value: "Replacement task" },
      });
      fireEvent.click(
        screen.getByRole("button", {
          name: "Stop task and send message",
        }),
      );

      await waitFor(() => {
        expect(cancelDesktopTaskSpy).toHaveBeenCalled();
      });
      expect(runDesktopTaskSpy).toHaveBeenCalledTimes(1);

      await act(async () => {
        taskRejecters[0]?.(new Error("cancelled"));
        await Promise.resolve();
      });

      await waitFor(
        () => {
          expect(runDesktopTaskSpy).toHaveBeenCalledTimes(2);
        },
        { timeout: SLOW_UI_TEST_TIMEOUT_MS },
      );
      expect(runDesktopTaskSpy.mock.calls[1]?.[1]).toBe("Replacement task");

      cancelDesktopTaskSpy.mockRestore();
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
            { mode: "ask" },
          ),
      });

      render(<ChatSession />);
      await selectWorkspace();

      fireEvent.click(
        await screen.findByRole("button", {
          name: /Execution mode: Machdoch/i,
        }),
      );
      fireEvent.click(
        await screen.findByRole("button", { name: /Choose Ask mode/i }),
      );

      const modeButton = await screen.findByRole("button", {
        name: /Execution mode: Ask mode/i,
      });
      expect(modeButton).toBeDefined();
      expect(within(modeButton).queryByText(/Ask mode/i)).toBeNull();

      const input = screen.getByPlaceholderText(
        /What should machdoch do next\?/i,
      );
      fireEvent.change(input, {
        target: { value: "scan this workspace and explain the setup" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));

      await waitFor(() => {
        expect(runDesktopTaskSpy).toHaveBeenCalledWith(
          "/mocked/tauri/path",
          "scan this workspace and explain the setup",
          expect.objectContaining({
            mode: "ask",
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
    "shows recent workspaces after a workspace has been selected",
    async () => {
      render(<ChatSession />);
      await selectWorkspace();
      await screen.findByRole("button", { name: "path" });

      openMock.mockClear();
      openMock.mockResolvedValue("C:\\Another\\Workspace");
      fireEvent.click(screen.getByRole("button", { name: "path" }));

      expect(
        await screen.findByRole("button", {
          name: /Choose new workspace folder/i,
        }),
      ).toBeDefined();
      expect(openMock).not.toHaveBeenCalled();

      fireEvent.click(
        screen.getByRole("button", {
          name: /Choose new workspace folder/i,
        }),
      );

      await waitFor(() => {
        expect(openMock).toHaveBeenCalledWith({
          directory: true,
          multiple: false,
          title: "Select Workspace Folder",
        });
      });
      expect(
        await screen.findByRole("button", { name: "Workspace" }),
      ).toBeDefined();
    },
    SLOW_UI_TEST_TIMEOUT_MS,
  );

  it(
    "removes recent workspaces from the workspace picker",
    async () => {
      const baseState = createInitialShellState();

      storeShellState({
        ...baseState,
        recentWorkspaces: ["C:\\Docs\\Current", "C:\\Docs\\Archive"],
        sessions: baseState.sessions.map((session) => ({
          ...session,
          workspace: "C:\\Docs\\Current",
        })),
      });

      render(<ChatSession />);
      expect(
        await screen.findByRole("button", { name: "Current" }),
      ).toBeDefined();

      fireEvent.click(screen.getByRole("button", { name: "Current" }));
      expect(await screen.findByText("C:\\Docs\\Archive")).toBeDefined();

      fireEvent.click(
        await screen.findByRole("button", {
          name: "Remove Archive from workspace list",
        }),
      );

      await waitFor(() => {
        expect(screen.queryByText("C:\\Docs\\Archive")).toBeNull();
      });
      await waitFor(() => {
        const storedState = JSON.parse(
          window.localStorage.getItem(SHELL_STATE_STORAGE_KEY) ?? "{}",
        ) as ShellPersistedState;

        expect(storedState.recentWorkspaces).toEqual(["C:\\Docs\\Current"]);
      });
    },
    SLOW_UI_TEST_TIMEOUT_MS,
  );

  it(
    "uses the last selected workspace for new sessions",
    async () => {
      const baseState = createInitialShellState();

      storeShellState({
        ...baseState,
        recentWorkspaces: ["C:\\Docs\\Latest"],
        sessions: baseState.sessions.map((session) => ({
          ...session,
          workspace: "C:\\Docs\\Current",
        })),
      });

      render(<ChatSession />);
      expect(
        await screen.findByRole("button", { name: "Current" }),
      ).toBeDefined();

      fireEvent.click(screen.getByRole("button", { name: "New" }));

      expect(
        await screen.findByRole("button", { name: "Latest" }),
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
    "renders the final response as soon as the desktop response resolves",
    async () => {
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
        await screen.findByText(
          /Preview only\./i,
          {},
          { timeout: SLOW_UI_TEST_TIMEOUT_MS },
        ),
      ).toBeDefined();
      expect(screen.queryByText(/Task preview/i)).toBeNull();
      expect(screen.queryByText(/compact task preview/i)).toBeNull();
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
              { mode: "machdoch" },
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
        await screen.findByText(
          /Added Markdown rendering for agent replies/i,
          {},
          { timeout: SLOW_UI_TEST_TIMEOUT_MS },
        ),
      ).toBeDefined();

      const relatedFileButton = await screen.findByTitle(
        /Desktop chat shell response rendering\./i,
        {},
        { timeout: SLOW_UI_TEST_TIMEOUT_MS },
      );

      expect(screen.getAllByText(/1 check/i).length).toBeGreaterThan(0);

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
    "continues a task with a compact hidden prompt instead of a verbose visible message",
    async () => {
      const baseState = createInitialShellState();
      const legacyContinuationPrompt = [
        "Continue from this previous task.",
        "",
        "Previous task:",
        "Continue from this previous task.",
        "",
        "Previous task:",
        "Wie viel Uhr haben wir es?",
        "",
        "Previous status:",
        "executed",
        "",
        "Previous summary:",
        "Aktuelle Uhrzeit fuer Europa/Berlin abgefragt.",
        "",
        "Use the conversation and execution details above as context, then take the next useful step.",
      ].join("\n");
      const previousExecution = {
        ...createMockExecutionFixture(legacyContinuationPrompt),
        task: legacyContinuationPrompt,
        status: "executed" as const,
        summary: "Aktuelle Uhrzeit fuer Europa/Berlin erneut bereitgestellt.",
        response: {
          markdown: "**Done.** Uhrzeit erneut bereitgestellt.",
          highlights: [],
          relatedFiles: [],
          verification: [],
          followUps: ["Ask whether another timezone should be checked."],
        },
      };
      const session = createSession({
        id: "continue-session",
        messages: [
          {
            id: "original-user",
            taskId: "original-task",
            role: "user",
            content: "Wie viel Uhr haben wir es?",
            createdAt: 1,
          },
          {
            id: "original-agent",
            taskId: "original-task",
            role: "agent",
            content: "Aktuelle Uhrzeit fuer Europa/Berlin abgefragt.",
            createdAt: 2,
          },
          {
            id: "legacy-continue-user",
            taskId: "legacy-continue",
            role: "user",
            content: legacyContinuationPrompt,
            createdAt: 3,
          },
          {
            id: "legacy-continue-agent",
            taskId: "legacy-continue",
            role: "agent",
            content: previousExecution.response.markdown,
            createdAt: 4,
            source: {
              kind: "execution",
              execution: previousExecution,
            },
          },
        ],
      });
      const runDesktopTaskSpy = vi
        .spyOn(runtime, "runDesktopTask")
        .mockResolvedValue({
          execution: {
            ...createMockExecutionFixture("Continue the previous task."),
            summary: "Continued from compact context.",
            response: {
              markdown: "**Continued.**",
              highlights: [],
              relatedFiles: [],
              verification: [],
              followUps: [],
            },
          },
        });

      storeShellState({
        ...baseState,
        activeSessionId: session.id,
        sessions: [session],
      });

      render(<ChatSession />);

      await flushShellHydration();

      expect(screen.queryByText(/Previous task:/i)).toBeNull();
      expect(
        await screen.findByText("Continue previous task."),
      ).toBeDefined();

      fireEvent.click(
        await screen.findByRole("button", { name: /^Continue$/i }),
      );

      await waitFor(() => {
        expect(runDesktopTaskSpy).toHaveBeenCalledTimes(1);
      });

      const submittedTask = runDesktopTaskSpy.mock.calls[0]?.[1] ?? "";
      const conversationHistory =
        runDesktopTaskSpy.mock.calls[0]?.[2]?.conversationContext?.history ??
        [];

      expect(submittedTask).toContain("Continue the previous task.");
      expect(submittedTask).toContain("Objective: Wie viel Uhr haben wir es?");
      expect(submittedTask).not.toContain("Previous task:");
      expect(
        conversationHistory.some((entry) =>
          entry.content.includes("Previous task:"),
        ),
      ).toBe(false);
      expect(
        conversationHistory.some(
          (entry) => entry.content === "Continue previous task.",
        ),
      ).toBe(false);

      runDesktopTaskSpy.mockRestore();
    },
    SLOW_UI_TEST_TIMEOUT_MS,
  );

  it(
    "continues a crashed task as a new running task with a visible user anchor",
    async () => {
      const now = Date.now();
      const baseState = createInitialShellState();
      const crashedTaskId = "crashed-task";
      const session = createSession({
        id: "crashed-continue-session",
        manualTitle: "Crashed continue session",
        updatedAt: now - 1_000,
        messages: [
          {
            id: "crashed-user",
            taskId: crashedTaskId,
            role: "user",
            content: "Finish the crashed task",
            createdAt: now - 1_100,
          },
          {
            id: "crashed-agent",
            taskId: crashedTaskId,
            role: "agent",
            content:
              "**Task crashed.** machdoch restarted before this AI task finished, so it was marked as crashed.",
            createdAt: now - 1_000,
          },
        ],
      });
      const runDesktopTaskSpy = vi
        .spyOn(runtime, "runDesktopTask")
        .mockImplementation(
          () => new Promise<DesktopTaskRunResponse>(() => {}),
        );

      storeShellState({
        ...baseState,
        activeSessionId: session.id,
        sessions: [session],
      });

      render(<ChatSession />);

      await flushShellHydration();
      await screen.findByRole("button", {
        name: "Open session Crashed continue session",
      });
      expect(
        within(getSessionRow("Crashed continue session")).getByLabelText(
          "Session status: Crashed",
        ),
      ).toBeDefined();

      fireEvent.click(
        await screen.findByRole("button", { name: /^Continue$/i }),
      );

      await waitFor(() => {
        expect(runDesktopTaskSpy).toHaveBeenCalledTimes(1);
      });
      expect(await screen.findByText("Continue previous task.")).toBeDefined();
      await waitFor(() => {
        expect(
          within(getSessionRow("Crashed continue session")).getByLabelText(
            "Session status: Running",
          ),
        ).toBeDefined();
      });

      const continuedTaskId = runDesktopTaskSpy.mock.calls[0]?.[2]?.taskId;

      expect(typeof continuedTaskId).toBe("string");
      expect(continuedTaskId).not.toBe(crashedTaskId);
      await waitFor(() => {
        expect(desktopEventListeners.has("desktop-task-progress")).toBe(true);
      });

      emitDesktopTaskProgress({
        taskId: continuedTaskId as string,
        timestamp: now,
        progress: {
          task: "Continue crashed task",
          mode: "ask",
          state: "executing",
          message: "Recovered continue is working.",
          executedTools: [],
          outputSections: [],
          cancellable: true,
        },
      });

      expect(screen.getByText("Recovered continue is working.")).toBeDefined();

      runDesktopTaskSpy.mockRestore();
    },
    SLOW_UI_TEST_TIMEOUT_MS,
  );

  it(
    "switches settings sections with navbar buttons and shows saved web-search key value",
    async () => {
      const loadUserWebSearchSettingsSpy = vi
        .spyOn(runtime, "loadUserWebSearchSettings")
        .mockResolvedValue({
          activeProvider: "perplexity",
          apiKeys: { perplexity: "perplexity-user-key-1234567890" },
          providerAvailability: [
            { provider: "perplexity", configured: true },
            { provider: "tavily", configured: false },
          ],
        });

      render(<ChatSession />);

      fireEvent.click(screen.getByRole("button", { name: /Settings/i }));

      expect(
        await screen.findByText(
          /Model provider keys/i,
          undefined,
          { timeout: SLOW_UI_TEST_TIMEOUT_MS },
        ),
      ).toBeDefined();

      fireEvent.click(screen.getByRole("button", { name: /^Web search$/i }));

      expect(
        await screen.findByText(/Active web search provider/i),
      ).toBeDefined();

      const keyInput = await screen.findByDisplayValue(
        "perplexity-user-key-1234567890",
      );

      expect((keyInput as HTMLInputElement).type).toBe("password");

      fireEvent.click(
        screen.getByRole("button", { name: /Show Perplexity API key/i }),
      );

      expect((keyInput as HTMLInputElement).type).toBe("text");
      expect(screen.queryByText(/^Saved$/i)).toBeNull();
      expect(screen.queryByText(/^Missing$/i)).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: /^Memory$/i }));

      expect(await screen.findByText(/^Global memory$/i)).toBeDefined();

      loadUserWebSearchSettingsSpy.mockRestore();
    },
    SLOW_UI_TEST_TIMEOUT_MS,
  );

  it("saves Start in Tray as the desktop startup behavior", async () => {
    const saveUserDesktopSettingsSpy = vi
      .spyOn(runtime, "saveUserDesktopSettings")
      .mockImplementation(async (settings) => settings);

    render(<ChatSession />);

    fireEvent.click(screen.getByRole("button", { name: /Settings/i }));
    fireEvent.click(
      await screen.findByRole(
        "button",
        { name: /^Desktop$/i },
        { timeout: SLOW_UI_TEST_TIMEOUT_MS },
      ),
    );

    const launchPanel = screen
      .getByText(/^Launch on sign-in$/i)
      .closest("[data-setting-panel]");
    const startupPanel = screen
      .getByText(/^Startup behavior$/i)
      .closest("[data-setting-panel]");

    expect(launchPanel).not.toBeNull();
    expect(startupPanel).not.toBeNull();

    fireEvent.click(
      within(launchPanel as HTMLElement).getByRole("button", {
        name: "Enabled",
      }),
    );
    fireEvent.click(
      within(startupPanel as HTMLElement).getByRole("button", {
        name: "Start in tray",
      }),
    );

    expect(
      within(startupPanel as HTMLElement)
        .getByRole("button", { name: "Start in tray" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    await waitFor(() => {
      expect(saveUserDesktopSettingsSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          autostartEnabled: true,
          autostartMinimized: false,
          autostartToTray: true,
        }),
      );
    });

    saveUserDesktopSettingsSpy.mockRestore();
  }, SLOW_UI_TEST_TIMEOUT_MS);

  it("saves Always Run as Administrator as a desktop UI preference", async () => {
    const saveUserDesktopSettingsSpy = vi
      .spyOn(runtime, "saveUserDesktopSettings")
      .mockImplementation(async (settings) => settings);

    render(<ChatSession />);

    fireEvent.click(screen.getByRole("button", { name: /Settings/i }));
    fireEvent.click(
      await screen.findByRole(
        "button",
        { name: /^Desktop$/i },
        { timeout: SLOW_UI_TEST_TIMEOUT_MS },
      ),
    );

    const adminPanel = screen
      .getByText(/^Always run as administrator$/i)
      .closest("[data-setting-panel]");

    expect(adminPanel).not.toBeNull();
    expect(
      within(adminPanel as HTMLElement)
        .getByRole("button", { name: "Disabled" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    fireEvent.click(
      within(adminPanel as HTMLElement).getByRole("button", {
        name: "Enabled",
      }),
    );

    await waitFor(() => {
      expect(saveUserDesktopSettingsSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          alwaysRunAsAdministrator: true,
        }),
      );
    });

    saveUserDesktopSettingsSpy.mockRestore();
  }, SLOW_UI_TEST_TIMEOUT_MS);

  it("normalizes desktop numeric settings before auto-saving", async () => {
    const saveUserDesktopSettingsSpy = vi
      .spyOn(runtime, "saveUserDesktopSettings")
      .mockImplementation(async (settings) => settings);

    render(<ChatSession />);

    fireEvent.click(screen.getByRole("button", { name: /Settings/i }));
    fireEvent.click(
      await screen.findByRole(
        "button",
        { name: /^Desktop$/i },
        { timeout: SLOW_UI_TEST_TIMEOUT_MS },
      ),
    );

    const hideDurationPanel = screen
      .getByText(/^Hide duration$/i)
      .closest("[data-setting-panel]");
    const aiContextPanel = screen
      .getByText(/^AI context cap$/i)
      .closest("[data-setting-panel]");
    const inactiveArchivePanel = screen
      .getByText(/^Inactive archive$/i)
      .closest("[data-setting-panel]");
    const archivedCleanupPanel = screen
      .getByText(/^Archived cleanup$/i)
      .closest("[data-setting-panel]");
    const shortcutPanel = screen
      .getByText(/^Global shortcut$/i)
      .closest("[data-setting-panel]");
    const silencePanel = screen
      .getByText(/^Silence timeout$/i)
      .closest("[data-setting-panel]");
    const quickChatPanel = screen
      .getByText(/^Quick Chat cap$/i)
      .closest("[data-setting-panel]");

    expect(hideDurationPanel).not.toBeNull();
    expect(aiContextPanel).not.toBeNull();
    expect(inactiveArchivePanel).not.toBeNull();
    expect(archivedCleanupPanel).not.toBeNull();
    expect(shortcutPanel).not.toBeNull();
    expect(silencePanel).not.toBeNull();
    expect(quickChatPanel).not.toBeNull();

    fireEvent.change(
      within(hideDurationPanel as HTMLElement).getByRole("spinbutton"),
      { target: { value: "99" } },
    );
    fireEvent.change(
      within(aiContextPanel as HTMLElement).getByRole("spinbutton"),
      { target: { value: "999" } },
    );
    fireEvent.change(
      within(inactiveArchivePanel as HTMLElement).getByRole("spinbutton"),
      { target: { value: "999" } },
    );
    fireEvent.change(
      within(archivedCleanupPanel as HTMLElement).getByRole("spinbutton"),
      { target: { value: "999" } },
    );
    fireEvent.change(
      within(shortcutPanel as HTMLElement).getByRole("textbox"),
      { target: { value: "   " } },
    );
    fireEvent.change(
      within(silencePanel as HTMLElement).getByRole("spinbutton"),
      { target: { value: "0.1" } },
    );
    fireEvent.change(
      within(quickChatPanel as HTMLElement).getByRole("spinbutton"),
      { target: { value: "999" } },
    );

    await waitFor(() => {
      expect(saveUserDesktopSettingsSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          assistantBubbleTemporarilyHideSeconds: 30,
          aiContextMaxMessages: 200,
          inactiveSessionArchiveDays: 365,
          archivedSessionRetentionDays: 365,
          quickVoiceShortcut: "CommandOrControl+Alt+V",
          quickVoiceSilenceSeconds: 0.8,
          quickVoiceMaxMessages: 200,
        }),
      );
    });

    saveUserDesktopSettingsSpy.mockRestore();
  }, SLOW_UI_TEST_TIMEOUT_MS);

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
        onRetryTask={() => {}}
        onContinueTask={() => {}}
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

  it("renders user messages with Markdown in the conversation feed", () => {
    const userMarkdown = [
      "**Important.**",
      "",
      "- Keep the Markdown",
      "",
      "[Docs](https://example.com)",
    ].join("\n");

    const { container } = render(
      <ConversationFeed
        visibleMessages={[
          {
            id: "markdown-user-message",
            role: "user",
            content: userMarkdown,
          },
        ]}
        bottomRef={{ current: null }}
        onRetryTask={() => {}}
        onContinueTask={() => {}}
        onOpenWorkspaceFile={() => {}}
        voicePlayback={{
          supported: false,
          speakingMessageId: null,
          onSpeakMessage: () => {},
          onStopSpeaking: () => {},
        }}
      />,
    );

    const messageText = screen
      .getByText("Important.")
      .closest(".app-user-message-text");
    const listItem = screen.getByText("Keep the Markdown");
    const link = screen.getByRole("link", { name: "Docs" });

    expect(messageText?.className).toContain("app-message-markdown");
    expect(screen.getByText("Important.").tagName).toBe("STRONG");
    expect(listItem.tagName).toBe("LI");
    expect(link.getAttribute("href")).toBe("https://example.com");
    expect(container.textContent).not.toContain("**Important.**");
  });

  it("copies raw message Markdown from the message context menu", async () => {
    const messageMarkdown = "**Important.**\n\n- Keep the Markdown";
    const writeText = vi.fn().mockResolvedValue(undefined);

    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(
      <ConversationFeed
        visibleMessages={[
          {
            id: "copy-agent-message",
            role: "agent",
            content: messageMarkdown,
          },
        ]}
        bottomRef={{ current: null }}
        onRetryTask={() => {}}
        onContinueTask={() => {}}
        onOpenWorkspaceFile={() => {}}
        voicePlayback={{
          supported: false,
          speakingMessageId: null,
          onSpeakMessage: () => {},
          onStopSpeaking: () => {},
        }}
      />,
    );

    const messageBubble = screen
      .getByText("Important.")
      .closest(".app-message-bubble");

    expect(messageBubble).not.toBeNull();

    fireEvent.contextMenu(messageBubble as Element, {
      clientX: 96,
      clientY: 128,
    });
    fireEvent.click(screen.getByRole("menuitem", { name: /Copy Markdown/i }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(messageMarkdown);
    });
    expect(screen.queryByRole("menu", { name: "Message actions" })).toBeNull();
  });

  it("saves a message as a Markdown download from the message context menu", async () => {
    const messageMarkdown = "Save this message\n\n```ts\nconst ok = true;\n```";
    const createObjectUrl = vi.fn(() => "blob:machdoch-message");
    const revokeObjectUrl = vi.fn();
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    Object.defineProperty(URL, "createObjectURL", {
      value: createObjectUrl,
      configurable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: revokeObjectUrl,
      configurable: true,
    });

    try {
      const { container } = render(
        <ConversationFeed
          visibleMessages={[
            {
              id: "save-user-message",
              role: "user",
              content: messageMarkdown,
            },
          ]}
          bottomRef={{ current: null }}
          onRetryTask={() => {}}
          onContinueTask={() => {}}
          onOpenWorkspaceFile={() => {}}
          voicePlayback={{
            supported: false,
            speakingMessageId: null,
            onSpeakMessage: () => {},
            onStopSpeaking: () => {},
          }}
        />,
      );

      const messageBubble = container.querySelector(".app-message-bubble");

      expect(messageBubble).not.toBeNull();

      fireEvent.contextMenu(messageBubble as Element, {
        clientX: 96,
        clientY: 128,
      });
      fireEvent.click(screen.getByRole("menuitem", { name: /Save Message/i }));

      expect(createObjectUrl).toHaveBeenCalledWith(expect.any(Blob));
      const savedBlob = createObjectUrl.mock.calls[0]?.[0];

      expect(savedBlob).toBeInstanceOf(Blob);
      await expect((savedBlob as Blob).text()).resolves.toBe(messageMarkdown);
      expect(clickSpy).toHaveBeenCalled();
      expect(revokeObjectUrl).toHaveBeenCalledWith("blob:machdoch-message");
      expect(screen.queryByRole("menu", { name: "Message actions" })).toBeNull();
    } finally {
      if (originalCreateObjectUrl) {
        Object.defineProperty(URL, "createObjectURL", {
          value: originalCreateObjectUrl,
          configurable: true,
        });
      } else {
        Reflect.deleteProperty(URL, "createObjectURL");
      }

      if (originalRevokeObjectUrl) {
        Object.defineProperty(URL, "revokeObjectURL", {
          value: originalRevokeObjectUrl,
          configurable: true,
        });
      } else {
        Reflect.deleteProperty(URL, "revokeObjectURL");
      }
    }
  });

  it("keeps long user messages constrained to the feed width", () => {
    const longMessage = [
      "Disable the requirement to insert my password on every boot!",
      "This sentence is intentionally long enough to exercise wrapping in the chat bubble instead of widening the main shell.",
      "verylongunbrokenidentifierthatshouldnotforcethelayoutoutsideofthenativewindowbounds",
    ].join(" ");

    const { container } = render(
      <ConversationFeed
        visibleMessages={[
          {
            id: "wide-user-message",
            role: "user",
            content: longMessage,
          },
        ]}
        bottomRef={{ current: null }}
        onRetryTask={() => {}}
        onContinueTask={() => {}}
        onOpenWorkspaceFile={() => {}}
        voicePlayback={{
          supported: false,
          speakingMessageId: null,
          onSpeakMessage: () => {},
          onStopSpeaking: () => {},
        }}
      />,
    );

    expect(container.firstElementChild?.className).toContain("min-w-0");

    const messageText = screen.getByText(longMessage);
    const messageBubble = messageText.closest(".app-message-bubble");

    expect(messageText.className).toContain("wrap-break-word");
    expect(messageBubble?.className).toContain("min-w-0");
    expect(messageBubble?.className).toContain("overflow-hidden");
  });

  it("hides legacy generated attachment instructions in user messages", () => {
    render(
      <ConversationFeed
        visibleMessages={[
          {
            id: "legacy-user-message",
            role: "user",
            content:
              'Help me turn this screenshot into a short product update\n\nUse this image: "\\\\?\\C:\\Users\\ehrha\\Downloads\\ShutterCount.png"',
          },
        ]}
        bottomRef={{ current: null }}
        onRetryTask={() => {}}
        onContinueTask={() => {}}
        onOpenWorkspaceFile={() => {}}
        voicePlayback={{
          supported: false,
          speakingMessageId: null,
          onSpeakMessage: () => {},
          onStopSpeaking: () => {},
        }}
      />,
    );

    expect(
      screen.getByText("Help me turn this screenshot into a short product update"),
    ).toBeDefined();
    expect(screen.queryByText(/Use this image/i)).toBeNull();
  });

  it("visually separates insight metadata from task action buttons", () => {
    const execution = {
      ...createMockExecutionFixture(
        "scan this workspace and explain the setup",
        "/mocked/tauri/path",
      ),
      status: "executed" as const,
      response: {
        markdown: "**Done.**",
        highlights: [],
        relatedFiles: [],
        verification: ["Ran focused UI checks.", "Built the UI bundle."],
        followUps: [],
      },
      autopilot: {
        executorIterations: 2,
        validatorPasses: 1,
        continuationCount: 2,
        maxExecutorIterations: 16,
        decisions: [],
      },
    };

    render(
      <ExecutionInsightRow
        execution={execution}
        onOpenWorkspaceFile={() => {}}
        onContinueTask={() => {}}
      />,
    );

    const autoReviewBadge = screen
      .getByText(/Auto review/i)
      .closest("[data-slot='badge']");
    const checksBadge = screen
      .getByText(/2 checks/i)
      .closest("[data-slot='badge']");
    const continueButton = screen.getByRole("button", { name: /Continue/i });

    expect(autoReviewBadge?.className).toContain("bg-transparent");
    expect(checksBadge?.className).toContain("cursor-default");
    expect(continueButton.className).toContain("rounded-lg");
    expect(continueButton.className).toContain("shadow-sm");
  });

  it("shows the AI context cutoff before the first included message", () => {
    render(
      <ConversationFeed
        visibleMessages={[
          {
            id: "message-1",
            role: "user",
            content: "First",
          },
          {
            id: "message-2",
            role: "agent",
            content: "Second",
          },
          {
            id: "message-3",
            role: "user",
            content: "Third",
          },
          {
            id: "message-4",
            role: "agent",
            content: "Fourth",
          },
        ]}
        aiContextMessageLimit={2}
        bottomRef={{ current: null }}
        onRetryTask={() => {}}
        onContinueTask={() => {}}
        onOpenWorkspaceFile={() => {}}
        voicePlayback={{
          supported: false,
          speakingMessageId: null,
          onSpeakMessage: () => {},
          onStopSpeaking: () => {},
        }}
      />,
    );

    const cutoff = screen.getByRole("separator", {
      name: /AI context starts here/i,
    });

    expect(cutoff.textContent).toContain("last 2 messages");
    expect(
      Boolean(
        screen.getByText("Second").compareDocumentPosition(cutoff) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
    expect(
      Boolean(
        cutoff.compareDocumentPosition(screen.getByText("Third")) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
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
    "merges session memory updates returned by completed tasks",
    async () => {
      const memoryEntry = {
        id: "session-memory-1",
        scope: "session" as const,
        content: "The user prefers concise implementation summaries.",
        createdAt: 1_713_260_000_000,
        updatedAt: 1_713_260_000_000,
      };
      const runDesktopTaskSpy = vi
        .spyOn(runtime, "runDesktopTask")
        .mockResolvedValue({
          execution: {
            ...createMockExecutionFixture(
              "remember my implementation summary preference",
              "/mocked/tauri/path",
            ),
            memoryUpdates: [
              {
                scope: "session" as const,
                entry: memoryEntry,
              },
            ],
          },
        });

      render(<ChatSession />);

      const input = screen.getByPlaceholderText(
        /What should machdoch do next\?/i,
      );

      fireEvent.change(input, {
        target: {
          value: "remember my implementation summary preference",
        },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));

      await waitFor(() => {
        expect(runDesktopTaskSpy).toHaveBeenCalledTimes(1);
      });
      await waitFor(() => {
        const storedState = JSON.parse(
          window.localStorage.getItem(SHELL_STATE_STORAGE_KEY) ?? "{}",
        ) as ShellPersistedState;
        const rememberedSession = storedState.sessions?.find((session) =>
          session.sessionMemory.some(
            (entry) => entry.content === memoryEntry.content,
          ),
        );

        expect(rememberedSession?.sessionMemory).toHaveLength(1);
      });

      expect(
        runDesktopTaskSpy.mock.calls[0]?.[2]?.conversationContext,
      ).toMatchObject({
        sessionMemoryEnabled: true,
        sessionMemory: [],
      });

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
      expect(screen.queryByLabelText("Workspace filter")).toBeNull();
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
        within(getSessionRow("Failed session")).getByLabelText(
          "Session status: Failed",
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

      fireEvent.click(screen.getByRole("button", { name: "Status: Done" }));

      expect(
        screen.getByRole("button", { name: "Open session Running session" }),
      ).toBeDefined();
      expect(
        screen.getByRole("button", { name: "Open session Done session" }),
      ).toBeDefined();
      expect(
        screen.queryByRole("button", { name: "Open session Failed session" }),
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

  it("filters sessions by workspace", async () => {
    const baseState = createInitialShellState();
    const now = Date.now();
    const alphaSession = createSession({
      id: "alpha-session",
      manualTitle: "Alpha session",
      workspace: "C:\\Work\\Alpha",
      updatedAt: now - 1_000,
    });
    const betaSession = createSession({
      id: "beta-session",
      manualTitle: "Beta session",
      workspace: "C:\\Work\\Beta",
      updatedAt: now,
    });

    storeShellState({
      ...baseState,
      activeSessionId: alphaSession.id,
      sessions: [alphaSession, betaSession],
    });

    render(<ChatSession />);

    const workspaceFilter = (await screen.findByLabelText(
      "Workspace filter",
    )) as HTMLSelectElement;

    expect(workspaceFilter.value).toBe(ALL_SESSION_PROJECTS_FILTER);
    expect(
      await screen.findByRole("button", { name: "Open session Alpha session" }),
    ).toBeDefined();
    expect(
      await screen.findByRole("button", { name: "Open session Beta session" }),
    ).toBeDefined();

    fireEvent.change(workspaceFilter, {
      target: { value: "c:/work/alpha" },
    });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Open session Alpha session" }),
      ).toBeDefined();
      expect(
        screen.queryByRole("button", { name: "Open session Beta session" }),
      ).toBeNull();
    });

    fireEvent.change(workspaceFilter, {
      target: { value: ALL_SESSION_PROJECTS_FILTER },
    });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Open session Alpha session" }),
      ).toBeDefined();
      expect(
        screen.getByRole("button", { name: "Open session Beta session" }),
      ).toBeDefined();
    });
  }, SLOW_UI_TEST_TIMEOUT_MS);

  it(
    "highlights completed background sessions until they are opened",
    async () => {
      const baseState = createInitialShellState();
      const now = Date.now();
      const activeSession = createSession({
        id: "active-sidebar-session",
        manualTitle: "Active sidebar session",
        updatedAt: now - 4_000,
      });
      const unreadSession = createSession({
        id: "unread-done-session",
        manualTitle: "Unread done session",
        updatedAt: now - 1_000,
        lastReadAt: now - 3_000,
        messages: [
          {
            id: "unread-done-user",
            taskId: "unread-done-task",
            role: "user",
            content: "Finish the background task",
            createdAt: now - 2_000,
          },
          {
            id: "unread-done-agent",
            taskId: "unread-done-task",
            role: "agent",
            content: "Finished the background task",
            createdAt: now - 1_000,
            source: {
              kind: "execution",
              execution: createMockExecutionFixture(
                "Finish the background task",
                "/mocked/tauri/path",
              ),
            },
          },
        ],
      });

      storeShellState({
        ...baseState,
        activeSessionId: activeSession.id,
        sessions: [activeSession, unreadSession],
      });

      render(<ChatSession />);

      const unreadButton = await screen.findByRole("button", {
        name: "Open session Unread done session, new reply ready",
      });
      const unreadRow = unreadButton.parentElement;

      expect(unreadRow?.className).toContain("app-session-card--needs-read");
      expect(
        within(unreadRow as HTMLElement).getByText("New reply"),
      ).toBeDefined();

      fireEvent.click(screen.getByRole("button", { name: "Status: Unread" }));

      const filteredUnreadButton = await screen.findByRole("button", {
        name: "Open session Unread done session, new reply ready",
      });

      expect(
        screen.queryByRole("button", {
          name: "Open session Active sidebar session",
        }),
      ).toBeNull();

      fireEvent.click(filteredUnreadButton);
      fireEvent.click(
        screen.getByRole("button", { name: "Status: Any status" }),
      );

      await waitFor(() => {
        expect(
          screen.getByRole("button", {
            name: "Open session Unread done session",
          }),
        ).toBeDefined();
      });
      expect(screen.queryByText("New reply")).toBeNull();
    },
    SLOW_UI_TEST_TIMEOUT_MS,
  );

  it("keeps the chat rail running badge visible for background sessions", async () => {
    const baseState = createInitialShellState();
    const now = Date.now();
    const activeSession = createSession({
      id: "active-done-rail-session",
      manualTitle: "Active done rail session",
      updatedAt: now,
      messages: [
        {
          id: "active-done-rail-user",
          taskId: "active-done-rail-task",
          role: "user",
          content: "Finish active task",
          createdAt: now - 200,
        },
        {
          id: "active-done-rail-agent",
          taskId: "active-done-rail-task",
          role: "agent",
          content: "Finished active task",
          createdAt: now - 100,
          source: {
            kind: "execution",
            execution: {
              ...createMockExecutionFixture(
                "Finish active task",
                "/mocked/tauri/path",
              ),
              status: "executed",
              summary: "Task finished cleanly.",
            },
          },
        },
      ],
    });
    const backgroundRunningSession = createSession({
      id: "background-running-rail-session",
      manualTitle: "Background running rail session",
      updatedAt: now - 1_000,
      messages: [
        {
          id: "background-running-rail-user",
          taskId: "background-running-rail-task",
          role: "user",
          content: "Keep running in the background",
          createdAt: now - 1_000,
        },
      ],
    });

    storeShellState({
      ...baseState,
      activeSessionId: activeSession.id,
      sessions: [activeSession, backgroundRunningSession],
    });

    render(<ChatSession />);

    expect(
      await screen.findByRole("button", {
        name: "Open session Background running rail session",
      }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Chat, running" }),
    ).toBeDefined();
  });

  it(
    "shows different retention progress bars for open and archived sessions",
    async () => {
      const baseState = createInitialShellState();
      const now = Date.now();
      const openSession = createSession({
        id: "retention-open-session",
        manualTitle: "Open retention session",
        updatedAt: now - 3 * SESSION_RETENTION_DAY_MS,
      });
      const archivedSession = createSession({
        id: "retention-archived-session",
        manualTitle: "Archived retention session",
        archivedAt: now - 3 * SESSION_RETENTION_DAY_MS,
        updatedAt: now - 3 * SESSION_RETENTION_DAY_MS,
      });

      storeShellState({
        ...baseState,
        activeSessionId: openSession.id,
        sessions: [openSession, archivedSession],
      });

      render(<ChatSession />);

      const archiveProgress = await screen.findByLabelText(
        "Auto-archive progress for Open retention session",
        {},
        { timeout: SLOW_UI_TEST_TIMEOUT_MS },
      );
      const archiveBar = archiveProgress.firstElementChild as HTMLElement | null;

      expect(archiveBar).not.toBeNull();
      expect(archiveProgress.className).toContain("h-[2px]");
      expect(archiveBar?.className).toContain("bg-sky-400/70");
      expect(Number.parseInt(archiveBar?.style.width ?? "0", 10)).toBeGreaterThan(
        0,
      );

      fireEvent.click(screen.getByRole("button", { name: "Scope: Archived" }));

      const deleteProgress = await screen.findByLabelText(
        "Auto-delete progress for Archived retention session",
      );
      const deleteBar = deleteProgress.firstElementChild as HTMLElement | null;

      expect(deleteBar).not.toBeNull();
      expect(deleteProgress.className).toContain("h-[2px]");
      expect(deleteProgress.className).toContain("bg-transparent");
      expect(deleteBar?.className).toContain("bg-rose-300/45");
      expect(Number.parseInt(deleteBar?.style.width ?? "0", 10)).toBeGreaterThan(
        0,
      );
    },
    SLOW_UI_TEST_TIMEOUT_MS,
  );

  it(
    "applies session retention cleanup on startup",
    async () => {
      const loadUserDesktopSettingsSpy = vi
        .spyOn(runtime, "loadUserDesktopSettings")
        .mockResolvedValue({
          ...DEFAULT_USER_DESKTOP_SETTINGS,
          inactiveSessionArchiveDays: 1,
          archivedSessionRetentionDays: 1,
        });
      const baseState = createInitialShellState();
      const now = Date.now();
      const freshSession = createSession({
        id: "fresh-retention-session",
        manualTitle: "Fresh retention session",
        updatedAt: now - 10_000,
      });
      const staleOpenSession = createSession({
        id: "stale-open-retention-session",
        manualTitle: "Stale open retention session",
        updatedAt: now - 2 * SESSION_RETENTION_DAY_MS,
      });
      const expiredArchivedSession = createSession({
        id: "expired-archived-retention-session",
        manualTitle: "Expired archived retention session",
        archivedAt: now - 2 * SESSION_RETENTION_DAY_MS,
        updatedAt: now - 2 * SESSION_RETENTION_DAY_MS,
      });

      storeShellState({
        ...baseState,
        activeSessionId: freshSession.id,
        sessions: [
          freshSession,
          staleOpenSession,
          expiredArchivedSession,
        ],
      });

      render(<ChatSession />);

      await waitFor(
        () => {
          expect(
            screen.getByRole("button", {
              name: "Open session Fresh retention session",
            }),
          ).toBeDefined();
          expect(
            screen.queryByRole("button", {
              name: "Open session Stale open retention session",
            }),
          ).toBeNull();
        },
        { timeout: SLOW_UI_TEST_TIMEOUT_MS },
      );

      fireEvent.click(screen.getByRole("button", { name: "Scope: Archived" }));

      expect(
        await screen.findByRole("button", {
          name: "Open session Stale open retention session",
        }),
      ).toBeDefined();
      expect(
        screen.queryByRole("button", {
          name: "Open session Expired archived retention session",
        }),
      ).toBeNull();

      loadUserDesktopSettingsSpy.mockRestore();
    },
    SLOW_UI_TEST_TIMEOUT_MS,
  );

  it(
    "keeps Quick Chat visible at the top without pin or duplicate actions",
    async () => {
      const baseState = createInitialShellState();
      const now = Date.now();
      const quickSession = createSession({
        id: "quick-sidebar-session",
        specialSession: QUICK_VOICE_SESSION_KIND,
        updatedAt: now - 100_000,
      });
      const pinnedSession = createSession({
        id: "pinned-sidebar-session",
        manualTitle: "Pinned session",
        pinnedAt: now - 500,
        updatedAt: now - 50_000,
      });
      const recentSession = createSession({
        id: "recent-sidebar-session",
        manualTitle: "Recent session",
        updatedAt: now,
      });

      storeShellState({
        ...baseState,
        activeSessionId: recentSession.id,
        sessions: [recentSession, pinnedSession, quickSession],
      });

      render(<ChatSession />);

      await waitFor(() => {
        expect(getVisibleSessionButtonLabels()).toEqual([
          "Open session Quick Chat",
          "Open session Pinned session",
          "Open session Recent session",
        ]);
      });

      const quickRow = getSessionRow("Quick Chat");

      expect(
        within(quickRow).queryByRole("button", {
          name: /^(Pin|Unpin) Quick Chat$/i,
        }),
      ).toBeNull();
      expect(
        within(quickRow).queryByRole("button", {
          name: "Duplicate Quick Chat",
        }),
      ).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Status: Running" }));

      await waitFor(() => {
        expect(getVisibleSessionButtonLabels()).toEqual([
          "Open session Quick Chat",
        ]);
      });

      fireEvent.change(screen.getByLabelText("Search sessions"), {
        target: { value: "nothing matches quick chat either" },
      });

      await waitFor(() => {
        expect(getVisibleSessionButtonLabels()).toEqual([
          "Open session Quick Chat",
        ]);
      });
    },
    SLOW_UI_TEST_TIMEOUT_MS,
  );

  it("opens session actions from the row menu and right click", async () => {
    storeShellState(createStoredShellState());

    render(<ChatSession />);

    await screen.findByRole("button", {
      name: "Open session Done session",
    });

    const doneRow = getSessionRow("Done session");

    expect(
      within(doneRow).queryByRole("button", {
        name: "Archive Done session",
      }),
    ).toBeNull();

    const dropdownMenu = await openSessionActionsMenu(
      "Done session",
      DOMRect.fromRect({
        x: 420,
        y: 42,
        width: 24,
        height: 24,
      }),
      DOMRect.fromRect({
        x: 16,
        y: 40,
        width: 292,
        height: 62,
      }),
    );

    expect(
      within(dropdownMenu).getByRole("menuitem", { name: "Archive" }),
    ).toBeDefined();
    expect(dropdownMenu.style.left).toBe("116px");
    expect(dropdownMenu.style.top).toBe("70px");

    fireEvent.contextMenu(doneRow, {
      clientX: 96,
      clientY: 128,
    });

    await waitFor(() => {
      expect(document.querySelector(".app-session-context-menu")).not.toBeNull();
    });

    const contextMenu = document.querySelector(".app-session-context-menu");

    expect(contextMenu).not.toBeNull();
    expect((contextMenu as HTMLElement).style.left).toBe("96px");
    expect((contextMenu as HTMLElement).style.top).toBe("128px");
    expect(
      within(contextMenu as HTMLElement).getByRole("menuitem", {
        name: "Archive",
      }),
    ).toBeDefined();
  });

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

      await openSessionActionsMenu("Done session");
      fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));

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

  it("shows saved provider API key value in settings", async () => {
    const loadUserProviderApiKeysSpy = vi
      .spyOn(runtime, "loadUserProviderApiKeys")
      .mockResolvedValue({
        openai: "openai-user-key-1234567890",
        google: "google-user-key-1234567890",
      });

    render(<ChatSession />);

    fireEvent.click(screen.getByRole("button", { name: /Settings/i }));

    const input = await screen.findByDisplayValue(
      "openai-user-key-1234567890",
    );

    expect((input as HTMLInputElement).type).toBe("password");

    fireEvent.click(
      screen.getByRole("button", { name: /Show OpenAI API key/i }),
    );

    expect((input as HTMLInputElement).type).toBe("text");
    expect(screen.queryByText(/^Saved$/i)).toBeNull();
    expect(screen.queryByText(/^Missing$/i)).toBeNull();

    loadUserProviderApiKeysSpy.mockRestore();
  }, SLOW_UI_TEST_TIMEOUT_MS);

  it("shrinks the Quick Chat popup above the bubble on short screens", async () => {
    monitorFromPoint.mockResolvedValue(createMonitorSnapshot(720));

    const layout = await resolveAssistantSurfaceLayout();

    expect(layout).not.toBeNull();

    if (!layout) {
      return;
    }

    expect(layout.popupSize.height).toBe(552);
    expect(layout.popupPosition.y + layout.popupSize.height + 16).toBeLessThanOrEqual(
      layout.bubblePosition.y,
    );
  });

  it("keeps the preferred Quick Chat popup height on tall screens", async () => {
    monitorFromPoint.mockResolvedValue(createMonitorSnapshot(1000));

    const layout = await resolveAssistantSurfaceLayout();

    expect(layout?.popupSize.height).toBe(720);
  });

  it("omits duplicate Quick Chat activity actions from the popup", async () => {
    const baseState = createInitialShellState();
    const quickSession = createSession({
      id: "quick-chat-session",
      specialSession: QUICK_VOICE_SESSION_KIND,
      updatedAt: 1_713_260_010_000,
      messages: [
        {
          id: "quick-user-message",
          taskId: "quick-task",
          role: "user",
          content: "Summarize open windows",
          createdAt: 1_713_260_000_000,
        },
        {
          id: "quick-agent-message",
          taskId: "quick-task",
          role: "agent",
          content: "All visible windows are summarized.",
          createdAt: 1_713_260_001_000,
        },
      ],
      promptHistory: ["Summarize open windows"],
      sessionMemory: [
        {
          id: "quick-memory",
          scope: "session",
          content: "The quick chat inspected open windows.",
          createdAt: 1_713_260_002_000,
          updatedAt: 1_713_260_002_000,
        },
      ],
    });

    storeShellState({
      ...baseState,
      sessions: [baseState.sessions[0], quickSession],
    });

    render(<AssistantPopupShell />);

    expect(
      await screen.findByText(
        /Summarize open windows/i,
        {},
        { timeout: SLOW_UI_TEST_TIMEOUT_MS },
      ),
    ).toBeDefined();

    expect(
      screen.queryByRole("button", { name: "Clear Quick Chat history" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Cancel running Quick Chat" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Main" })).toBeNull();
  }, SLOW_UI_TEST_TIMEOUT_MS);

  it("clears Quick Chat history from the main window header", async () => {
    const baseState = createInitialShellState();
    const quickSession = createSession({
      id: "quick-main-session",
      specialSession: QUICK_VOICE_SESSION_KIND,
      updatedAt: 1_713_260_010_000,
      messages: [
        {
          id: "quick-main-user",
          taskId: "quick-main-task",
          role: "user",
          content: "Inspect the focused app",
          createdAt: 1_713_260_000_000,
        },
        {
          id: "quick-main-agent",
          taskId: "quick-main-task",
          role: "agent",
          content: "Focused app inspected.",
          createdAt: 1_713_260_001_000,
        },
      ],
      promptHistory: ["Inspect the focused app"],
    });

    storeShellState({
      ...baseState,
      activeSessionId: quickSession.id,
      sessions: [baseState.sessions[0], quickSession],
    });

    render(<ChatSession />);

    expect(
      await screen.findByText(
        /Inspect the focused app/i,
        {},
        { timeout: SLOW_UI_TEST_TIMEOUT_MS },
      ),
    ).toBeDefined();
    expect(
      screen.queryByRole("button", { name: /^Session memory$/i }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Clear Quick Chat history" }),
    );

    await waitFor(() => {
      expect(screen.queryByText(/Inspect the focused app/i)).toBeNull();
      expect(
        screen.getByRole("button", { name: "Clear Quick Chat history" }),
      ).toHaveProperty("disabled", true);
    });
  }, SLOW_UI_TEST_TIMEOUT_MS);

  it("adds dropped files and folders to the main composer", async () => {
    const resolveDroppedPathsSpy = vi
      .spyOn(runtime, "resolveDroppedPaths")
      .mockResolvedValue({
        workspaceRoot: "C:\\Docs",
        entries: [
          {
            path: "C:\\Docs\\plan.md",
            kind: "file",
            name: "plan.md",
            parent: "C:\\Docs",
          },
          {
            path: "C:\\Docs\\references",
            kind: "directory",
            name: "references",
            parent: "C:\\Docs",
          },
        ],
      });

    render(<ChatSession />);

    await waitFor(() => {
      expect(windowDragDropListeners.size).toBeGreaterThan(0);
    });

    emitWindowDropEvent({
      type: "enter",
      paths: ["C:\\Docs\\plan.md"],
      position: { x: 20, y: 20 },
    });

    expect(screen.getByText(/Attach to task/i)).toBeDefined();

    emitWindowDropEvent({
      type: "drop",
      paths: ["C:\\Docs\\plan.md", "C:\\Docs\\references"],
      position: { x: 20, y: 20 },
    });

    const input = screen.getByPlaceholderText(
      /What should machdoch do next\?/i,
    ) as HTMLTextAreaElement;

    await waitFor(() => {
      expect(screen.getByText("plan.md")).toBeDefined();
      expect(screen.getByText("references")).toBeDefined();
    });
    expect(input.value).not.toContain("C:\\Docs\\plan.md");
    expect(input.value).not.toContain("C:\\Docs\\references");
    expect(resolveDroppedPathsSpy).toHaveBeenCalledWith([
      "C:\\Docs\\plan.md",
      "C:\\Docs\\references",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Remove plan.md" }));

    await waitFor(() => {
      expect(screen.queryByText("plan.md")).toBeNull();
    });

    resolveDroppedPathsSpy.mockRestore();
  }, SLOW_UI_TEST_TIMEOUT_MS);

  it("adds dropped links to the main composer", async () => {
    const runDesktopTaskSpy = vi.spyOn(runtime, "runDesktopTask").mockResolvedValue({
      execution: createMockExecutionFixture(
        'Review this link\n\nUse this link: "https://example.com/docs/intro"',
        "/mock/home/path",
      ),
    });
    const openExternalUrlSpy = vi
      .spyOn(runtime, "openExternalUrl")
      .mockResolvedValue();

    render(<ChatSession />);

    const input = screen.getByPlaceholderText(
      /What should machdoch do next\?/i,
    ) as HTMLTextAreaElement;

    dispatchBrowserDrop(
      createDataTransfer({
        "text/uri-list": "https://example.com/docs/intro",
        "text/plain": "https://example.com/docs/intro",
      }),
    );

    await waitFor(() => {
      expect(screen.getByText("example.com/docs/intro")).toBeDefined();
      expect(screen.getByText("link")).toBeDefined();
    });
    expect(input.value).not.toContain("https://example.com/docs/intro");

    fireEvent.change(input, {
      target: { value: "Review this link" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    const sentAttachment = await screen.findByRole("button", {
      name: "Open link example.com/docs/intro",
    });

    fireEvent.click(sentAttachment);

    expect(openExternalUrlSpy).toHaveBeenCalledWith(
      "https://example.com/docs/intro",
    );

    runDesktopTaskSpy.mockRestore();
    openExternalUrlSpy.mockRestore();
  }, SLOW_UI_TEST_TIMEOUT_MS);

  it("adds selected files to the main composer and attaches them on send", async () => {
    openMock.mockResolvedValue(["C:\\Docs\\plan.md"]);
    const resolveDroppedPathsSpy = vi
      .spyOn(runtime, "resolveDroppedPaths")
      .mockResolvedValue({
        workspaceRoot: "C:\\Docs",
        entries: [
          {
            path: "C:\\Docs\\plan.md",
            kind: "file",
            name: "plan.md",
            parent: "C:\\Docs",
          },
        ],
      });
    const runDesktopTaskSpy = vi.spyOn(runtime, "runDesktopTask").mockResolvedValue({
      execution: createMockExecutionFixture(
        'Summarize the plan\n\nUse this file: "C:\\Docs\\plan.md"',
        "C:\\Docs",
      ),
    });
    const openAttachedPathSpy = vi
      .spyOn(runtime, "openAttachedPath")
      .mockResolvedValue();

    render(<ChatSession />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Add context" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Files/i }));

    const input = screen.getByPlaceholderText(
      /What should machdoch do next\?/i,
    ) as HTMLTextAreaElement;

    await waitFor(() => {
      expect(screen.getByText("plan.md")).toBeDefined();
    });
    expect(input.value).not.toContain("C:\\Docs\\plan.md");
    expect(openMock).toHaveBeenCalledWith(
      expect.objectContaining({
        directory: false,
        multiple: true,
        title: "Add Files as Context",
      }),
    );
    expect(resolveDroppedPathsSpy).toHaveBeenCalledWith(["C:\\Docs\\plan.md"]);

    fireEvent.change(input, {
      target: { value: "Summarize the plan" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => {
      expect(runDesktopTaskSpy).toHaveBeenCalledWith(
        "C:\\Docs",
        'Summarize the plan\n\nUse this file: "C:\\Docs\\plan.md"',
        expect.objectContaining({
          model: expect.any(String),
          provider: expect.any(String),
        }),
      );
    });

    const userMessageText = screen
      .getAllByText("Summarize the plan")
      .map((element) => element.closest(".app-user-message-text"))
      .find((element) => element !== null);

    expect(userMessageText).toBeDefined();
    expect(userMessageText?.textContent).not.toContain("Use this file");
    expect(screen.queryByText(/Use this file:/i)).toBeNull();
    expect(screen.queryByText("Attached")).toBeNull();

    const sentAttachment = screen.getByRole("button", {
      name: "Show file plan.md",
    });

    expect(sentAttachment).toBeDefined();
    fireEvent.click(sentAttachment);
    expect(openAttachedPathSpy).toHaveBeenCalledWith(
      "C:\\Docs\\plan.md",
      "C:\\Docs",
    );

    resolveDroppedPathsSpy.mockRestore();
    runDesktopTaskSpy.mockRestore();
    openAttachedPathSpy.mockRestore();
  }, SLOW_UI_TEST_TIMEOUT_MS);

  it("opens attached files directly from the main composer", async () => {
    const baseState = createInitialShellState();
    const session = createSession({
      id: "composer-file-open-session",
      workspace: "C:\\Docs",
      draftContextAttachments: [
        {
          id: "composer-file-attachment",
          path: "C:\\Docs\\plan.md",
          kind: "file",
          name: "plan.md",
          parent: "C:\\Docs",
        },
      ],
    });
    const openAttachedPathSpy = vi
      .spyOn(runtime, "openAttachedPath")
      .mockResolvedValue();

    storeShellState({
      ...baseState,
      activeSessionId: session.id,
      sessions: [session],
    });

    render(<ChatSession />);

    const attachmentButton = await screen.findByRole("button", {
      name: "Show file plan.md",
    });
    fireEvent.click(attachmentButton);

    expect(openAttachedPathSpy).toHaveBeenCalledWith(
      "C:\\Docs\\plan.md",
      "C:\\Docs",
    );

    openAttachedPathSpy.mockRestore();
  }, SLOW_UI_TEST_TIMEOUT_MS);

  it("previews clipboard image attachments directly from the main composer", async () => {
    const baseState = createInitialShellState();
    const imagePath =
      "\\\\?\\C:\\Users\\andreas-ehrhardt\\AppData\\Local\\Temp\\machdoch\\clipboard-images\\image-1782804926429-42976.png";
    const session = createSession({
      id: "composer-image-preview-session",
      workspace: "C:\\Development\\_others\\machdoch",
      draftContextAttachments: [
        {
          id: "composer-image-attachment",
          path: imagePath,
          kind: "image",
          name: "image-1782804926429-42976.png",
          parent:
            "\\\\?\\C:\\Users\\andreas-ehrhardt\\AppData\\Local\\Temp\\machdoch\\clipboard-images",
        },
      ],
    });
    const resolveAttachedImagePreviewSourceSpy = vi
      .spyOn(runtime, "resolveAttachedImagePreviewSource")
      .mockResolvedValue("asset://clipboard-image.png");

    storeShellState({
      ...baseState,
      activeSessionId: session.id,
      sessions: [session],
    });

    render(<ChatSession />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Preview image image-1782804926429-42976.png",
      }),
    );

    await waitFor(() => {
      expect(resolveAttachedImagePreviewSourceSpy).toHaveBeenCalledWith(
        imagePath,
        "C:\\Development\\_others\\machdoch",
      );
    });

    const previewImage = await screen.findByRole("img", {
      name: "Preview of image-1782804926429-42976.png",
    });

    expect(previewImage.getAttribute("src")).toBe("asset://clipboard-image.png");

    resolveAttachedImagePreviewSourceSpy.mockRestore();
  }, SLOW_UI_TEST_TIMEOUT_MS);

  it("adds selected folders to the main composer from the add context menu", async () => {
    openMock.mockResolvedValue(["C:\\Docs\\references"]);
    const resolveDroppedPathsSpy = vi
      .spyOn(runtime, "resolveDroppedPaths")
      .mockResolvedValue({
        workspaceRoot: "C:\\Docs\\references",
        entries: [
          {
            path: "C:\\Docs\\references",
            kind: "directory",
            name: "references",
            parent: "C:\\Docs",
          },
        ],
      });

    render(<ChatSession />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Add context" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Folders/i }));

    await waitFor(() => {
      const attachedContext = screen.getByRole("list", {
        name: "Attached context",
      });

      expect(within(attachedContext).getByText("references")).toBeDefined();
      expect(within(attachedContext).getByText("folder")).toBeDefined();
    });
    expect(openMock).toHaveBeenCalledWith(
      expect.objectContaining({
        directory: true,
        multiple: true,
        title: "Add Folders as Context",
      }),
    );
    expect(resolveDroppedPathsSpy).toHaveBeenCalledWith([
      "C:\\Docs\\references",
    ]);

    resolveDroppedPathsSpy.mockRestore();
  }, SLOW_UI_TEST_TIMEOUT_MS);

  it("adds selected images to the main composer and sends them as image inputs", async () => {
    openMock.mockResolvedValue(["C:\\Docs\\screen.png"]);
    const resolveDroppedPathsSpy = vi
      .spyOn(runtime, "resolveDroppedPaths")
      .mockResolvedValue({
        workspaceRoot: "C:\\Docs",
        entries: [
          {
            path: "C:\\Docs\\screen.png",
            kind: "file",
            name: "screen.png",
            parent: "C:\\Docs",
          },
        ],
      });
    const runDesktopTaskSpy = vi.spyOn(runtime, "runDesktopTask").mockResolvedValue({
      execution: createMockExecutionFixture(
        'Describe the screenshot\n\nUse this image: "C:\\Docs\\screen.png"',
        "C:\\Docs",
      ),
    });
    const openAttachedPathSpy = vi
      .spyOn(runtime, "openAttachedPath")
      .mockResolvedValue();
    const resolveAttachedImagePreviewSourceSpy = vi
      .spyOn(runtime, "resolveAttachedImagePreviewSource")
      .mockResolvedValue("asset://screen.png");

    render(<ChatSession />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Add context" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Images/i }));

    const input = screen.getByPlaceholderText(
      /What should machdoch do next\?/i,
    ) as HTMLTextAreaElement;

    await waitFor(() => {
      const attachedContext = screen.getByRole("list", {
        name: "Attached context",
      });

      expect(within(attachedContext).getByText("screen.png")).toBeDefined();
      expect(within(attachedContext).getByText("image")).toBeDefined();
    });
    expect(openMock).toHaveBeenCalledWith(
      expect.objectContaining({
        directory: false,
        filters: [
          expect.objectContaining({
            name: "Images",
            extensions: expect.arrayContaining(["png", "jpg", "webp"]),
          }),
        ],
        multiple: true,
        title: "Add Images as Context",
      }),
    );

    fireEvent.change(input, {
      target: { value: "Describe the screenshot" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => {
      expect(runDesktopTaskSpy).toHaveBeenCalledWith(
        "C:\\Docs",
        'Describe the screenshot\n\nUse this image: "C:\\Docs\\screen.png"',
        expect.objectContaining({
          imagePaths: ["C:\\Docs\\screen.png"],
        }),
      );
    });

    const userMessageText = screen
      .getAllByText("Describe the screenshot")
      .map((element) => element.closest(".app-user-message-text"))
      .find((element) => element !== null);

    expect(userMessageText).toBeDefined();
    expect(userMessageText?.textContent).not.toContain("Use this image");
    const sentAttachment = screen.getByRole("button", {
      name: "Preview image screen.png",
    });

    expect(sentAttachment).toBeDefined();
    expect(within(sentAttachment).queryByText("image")).toBeNull();
    fireEvent.click(sentAttachment);

    await waitFor(() => {
      expect(resolveAttachedImagePreviewSourceSpy).toHaveBeenCalledWith(
        "C:\\Docs\\screen.png",
        "C:\\Docs",
      );
    });

    const previewImage = await screen.findByRole("img", {
      name: "Preview of screen.png",
    });

    expect(previewImage.getAttribute("src")).toBe("asset://screen.png");
    expect(openAttachedPathSpy).not.toHaveBeenCalled();

    resolveDroppedPathsSpy.mockRestore();
    runDesktopTaskSpy.mockRestore();
    openAttachedPathSpy.mockRestore();
    resolveAttachedImagePreviewSourceSpy.mockRestore();
  }, SLOW_UI_TEST_TIMEOUT_MS);

  it("adds pasted clipboard images to the main composer", async () => {
    const baseState = createInitialShellState();
    const session = createSession({
      id: "clipboard-image-paste-session",
      workspace: "C:\\Project",
    });
    const pastedImage = new File(["image"], "clipboard-image.png", {
      type: "image/png",
    });
    const saveClipboardImageAttachmentSpy = vi
      .spyOn(runtime, "saveClipboardImageAttachment")
      .mockResolvedValue("C:\\Temp\\clipboard-image.png");
    const resolveDroppedPathsSpy = vi
      .spyOn(runtime, "resolveDroppedPaths")
      .mockResolvedValue({
        workspaceRoot: "C:\\Temp",
        entries: [
          {
            path: "C:\\Temp\\clipboard-image.png",
            kind: "file",
            name: "clipboard-image.png",
            parent: "C:\\Temp",
          },
        ],
      });
    const runDesktopTaskSpy = vi.spyOn(runtime, "runDesktopTask").mockResolvedValue({
      execution: createMockExecutionFixture(
        'Describe the pasted image\n\nUse this image: "C:\\Temp\\clipboard-image.png"',
        "C:\\Project",
      ),
    });

    storeShellState({
      ...baseState,
      activeSessionId: session.id,
      sessions: [session],
    });

    render(<ChatSession />);
    await flushShellHydration();

    const input = screen.getByPlaceholderText(
      /What should machdoch do next\?/i,
    ) as HTMLTextAreaElement;

    fireEvent.paste(input, {
      clipboardData: {
        files: [pastedImage],
        items: [
          {
            kind: "file",
            type: "image/png",
            getAsFile: () => pastedImage,
          },
        ],
      },
    });

    await waitFor(() => {
      const attachedContext = screen.getByRole("list", {
        name: "Attached context",
      });

      expect(within(attachedContext).getByText("clipboard-image.png")).toBeDefined();
      expect(within(attachedContext).getByText("image")).toBeDefined();
    });
    expect(saveClipboardImageAttachmentSpy).toHaveBeenCalledWith({
      blob: pastedImage,
      mediaType: "image/png",
      fileName: "clipboard-image.png",
    });
    expect(resolveDroppedPathsSpy).toHaveBeenCalledWith([
      "C:\\Temp\\clipboard-image.png",
    ]);

    fireEvent.change(input, {
      target: { value: "Describe the pasted image" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => {
      expect(runDesktopTaskSpy).toHaveBeenCalledWith(
        "C:\\Project",
        'Describe the pasted image\n\nUse this image: "C:\\Temp\\clipboard-image.png"',
        expect.objectContaining({
          imagePaths: ["C:\\Temp\\clipboard-image.png"],
        }),
      );
    });

    const userMessageText = screen
      .getAllByText("Describe the pasted image")
      .map((element) => element.closest(".app-user-message-text"))
      .find((element) => element !== null);
    const sentAttachments = screen.getByRole("list", {
      name: "Attached files",
    });

    expect(userMessageText).toBeDefined();
    expect(userMessageText?.textContent).not.toContain("Use this image");
    expect(
      within(sentAttachments).getByRole("button", {
        name: "Preview image clipboard-image.png",
      }),
    ).toBeDefined();
    expect(input.value).toBe("");
    expect(
      screen.queryByRole("list", {
        name: "Attached context",
      }),
    ).toBeNull();

    saveClipboardImageAttachmentSpy.mockRestore();
    resolveDroppedPathsSpy.mockRestore();
    runDesktopTaskSpy.mockRestore();
  }, SLOW_UI_TEST_TIMEOUT_MS);

  it("applies workspace context packs to the main composer", async () => {
    const baseState = createInitialShellState();
    const session = createSession({
      id: "context-pack-session",
      workspace: "C:\\Project",
      draft: "Start from the current diff",
      provider: "openai",
      model: "gpt-5.5",
    });
    const resolveDroppedPathsSpy = vi
      .spyOn(runtime, "resolveDroppedPaths")
      .mockResolvedValue({
        workspaceRoot: "C:\\Project",
        entries: [
          {
            path: "C:\\Project\\plan.md",
            kind: "file",
            name: "plan.md",
            parent: "C:\\Project",
          },
        ],
      });
    const runDesktopTaskSpy = vi.spyOn(runtime, "runDesktopTask").mockResolvedValue({
      execution: createMockExecutionFixture(
        [
          "Start from the current diff",
          "## Context Pack: Review PR",
          "### Instructions",
          "Focus on regressions.",
          "### Prompt",
          "Review the staged changes.",
          'Use this file: "C:\\Project\\plan.md"',
        ].join("\n"),
        "C:\\Project",
      ),
    });

    storeShellState({
      ...baseState,
      activeSessionId: session.id,
      sessions: [session],
      contextPacks: [
        {
          id: "review-pr-pack",
          workspace: "C:\\Project",
          name: "Review PR",
          instructions: "Focus on regressions.",
          prompt: "Review the staged changes.",
          contextAttachments: [
            {
              id: "pack-plan",
              path: "C:\\Project\\plan.md",
              kind: "file",
              name: "plan.md",
              parent: "C:\\Project",
            },
          ],
          variables: [],
          trigger: {
            phrases: [],
            pathPatterns: [],
            autoApply: false,
          },
          provider: "openai",
          model: "gpt-5.5",
          mode: "machdoch",
          createdAt: 1,
          updatedAt: 2,
          useCount: 1,
        },
        {
          id: "other-workspace-pack",
          workspace: "C:\\Other",
          name: "Debug build",
          instructions: "",
          prompt: "Debug the build",
          contextAttachments: [],
          variables: [],
          trigger: {
            phrases: [],
            pathPatterns: [],
            autoApply: false,
          },
          createdAt: 1,
          updatedAt: 1,
          useCount: 0,
        },
      ],
    });

    render(<ChatSession />);
    await flushShellHydration();

    fireEvent.click(screen.getByRole("button", { name: "Context packs" }));

    expect(await screen.findByText("Review PR")).toBeDefined();
    expect(screen.queryByText("Debug build")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Apply context pack Review PR" }),
    );

    const input = screen.getByPlaceholderText(
      /What should machdoch do next\?/i,
    ) as HTMLTextAreaElement;

    await waitFor(() => {
      expect(input.value).toContain("## Context Pack: Review PR");
      expect(input.value).toContain("### Instructions\nFocus on regressions.");
      expect(input.value).toContain("### Prompt\nReview the staged changes.");
      expect(input.value).toContain("## Current Task\nStart from the current diff");
      expect(input.value.startsWith("## Context Pack: Review PR")).toBe(true);
      expect(screen.getByText("plan.md")).toBeDefined();
    });
    expect(
      screen.getByRole("button", { name: "Execution mode: Machdoch" }),
    ).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => {
      expect(runDesktopTaskSpy).toHaveBeenCalledWith(
        "C:\\Project",
        expect.stringContaining('Use this file: "C:\\Project\\plan.md"'),
        expect.objectContaining({
          mode: "machdoch",
          model: "gpt-5.5",
          provider: "openai",
        }),
      );
    });

    const submittedTask = runDesktopTaskSpy.mock.calls[0]?.[1] ?? "";

    expect(submittedTask.startsWith("## Context Pack: Review PR")).toBe(true);
    expect(submittedTask).toContain("## Context Pack: Review PR");
    expect(submittedTask).toContain("### Instructions\nFocus on regressions.");
    expect(submittedTask).toContain("### Prompt\nReview the staged changes.");
    expect(submittedTask).toContain(
      "## Current Task\nStart from the current diff",
    );

    resolveDroppedPathsSpy.mockRestore();
    runDesktopTaskSpy.mockRestore();
  }, SLOW_UI_TEST_TIMEOUT_MS);

  it("saves the current composer setup as a workspace context pack", async () => {
    const baseState = createInitialShellState();
    const session = createSession({
      id: "save-context-pack-session",
      workspace: "C:\\Project",
      draft: "Audit frontend layout",
      provider: "openai",
      model: "gpt-5.5",
      draftContextAttachments: [
        {
          id: "layout-shot",
          path: "C:\\Project\\layout.png",
          kind: "image",
          name: "layout.png",
          parent: "C:\\Project",
        },
      ],
    });

    storeShellState({
      ...baseState,
      activeSessionId: session.id,
      sessions: [session],
    });

    render(<ChatSession />);
    await flushShellHydration();

    fireEvent.click(screen.getByRole("button", { name: "Context packs" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));

    const nameInput = screen.getByPlaceholderText("Review PR") as HTMLInputElement;
    const instructionsInput = screen.getByPlaceholderText(
      /Focus on regressions/i,
    ) as HTMLTextAreaElement;

    expect(nameInput.value).toBe("Audit frontend layout");

    fireEvent.change(nameInput, {
      target: { value: "Frontend QA" },
    });
    fireEvent.change(instructionsInput, {
      target: {
        value:
          "Check {target_view} responsive layout and visual regressions.",
      },
    });
    fireEvent.change(
      screen.getByPlaceholderText("ticket_id, target_file, test_command"),
      {
      target: { value: "target_view" },
      },
    );
    fireEvent.change(
      screen.getByPlaceholderText("review pr, frontend qa, debug build"),
      {
      target: { value: "frontend qa" },
      },
    );
    fireEvent.change(
      screen.getByPlaceholderText("*.tsx, src/ui/**, package.json"),
      {
        target: { value: "*.tsx" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save pack" }));

    await waitFor(() => {
      const storedState = JSON.parse(
        window.localStorage.getItem(SHELL_STATE_STORAGE_KEY) ?? "{}",
      ) as ShellPersistedState;
      const savedPack = storedState.contextPacks.find(
        (pack) => pack.name === "Frontend QA",
      );

      expect(savedPack).toMatchObject({
        workspace: "C:\\Project",
        instructions:
          "Check {target_view} responsive layout and visual regressions.",
        prompt: "Audit frontend layout",
        variables: [{ name: "target_view" }],
        trigger: {
          phrases: ["frontend qa"],
          pathPatterns: ["*.tsx"],
          autoApply: false,
        },
        provider: "openai",
        model: "gpt-5.5",
        mode: "machdoch",
        useCount: 0,
      });
      expect(savedPack?.contextAttachments).toMatchObject([
        {
          path: "C:\\Project\\layout.png",
          kind: "image",
          name: "layout.png",
          parent: "C:\\Project",
        },
      ]);
    });
  }, SLOW_UI_TEST_TIMEOUT_MS);

  it("applies context packs with variable values", async () => {
    const baseState = createInitialShellState();
    const session = createSession({
      id: "variable-pack-session",
      workspace: "C:\\Project",
      draft: "Focus on the changed component",
      provider: "openai",
      model: "gpt-5.5",
    });

    storeShellState({
      ...baseState,
      activeSessionId: session.id,
      sessions: [session],
      contextPacks: [
        {
          id: "variable-pack",
          workspace: "C:\\Project",
          name: "Targeted Review",
          instructions: "Review {target_file} for regressions.",
          prompt: "Run {test_command}.",
          contextAttachments: [],
          variables: [
            { name: "target_file" },
            { name: "test_command", defaultValue: "npm test" },
          ],
          trigger: {
            phrases: [],
            pathPatterns: [],
            autoApply: false,
          },
          createdAt: 1,
          updatedAt: 2,
          useCount: 0,
        },
      ],
    });

    render(<ChatSession />);
    await flushShellHydration();

    fireEvent.click(screen.getByRole("button", { name: "Context packs" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Apply context pack Targeted Review",
      }),
    );

    fireEvent.change(screen.getByPlaceholderText("target_file"), {
      target: { value: "src/App.tsx" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply pack" }));

    const input = screen.getByPlaceholderText(
      /What should machdoch do next\?/i,
    ) as HTMLTextAreaElement;

    await waitFor(() => {
      expect(input.value).toContain("Review src/App.tsx for regressions.");
      expect(input.value).toContain("Run npm test.");
      expect(input.value).toContain(
        "## Current Task\nFocus on the changed component",
      );
    });
  }, SLOW_UI_TEST_TIMEOUT_MS);

  it("auto-applies matching trigger packs once", async () => {
    const baseState = createInitialShellState();
    const session = createSession({
      id: "auto-pack-session",
      workspace: "C:\\Project",
      draft: "",
      provider: "openai",
      model: "gpt-5.5",
    });

    storeShellState({
      ...baseState,
      activeSessionId: session.id,
      sessions: [session],
      contextPacks: [
        {
          id: "frontend-qa-pack",
          workspace: "C:\\Project",
          name: "Frontend QA",
          instructions: "Check responsive layout and visual regressions.",
          prompt: "Audit the touched UI surface.",
          contextAttachments: [],
          variables: [],
          trigger: {
            phrases: ["frontend qa"],
            pathPatterns: [],
            autoApply: true,
          },
          createdAt: 1,
          updatedAt: 2,
          useCount: 0,
        },
      ],
    });

    render(<ChatSession />);
    await flushShellHydration();

    const input = screen.getByPlaceholderText(
      /What should machdoch do next\?/i,
    ) as HTMLTextAreaElement;

    fireEvent.change(input, {
      target: { value: "Please run frontend qa on this view" },
    });

    await waitFor(() => {
      expect(input.value.startsWith("## Context Pack: Frontend QA")).toBe(true);
      expect(input.value).toContain(
        "Check responsive layout and visual regressions.",
      );
      expect(input.value).toContain(
        "## Current Task\nPlease run frontend qa on this view",
      );
    });

    await waitFor(() => {
      const storedState = JSON.parse(
        window.localStorage.getItem(SHELL_STATE_STORAGE_KEY) ?? "{}",
      ) as ShellPersistedState;
      const savedPack = storedState.contextPacks.find(
        (pack) => pack.id === "frontend-qa-pack",
      );

      expect(savedPack?.useCount).toBe(1);
    });
  }, SLOW_UI_TEST_TIMEOUT_MS);

  it("saves a prior user message as a context pack", async () => {
    const baseState = createInitialShellState();
    const session = createSession({
      id: "history-pack-session",
      workspace: "C:\\Project",
      provider: "openai",
      model: "gpt-5.5",
      messages: [
        {
          id: "history-message",
          role: "user",
          content: "Review {target_file} before release",
          createdAt: 1,
          contextAttachments: [
            {
              id: "history-file",
              path: "C:\\Project\\src\\App.tsx",
              kind: "file",
              name: "App.tsx",
              parent: "C:\\Project\\src",
            },
          ],
        },
      ],
    });

    storeShellState({
      ...baseState,
      activeSessionId: session.id,
      sessions: [session],
    });

    render(<ChatSession />);
    await flushShellHydration();

    const messageText = await screen.findByText(
      "Review {target_file} before release",
      {
        selector: ".app-user-message-text *",
      },
    );

    expect(
      screen.queryByRole("button", { name: "Save as pack" }),
    ).toBeNull();

    const messageBubble = messageText.closest(".app-message-bubble");

    expect(messageBubble).not.toBeNull();

    fireEvent.contextMenu(messageBubble as Element, {
      clientX: 120,
      clientY: 160,
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "Save as pack" }));

    await waitFor(() => {
      const storedState = JSON.parse(
        window.localStorage.getItem(SHELL_STATE_STORAGE_KEY) ?? "{}",
      ) as ShellPersistedState;
      const savedPack = storedState.contextPacks.find(
        (pack) => pack.prompt === "Review {target_file} before release",
      );

      expect(savedPack).toMatchObject({
        workspace: "C:\\Project",
        name: "Review {target_file} before release",
        variables: [{ name: "target_file" }],
        provider: "openai",
        model: "gpt-5.5",
        mode: "machdoch",
      });
      expect(savedPack?.contextAttachments).toMatchObject([
        {
          path: "C:\\Project\\src\\App.tsx",
          kind: "file",
          name: "App.tsx",
        },
      ]);
    });
  }, SLOW_UI_TEST_TIMEOUT_MS);

  it("imports context pack exports into the active workspace", async () => {
    const baseState = createInitialShellState();
    const session = createSession({
      id: "import-pack-session",
      workspace: "C:\\Project",
      provider: "openai",
      model: "gpt-5.5",
    });
    const payload = {
      kind: "machdoch.context-packs",
      version: 1,
      exportedAt: 10,
      contextPacks: [
        {
          id: "imported-pack",
          workspace: "C:\\Other",
          name: "Imported Pack",
          instructions: "Use imported instructions.",
          prompt: "Imported prompt.",
          contextAttachments: [],
          variables: [],
          trigger: {
            phrases: ["imported"],
            pathPatterns: [],
            autoApply: false,
          },
          createdAt: 1,
          updatedAt: 2,
          useCount: 5,
        },
      ],
    };

    storeShellState({
      ...baseState,
      activeSessionId: session.id,
      sessions: [session],
    });

    render(<ChatSession />);
    await flushShellHydration();

    fireEvent.click(screen.getByRole("button", { name: "Context packs" }));

    const fileInput = screen.getByLabelText(
      "Context pack import file",
    ) as HTMLInputElement;

    fireEvent.change(fileInput, {
      target: {
        files: [
          new File([JSON.stringify(payload)], "context-packs.json", {
            type: "application/json",
          }),
        ],
      },
    });

    await waitFor(() => {
      const storedState = JSON.parse(
        window.localStorage.getItem(SHELL_STATE_STORAGE_KEY) ?? "{}",
      ) as ShellPersistedState;
      const importedPack = storedState.contextPacks.find(
        (pack) => pack.name === "Imported Pack",
      );

      expect(importedPack).toMatchObject({
        workspace: "C:\\Project",
        instructions: "Use imported instructions.",
        prompt: "Imported prompt.",
        trigger: {
          phrases: ["imported"],
          pathPatterns: [],
          autoApply: false,
        },
        useCount: 0,
      });
    });
  }, SLOW_UI_TEST_TIMEOUT_MS);

  it("removes all attached context from the main composer", async () => {
    const baseState = createInitialShellState();
    const session = createSession({
      id: "clear-all-context-session",
      draftContextAttachments: [
        {
          id: "file-attachment",
          path: "C:\\Docs\\plan.md",
          kind: "file",
          name: "plan.md",
          parent: "C:\\Docs",
        },
        {
          id: "folder-attachment",
          path: "C:\\Docs\\references",
          kind: "directory",
          name: "references",
          parent: "C:\\Docs",
        },
        {
          id: "image-attachment",
          path: "C:\\Docs\\screen.png",
          kind: "image",
          name: "screen.png",
          parent: "C:\\Docs",
        },
      ],
    });

    storeShellState({
      ...baseState,
      activeSessionId: session.id,
      sessions: [session],
    });

    render(<ChatSession />);

    await waitFor(() => {
      expect(screen.getByText("plan.md")).toBeDefined();
      expect(screen.getByText("references")).toBeDefined();
      expect(screen.getByText("screen.png")).toBeDefined();
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Remove all attached context" }),
    );

    await waitFor(() => {
      expect(screen.queryByText("plan.md")).toBeNull();
      expect(screen.queryByText("references")).toBeNull();
      expect(screen.queryByText("screen.png")).toBeNull();
    });
  }, SLOW_UI_TEST_TIMEOUT_MS);

  it("disables image sending when the active model cannot read images", async () => {
    const baseState = createInitialShellState();
    const session = createSession({
      id: "unsupported-image-model-session",
      draft: "Describe this",
      model: "gpt-3.5-turbo",
      draftContextAttachments: [
        {
          id: "screen-attachment",
          path: "C:\\Docs\\screen.png",
          kind: "image",
          name: "screen.png",
          parent: "C:\\Docs",
        },
      ],
    });

    storeShellState({
      ...baseState,
      activeSessionId: session.id,
      sessions: [session],
    });

    render(<ChatSession />);

    expect(screen.getByRole("button", { name: "Send message" })).toHaveProperty(
      "disabled",
      true,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Add context" }), {
      button: 0,
      ctrlKey: false,
    });

    expect(
      (await screen.findByRole("menuitem", { name: /Images/i })).getAttribute(
        "aria-disabled",
      ),
    ).toBe("true");
  }, SLOW_UI_TEST_TIMEOUT_MS);

  it("restores attached context with composer history navigation", async () => {
    const baseState = createInitialShellState();
    const session = createSession({
      id: "history-context-session",
      draft: "Continue current review",
      draftContextAttachments: [
        {
          id: "current-attachment",
          path: "C:\\Docs\\current.txt",
          kind: "file",
          name: "current.txt",
          parent: "C:\\Docs",
        },
      ],
      promptHistory: ["Review the plan"],
      promptContextHistory: [
        [
          {
            id: "history-attachment",
            path: "C:\\Docs\\plan.md",
            kind: "file",
            name: "plan.md",
            parent: "C:\\Docs",
          },
        ],
      ],
    });

    storeShellState({
      ...baseState,
      activeSessionId: session.id,
      sessions: [session],
    });

    render(<ChatSession />);

    const input = (await screen.findByPlaceholderText(
      /What should machdoch do next\?/i,
    )) as HTMLTextAreaElement;

    await waitFor(() => {
      expect(input.value).toBe("Continue current review");
      expect(screen.getByText("current.txt")).toBeDefined();
    });

    fireEvent.keyDown(input, { key: "ArrowUp" });

    await waitFor(() => {
      expect(input.value).toBe("Review the plan");
      expect(screen.getByText("plan.md")).toBeDefined();
      expect(screen.queryByText("current.txt")).toBeNull();
    });

    fireEvent.keyDown(input, { key: "ArrowDown" });

    await waitFor(() => {
      expect(input.value).toBe("Continue current review");
      expect(screen.getByText("current.txt")).toBeDefined();
      expect(screen.queryByText("plan.md")).toBeNull();
    });
  }, SLOW_UI_TEST_TIMEOUT_MS);

  it("sends Quick Chat tasks with compact controls and session memory disabled", async () => {
    const loadUserMemorySettingsSpy = vi
      .spyOn(runtime, "loadUserMemorySettings")
      .mockResolvedValue({
        globalEnabled: true,
        entries: [],
      });
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
          "Summarize the attached notes",
          "/mock/home/path",
          { mode: "machdoch" },
        ),
      });

    render(<AssistantPopupShell />);

    expect(
      screen.queryByRole("button", { name: /^Session memory$/i }),
    ).toBeNull();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Global Memory" }),
      ).toHaveProperty("disabled", false);
      expect(
        screen.getByRole("button", { name: "UI Control" }),
      ).toHaveProperty("disabled", false);
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: /Session model: OpenAI GPT-5.5/i,
      }),
    );
    expect(
      await screen.findByText(
        /Latest flagship frontier model for complex reasoning/i,
      ),
    ).toBeDefined();
    expect(
      screen.queryByText(/Best for:/i),
    ).toBeNull();
    fireEvent.click(
      await screen.findByRole("button", {
        name: /Choose OpenAI GPT-5.5/i,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Machdoch" }));
    fireEvent.click(screen.getByRole("button", { name: "UI Control" }));

    const input = await screen.findByPlaceholderText(/Quick Chat/i);

    fireEvent.change(input, {
      target: { value: "Summarize the attached notes" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Send$/i }));

    await waitFor(() => {
      expect(runDesktopTaskSpy).toHaveBeenCalledTimes(1);
    });

    expect(runDesktopTaskSpy).toHaveBeenCalledWith(
      null,
      "Summarize the attached notes",
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.5",
        mode: "machdoch",
        conversationContext: expect.objectContaining({
          sessionMemoryEnabled: false,
          sessionMemory: [],
          globalMemoryEnabled: true,
          uiControlEnabled: true,
        }),
      }),
    );

    loadUserMemorySettingsSpy.mockRestore();
    loadWorkspaceRuntimeSnapshotSpy.mockRestore();
    runDesktopTaskSpy.mockRestore();
  }, SLOW_UI_TEST_TIMEOUT_MS);

  it("cancels a running Quick Chat session from the main window", async () => {
    const baseState = createInitialShellState();
    const quickSession = createSession({
      id: "quick-main-running-session",
      specialSession: QUICK_VOICE_SESSION_KIND,
      updatedAt: 1_713_260_010_000,
      messages: [
        {
          id: "quick-main-running-user",
          taskId: "quick-main-running-task",
          role: "user",
          content: "Summarize the focused window",
          createdAt: 1_713_260_000_000,
        },
      ],
    });
    const cancelDesktopTaskSpy = vi
      .spyOn(runtime, "cancelDesktopTask")
      .mockResolvedValue(undefined);

    storeShellState({
      ...baseState,
      activeSessionId: quickSession.id,
      sessions: [baseState.sessions[0], quickSession],
    });

    render(<ChatSession />);

    fireEvent.click(
      await screen.findByRole(
        "button",
        { name: "Cancel task" },
        { timeout: SLOW_UI_TEST_TIMEOUT_MS },
      ),
    );

    await waitFor(() => {
      expect(cancelDesktopTaskSpy).toHaveBeenCalledWith(
        "quick-main-running-task",
      );
    });
    expect(screen.getByText(/Cancellation requested/i)).toBeDefined();

    cancelDesktopTaskSpy.mockRestore();
  }, SLOW_UI_TEST_TIMEOUT_MS);

  it("cancels running Quick Chat tasks from the popup composer", async () => {
    const runDesktopTaskSpy = vi
      .spyOn(runtime, "runDesktopTask")
      .mockImplementation(
        () => new Promise<DesktopTaskRunResponse>(() => {}),
      );
    const cancelDesktopTaskSpy = vi
      .spyOn(runtime, "cancelDesktopTask")
      .mockResolvedValue(undefined);

    render(<AssistantPopupShell />);

    const input = await screen.findByPlaceholderText(/Quick Chat/i);

    fireEvent.change(input, {
      target: { value: "Count the apples" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Send$/i }));

    await waitFor(() => {
      expect(runDesktopTaskSpy).toHaveBeenCalledTimes(1);
    });

    const taskId = runDesktopTaskSpy.mock.calls[0]?.[2]?.taskId;

    expect(typeof taskId).toBe("string");

    expect(
      await screen.findByRole("button", {
        name: "Cancel Quick Chat",
      }),
    ).toBeDefined();
    expect(
      screen.queryByRole("button", {
        name: "Cancel running Quick Chat",
      }),
    ).toBeNull();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Cancel Quick Chat",
      }),
    );

    await waitFor(() => {
      expect(cancelDesktopTaskSpy).toHaveBeenCalledWith(taskId);
    });

    cancelDesktopTaskSpy.mockRestore();
    runDesktopTaskSpy.mockRestore();
  }, SLOW_UI_TEST_TIMEOUT_MS);

  it("keeps the Quick Chat model independent from the helper window active session", async () => {
    const baseState = createInitialShellState();
    const now = Date.now();
    const mainSession = createSession({
      id: "main-model-session",
      provider: "openai",
      model: "gpt-5.4",
      updatedAt: now - 10_000,
    });
    const quickSession = createSession({
      id: "quick-model-session",
      specialSession: QUICK_VOICE_SESSION_KIND,
      provider: "openai",
      model: "gpt-5.5",
      updatedAt: now,
    });
    const runDesktopTaskSpy = vi
      .spyOn(runtime, "runDesktopTask")
      .mockResolvedValue({
        execution: createMockExecutionFixture(
          "Use the selected quick model",
          "/mock/home/path",
        ),
      });

    storeShellState({
      ...baseState,
      activeSessionId: mainSession.id,
      sessions: [mainSession, quickSession],
    });

    render(<AssistantPopupShell />);

    expect(
      await screen.findByRole("button", {
        name: /Session model: OpenAI GPT-5.5/i,
      }),
    ).toBeDefined();

    const input = await screen.findByPlaceholderText(/Quick Chat/i);

    fireEvent.change(input, {
      target: { value: "Use the selected quick model" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Send$/i }));

    await waitFor(() => {
      expect(runDesktopTaskSpy).toHaveBeenCalledWith(
        null,
        "Use the selected quick model",
        expect.objectContaining({
          provider: "openai",
          model: "gpt-5.5",
        }),
      );
    });

    await waitFor(() => {
      const storedState = JSON.parse(
        window.localStorage.getItem(SHELL_STATE_STORAGE_KEY) ?? "null",
      ) as ShellPersistedState | null;
      const storedQuickSession = storedState?.sessions.find(
        (session) => session.specialSession === QUICK_VOICE_SESSION_KIND,
      );

      expect(storedQuickSession?.model).toBe("gpt-5.5");
    });

    runDesktopTaskSpy.mockRestore();
  }, SLOW_UI_TEST_TIMEOUT_MS);

  it("adds dropped files to the Quick Chat composer", async () => {
    const resolveDroppedPathsSpy = vi
      .spyOn(runtime, "resolveDroppedPaths")
      .mockResolvedValue({
        workspaceRoot: "C:\\Docs",
        entries: [
          {
            path: "C:\\Docs\\quick-note.txt",
            kind: "file",
            name: "quick-note.txt",
            parent: "C:\\Docs",
          },
        ],
      });

    render(<AssistantPopupShell />);

    await waitFor(() => {
      expect(windowDragDropListeners.size).toBeGreaterThan(0);
    });

    emitWindowDropEvent({
      type: "enter",
      paths: ["C:\\Docs\\quick-note.txt"],
      position: { x: 10, y: 10 },
    });

    expect(screen.getByText(/Attach to Quick Chat/i)).toBeDefined();

    emitWindowDropEvent({
      type: "drop",
      paths: ["C:\\Docs\\quick-note.txt"],
      position: { x: 10, y: 10 },
    });

    const input = (await screen.findByPlaceholderText(
      /Quick Chat/i,
    )) as HTMLTextAreaElement;

    await waitFor(() => {
      expect(screen.getByText("quick-note.txt")).toBeDefined();
    });
    expect(input.value).not.toContain("C:\\Docs\\quick-note.txt");

    expect(resolveDroppedPathsSpy).toHaveBeenCalledWith([
      "C:\\Docs\\quick-note.txt",
    ]);

    resolveDroppedPathsSpy.mockRestore();
  }, SLOW_UI_TEST_TIMEOUT_MS);

  it("adds dropped text to the Quick Chat composer", async () => {
    render(<AssistantPopupShell />);

    const input = (await screen.findByPlaceholderText(
      /Quick Chat/i,
    )) as HTMLTextAreaElement;

    dispatchBrowserDrop(
      createDataTransfer({
        "text/plain": "Summarize this dropped text.",
      }),
    );

    await waitFor(() => {
      expect(input.value).toBe("Summarize this dropped text.");
    });
  }, SLOW_UI_TEST_TIMEOUT_MS);

  it("adds selected files to the Quick Chat composer from the add context button", async () => {
    openMock.mockResolvedValue(["C:\\Docs\\quick-note.txt"]);
    const resolveDroppedPathsSpy = vi
      .spyOn(runtime, "resolveDroppedPaths")
      .mockResolvedValue({
        workspaceRoot: "C:\\Docs",
        entries: [
          {
            path: "C:\\Docs\\quick-note.txt",
            kind: "file",
            name: "quick-note.txt",
            parent: "C:\\Docs",
          },
        ],
      });
    const runDesktopTaskSpy = vi
      .spyOn(runtime, "runDesktopTask")
      .mockResolvedValue({
        execution: createMockExecutionFixture(
          'Summarize it\n\nUse this file: "C:\\Docs\\quick-note.txt"',
          "C:\\Docs",
        ),
      });
    const openAttachedPathSpy = vi
      .spyOn(runtime, "openAttachedPath")
      .mockResolvedValue();

    render(<AssistantPopupShell />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Add context" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Files/i }));

    const input = (await screen.findByPlaceholderText(
      /Quick Chat/i,
    )) as HTMLTextAreaElement;

    await waitFor(() => {
      expect(screen.getByText("quick-note.txt")).toBeDefined();
    });
    expect(input.value).not.toContain("C:\\Docs\\quick-note.txt");
    expect(openMock).toHaveBeenCalledWith(
      expect.objectContaining({
        directory: false,
        multiple: true,
        title: "Add Files as Context",
      }),
    );
    expect(resolveDroppedPathsSpy).toHaveBeenCalledWith([
      "C:\\Docs\\quick-note.txt",
    ]);

    fireEvent.click(
      screen.getByRole("button", { name: "Show file quick-note.txt" }),
    );
    expect(openAttachedPathSpy).toHaveBeenCalledWith(
      "C:\\Docs\\quick-note.txt",
      "C:\\Docs",
    );

    fireEvent.change(input, {
      target: { value: "Summarize it" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Send$/i }));

    await waitFor(() => {
      expect(runDesktopTaskSpy).toHaveBeenCalledWith(
        "C:\\Docs",
        'Summarize it\n\nUse this file: "C:\\Docs\\quick-note.txt"',
        expect.objectContaining({
          provider: expect.any(String),
          model: expect.any(String),
        }),
      );
      expect(screen.queryByText("quick-note.txt")).toBeNull();
    });

    resolveDroppedPathsSpy.mockRestore();
    runDesktopTaskSpy.mockRestore();
    openAttachedPathSpy.mockRestore();
  }, SLOW_UI_TEST_TIMEOUT_MS);

  it("adds selected images to the Quick Chat composer and sends them as image inputs", async () => {
    openMock.mockResolvedValue(["C:\\Docs\\quick-screen.png"]);
    const resolveDroppedPathsSpy = vi
      .spyOn(runtime, "resolveDroppedPaths")
      .mockResolvedValue({
        workspaceRoot: "C:\\Docs",
        entries: [
          {
            path: "C:\\Docs\\quick-screen.png",
            kind: "file",
            name: "quick-screen.png",
            parent: "C:\\Docs",
          },
        ],
      });
    const runDesktopTaskSpy = vi
      .spyOn(runtime, "runDesktopTask")
      .mockResolvedValue({
        execution: createMockExecutionFixture(
          'Describe it\n\nUse this image: "C:\\Docs\\quick-screen.png"',
          "C:\\Docs",
        ),
      });

    render(<AssistantPopupShell />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Add context" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Images/i }));

    const input = (await screen.findByPlaceholderText(
      /Quick Chat/i,
    )) as HTMLTextAreaElement;

    await waitFor(() => {
      expect(screen.getByText("quick-screen.png")).toBeDefined();
      expect(screen.getByText("image")).toBeDefined();
    });
    expect(openMock).toHaveBeenCalledWith(
      expect.objectContaining({
        directory: false,
        multiple: true,
        title: "Add Images as Context",
      }),
    );

    fireEvent.change(input, {
      target: { value: "Describe it" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Send$/i }));

    await waitFor(() => {
      expect(runDesktopTaskSpy).toHaveBeenCalledWith(
        "C:\\Docs",
        'Describe it\n\nUse this image: "C:\\Docs\\quick-screen.png"',
        expect.objectContaining({
          imagePaths: ["C:\\Docs\\quick-screen.png"],
        }),
      );
    });

    resolveDroppedPathsSpy.mockRestore();
    runDesktopTaskSpy.mockRestore();
  }, SLOW_UI_TEST_TIMEOUT_MS);

  it("adds pasted clipboard images to the Quick Chat composer", async () => {
    const pastedImage = new File(["image"], "quick-clipboard.png", {
      type: "image/png",
    });
    const saveClipboardImageAttachmentSpy = vi
      .spyOn(runtime, "saveClipboardImageAttachment")
      .mockResolvedValue("C:\\Temp\\quick-clipboard.png");
    const resolveDroppedPathsSpy = vi
      .spyOn(runtime, "resolveDroppedPaths")
      .mockResolvedValue({
        workspaceRoot: "C:\\Temp",
        entries: [
          {
            path: "C:\\Temp\\quick-clipboard.png",
            kind: "file",
            name: "quick-clipboard.png",
            parent: "C:\\Temp",
          },
        ],
      });

    render(<AssistantPopupShell />);

    const input = (await screen.findByPlaceholderText(
      /Quick Chat/i,
    )) as HTMLTextAreaElement;

    fireEvent.paste(input, {
      clipboardData: {
        files: [pastedImage],
        items: [
          {
            kind: "file",
            type: "image/png",
            getAsFile: () => pastedImage,
          },
        ],
      },
    });

    await waitFor(() => {
      expect(screen.getByText("quick-clipboard.png")).toBeDefined();
      expect(screen.getByText("image")).toBeDefined();
    });
    expect(saveClipboardImageAttachmentSpy).toHaveBeenCalledWith({
      blob: pastedImage,
      mediaType: "image/png",
      fileName: "quick-clipboard.png",
    });
    expect(resolveDroppedPathsSpy).toHaveBeenCalledWith([
      "C:\\Temp\\quick-clipboard.png",
    ]);

    saveClipboardImageAttachmentSpy.mockRestore();
    resolveDroppedPathsSpy.mockRestore();
  }, SLOW_UI_TEST_TIMEOUT_MS);

  it("removes all attached context from the Quick Chat composer", async () => {
    openMock.mockResolvedValue(["C:\\Docs\\quick-note.txt"]);
    const resolveDroppedPathsSpy = vi
      .spyOn(runtime, "resolveDroppedPaths")
      .mockResolvedValue({
        workspaceRoot: "C:\\Docs",
        entries: [
          {
            path: "C:\\Docs\\quick-note.txt",
            kind: "file",
            name: "quick-note.txt",
            parent: "C:\\Docs",
          },
          {
            path: "C:\\Docs\\quick-screen.png",
            kind: "file",
            name: "quick-screen.png",
            parent: "C:\\Docs",
          },
        ],
      });

    render(<AssistantPopupShell />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Add context" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Files/i }));

    await waitFor(() => {
      expect(screen.getByText("quick-note.txt")).toBeDefined();
      expect(screen.getByText("quick-screen.png")).toBeDefined();
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Remove all attached context" }),
    );

    await waitFor(() => {
      expect(screen.queryByText("quick-note.txt")).toBeNull();
      expect(screen.queryByText("quick-screen.png")).toBeNull();
    });

    resolveDroppedPathsSpy.mockRestore();
  }, SLOW_UI_TEST_TIMEOUT_MS);

  it("clears running Quick Chat history without restoring the completed task", async () => {
    let resolveTask: ((value: DesktopTaskRunResponse) => void) | null = null;
    const baseState = createInitialShellState();
    const quickSession = createSession({
      id: "quick-running-clear-session",
      specialSession: QUICK_VOICE_SESSION_KIND,
      updatedAt: 1_713_260_010_000,
    });
    const runDesktopTaskSpy = vi
      .spyOn(runtime, "runDesktopTask")
      .mockImplementation(
        () =>
          new Promise<DesktopTaskRunResponse>((resolve) => {
            resolveTask = resolve;
          }),
      );
    const cancelDesktopTaskSpy = vi
      .spyOn(runtime, "cancelDesktopTask")
      .mockResolvedValue(undefined);

    storeShellState({
      ...baseState,
      activeSessionId: quickSession.id,
      sessions: [baseState.sessions[0], quickSession],
    });

    render(<ChatSession />);

    const input = await screen.findByPlaceholderText(
      /What should machdoch do next\?/i,
    );

    fireEvent.change(input, {
      target: { value: "Count the apples" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText(/Count the apples/i)).toBeDefined();

    const clearButton = await screen.findByRole("button", {
      name: "Clear Quick Chat history",
    });

    await waitFor(() => {
      expect(clearButton).toHaveProperty("disabled", false);
    });
    fireEvent.click(clearButton);

    await waitFor(() => {
      expect(cancelDesktopTaskSpy).toHaveBeenCalledWith(
        runDesktopTaskSpy.mock.calls[0]?.[2]?.taskId,
      );
    });

    await waitFor(() => {
      expect(screen.queryByText(/Count the apples/i)).toBeNull();
      expect(screen.getByText(/Ready to automate/i)).toBeDefined();
    });

    vi.useFakeTimers();

    await act(async () => {
      resolveTask?.({
        execution: createMockExecutionFixture(
          "Count the apples",
          "/mock/home/path",
        ),
      });
      await Promise.resolve();
      vi.advanceTimersByTime(250);
      await Promise.resolve();
    });

    expect(screen.queryByText(/Preview only/i)).toBeNull();
    expect(screen.queryByText(/Count the apples/i)).toBeNull();

    cancelDesktopTaskSpy.mockRestore();
    runDesktopTaskSpy.mockRestore();
  }, SLOW_UI_TEST_TIMEOUT_MS);
});
