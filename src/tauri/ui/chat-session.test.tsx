import {
    act,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { ChatSession } from "./chat-session";

const { invokeMock, isTauriMock, openMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  isTauriMock: vi.fn(() => true),
  openMock: vi.fn().mockResolvedValue("/mocked/tauri/path"),
}));

const sampleRuntimeSnapshot = {
  workspaceRoot: "/mocked/tauri/path",
  workspaceConfigPath: "/mocked/tauri/path/.machdoch/config.json",
  activeProfile: "default",
  availableProfiles: [{ name: "default", description: "Default profile" }],
  mode: "ask" as const,
  enabledTools: ["filesystem", "shell"] as const,
  provider: "openai" as const,
  model: "gpt-5.4-mini",
  offline: false,
  compatibility: {
    discoverGithubCustomizations: true,
  },
  providerAvailability: [
    { provider: "openai" as const, configured: true },
    { provider: "anthropic" as const, configured: false },
    { provider: "google" as const, configured: false },
  ],
};

let runtimeProviderAvailability = [
  ...sampleRuntimeSnapshot.providerAvailability,
];

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();

  class ResizeObserverMock {
    public observe(): void {
      return undefined;
    }

    public unobserve(): void {
      return undefined;
    }

    public disconnect(): void {
      return undefined;
    }
  }

  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  isTauri: isTauriMock,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: openMock,
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    public async get(): Promise<null> {
      return null;
    }

    public async set(): Promise<void> {
      return undefined;
    }

    public async save(): Promise<void> {
      return undefined;
    }
  },
}));

beforeEach(() => {
  isTauriMock.mockReturnValue(true);
  runtimeProviderAvailability = [...sampleRuntimeSnapshot.providerAvailability];
  invokeMock.mockImplementation(
    (
      command: string,
      payload?: {
        provider?: (typeof sampleRuntimeSnapshot.providerAvailability)[number]["provider"];
        apiKey?: string;
      },
    ) => {
      if (command === "get_runtime_snapshot") {
        return Promise.resolve({
          ...sampleRuntimeSnapshot,
          providerAvailability: runtimeProviderAvailability,
        });
      }

      if (command === "get_global_provider_availability") {
        return Promise.resolve(runtimeProviderAvailability);
      }

      if (command === "set_user_api_key") {
        runtimeProviderAvailability = runtimeProviderAvailability.map(
          (entry) =>
            entry.provider === payload?.provider
              ? { ...entry, configured: true }
              : entry,
        );

        return Promise.resolve(runtimeProviderAvailability);
      }

      return Promise.reject(new Error(`Unexpected invoke command: ${command}`));
    },
  );
  openMock.mockResolvedValue("/mocked/tauri/path");
  window.localStorage.clear();
});

afterEach(() => {
  try {
    act(() => {
      vi.runOnlyPendingTimers();
    });
  } catch (error) {
    void error;
  }
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

  await waitFor(() => {
    expect(
      screen.getByRole("textbox", { name: /Task composer/i }),
    ).not.toHaveProperty("disabled", true);
  });
};

const getComposer = (): HTMLInputElement => {
  return screen.getByRole("textbox", {
    name: /Task composer/i,
  }) as HTMLInputElement;
};

const advanceChatTimers = async (duration: number): Promise<void> => {
  act(() => {
    vi.advanceTimersByTime(duration);
  });
};

describe("ChatSession component", () => {
  it("renders empty state initially", async () => {
    render(<ChatSession />);
    await act(async () => {});
    expect(screen.getByText(/Ready to automate/i)).toBeDefined();
    expect(
      screen.getByText(/Pick a workspace and model to begin your task/i),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "Send message" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("selects a folder via Tauri dialog", async () => {
    render(<ChatSession />);
    await selectWorkspace();

    expect(getComposer()).toBeDefined();
  });

  it("keeps the routing popover available after selecting a workspace", async () => {
    render(<ChatSession />);
    await selectWorkspace();

    const routingButton = screen.getByRole("button", {
      name: /Routing & Workspace/i,
    });

    if (routingButton.getAttribute("aria-expanded") !== "true") {
      fireEvent.click(routingButton);
    }

    await waitFor(() => {
      expect(screen.getByText(/^Workspace$/i)).toBeDefined();
      expect(screen.getByText(/^Session runtime$/i)).toBeDefined();
      expect(screen.getByText(/^Runtime Snapshot$/i)).toBeDefined();
    });
  });

  it("shows only configured providers in the compact model picker", async () => {
    render(<ChatSession />);
    await selectWorkspace();

    fireEvent.click(
      screen.getByRole("button", {
        name: /OpenAI · gpt-5\.4-mini/i,
      }),
    );

    await waitFor(() => {
      expect(screen.getByText(/^Session model$/i)).toBeDefined();
      expect(screen.getByText(/^GPT-5\.4 mini$/i)).toBeDefined();
    });

    expect(screen.queryByText(/^Claude Sonnet 4\.6$/i)).toBeNull();
    expect(screen.queryByText(/^Gemini 2\.5 Flash$/i)).toBeNull();
  });

  it("saves provider keys from the compact setup dialog", async () => {
    render(<ChatSession />);
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: /^Settings$/i }));

    await waitFor(() => {
      expect(screen.getByText(/^Settings$/i)).toBeDefined();
      expect(screen.getByText(/Provider API keys\./i)).toBeDefined();
    });

    expect(screen.queryByText(/No .*\.env/i)).toBeNull();
    expect(screen.queryByText(/Not configured/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^Anthropic$/i }));
    fireEvent.change(
      screen.getByPlaceholderText(/Paste your Anthropic API key/i),
      {
        target: { value: "sk-anthropic" },
      },
    );

    fireEvent.click(screen.getByRole("button", { name: /Save key/i }));

    await waitFor(() => {
      expect(screen.getByText(/Anthropic is ready to use/i)).toBeDefined();
    });

    expect(invokeMock).toHaveBeenCalledWith(
      "set_user_api_key",
      expect.objectContaining({
        provider: "anthropic",
        apiKey: "sk-anthropic",
      }),
    );
  });

  it("shows preview-only execution state for unsupported tasks", async () => {
    render(<ChatSession />);
    await selectWorkspace();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-04-14T12:00:00Z"));

    const input = getComposer();
    fireEvent.input(input, {
      target: { value: "install dependencies and commit the changes" },
    });
    expect(input.value).toBe("install dependencies and commit the changes");

    const sendBtn = screen.getByRole("button", { name: "Send message" });
    expect(sendBtn).toHaveProperty("disabled", false);
    fireEvent.click(sendBtn);

    expect(
      screen.getAllByText("install dependencies and commit the changes").length,
    ).toBeGreaterThan(0);

    await advanceChatTimers(250);
    expect(screen.getByText(/I staged a compact task preview/i)).toBeDefined();
    expect(screen.getAllByText(/Task preview/i).length).toBeGreaterThan(0);

    await advanceChatTimers(500);
    expect(screen.getByText(/still stays in preview mode/i)).toBeDefined();
    expect(screen.getByText(/Task execution/i)).toBeDefined();
    expect(screen.getAllByText(/Preview only/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/provider: openai/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/model: gpt-5.4-mini/i).length).toBeGreaterThan(
      0,
    );
  });

  it("shows executed task state for read-only inspection tasks", async () => {
    render(<ChatSession />);
    await selectWorkspace();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-04-14T12:00:00Z"));

    const input = getComposer();
    fireEvent.input(input, {
      target: { value: "scan this workspace and explain the setup" },
    });
    expect(input.value).toBe("scan this workspace and explain the setup");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await advanceChatTimers(250);
    await advanceChatTimers(500);

    expect(
      screen.getByText(
        /This request maps to the current read-only execution scaffold/i,
      ),
    ).toBeDefined();
    expect(screen.getAllByText(/Executed/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/workspace label:/i)).toBeDefined();
    expect(screen.getAllByText(/model: gpt-5.4-mini/i).length).toBeGreaterThan(
      0,
    );
  });

  it("recalls prompts with ArrowUp and ArrowDown inside the composer", async () => {
    render(<ChatSession />);
    await selectWorkspace();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-04-14T12:00:00Z"));

    const input = getComposer();
    fireEvent.input(input, {
      target: { value: "inspect README.md and summarize the project setup" },
    });
    expect(input.value).toBe(
      "inspect README.md and summarize the project setup",
    );
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await advanceChatTimers(750);

    expect((input as HTMLInputElement).value).toBe("");

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect((input as HTMLInputElement).value).toBe(
      "inspect README.md and summarize the project setup",
    );

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect((input as HTMLInputElement).value).toBe("");
  });
});
