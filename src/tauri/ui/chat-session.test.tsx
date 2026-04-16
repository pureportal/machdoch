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
import {
  createInitialShellState,
  createSession,
  type ShellPersistedState,
} from "./chat-session.model";
import { createMockExecutionFixture } from "./preview/fixtures";
import * as runtime from "./runtime";

const { isTauriMock, openMock } = vi.hoisted(() => ({
  isTauriMock: vi.fn(() => true),
  openMock: vi.fn().mockResolvedValue("/mocked/tauri/path"),
}));

class ResizeObserverMock {
  observe(): void {}

  unobserve(): void {}

  disconnect(): void {}
}

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
});

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: isTauriMock,
  invoke: undefined,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: openMock,
}));

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  cleanup();
  isTauriMock.mockReturnValue(true);
  openMock.mockResolvedValue("/mocked/tauri/path");
  openMock.mockClear();
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
  fireEvent.click(screen.getByRole("button", { name: /Routing & Workspace/i }));

  fireEvent.click(screen.getByRole("button", { name: /Select directory/i }));

  await waitFor(() => {
    expect(
      screen.getByRole("button", { name: /Change folder/i }),
    ).toBeDefined();
  });
};

const SHELL_STATE_STORAGE_KEY = "machdoch.desktop.shell-state";

const storeShellState = (state: ShellPersistedState): void => {
  window.localStorage.setItem(SHELL_STATE_STORAGE_KEY, JSON.stringify(state));
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
      expect(screen.queryByText(/Task execution/i)).toBeNull();
      expect(
        screen.getByText(
          /The preview below still shows the likely tools, approvals, and next move/i,
        ),
      ).toBeDefined();
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
