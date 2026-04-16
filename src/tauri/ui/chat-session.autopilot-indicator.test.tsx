import {
  act,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { ChatSession } from "./chat-session";
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
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: ResizeObserverMock,
  });
});

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: isTauriMock,
  invoke: undefined,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: openMock,
}));

beforeEach(() => {
  isTauriMock.mockReturnValue(true);
  openMock.mockResolvedValue("/mocked/tauri/path");
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

  vi.useRealTimers();
});

const flushScheduledTaskMessages = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
  });
};

describe("ChatSession autopilot indicator", () => {
  it(
    "shows a subtle review badge instead of inline validation metadata when the validator requested continuation",
    async () => {
      vi.spyOn(runtime, "runDesktopTask").mockResolvedValue({
        execution: {
          ...createMockExecutionFixture(
            "update README.md with an ASCII banner",
            "/mocked/tauri/path",
            { mode: "auto" },
          ),
          summary:
            "Updated `README.md` with a nice ASCII art banner at the top and verified the change in the file.",
          autopilot: {
            executorIterations: 2,
            validatorPasses: 2,
            continuationCount: 1,
            maxExecutorIterations: 4,
            decisions: [
              {
                pass: 1,
                decision: "continue",
                confidence: "high",
                rationale:
                  "The executor changed the file but had not yet verified the visible content.",
                missingRequirements: ["Direct README.md verification"],
                requiredActions: [
                  "Read README.md and confirm the banner is present.",
                ],
              },
              {
                pass: 2,
                decision: "complete",
                confidence: "high",
                rationale: "The executor verified the requested README change.",
                missingRequirements: [],
                requiredActions: [],
              },
            ],
          },
        },
      });

      render(<ChatSession />);
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      vi.setSystemTime(new Date("2026-04-14T12:00:00Z"));

      const input = screen.getByPlaceholderText(
        /What should machdoch do next\?/i,
      );
      fireEvent.change(input, {
        target: { value: "update README.md with an ASCII banner" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));

      await flushScheduledTaskMessages();

      act(() => {
        vi.advanceTimersByTime(250);
      });

      expect(screen.getByText(/Auto review ×1/i)).toBeDefined();
      expect(screen.queryByText(/Autopilot validation:/i)).toBeNull();
      expect(screen.queryByText(/continuation request\(s\)/i)).toBeNull();
    },
    15_000,
  );
});
