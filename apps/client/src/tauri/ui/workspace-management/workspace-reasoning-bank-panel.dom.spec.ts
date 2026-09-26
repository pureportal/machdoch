// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadWorkspaceReasoningBankLessons } from "../runtime";
import { WorkspaceReasoningBankPanel } from "./workspace-reasoning-bank-panel";

vi.mock("../runtime", () => ({
  loadWorkspaceReasoningBankLessons: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WorkspaceReasoningBankPanel", () => {
  it("shows every lesson and recorded usage, including lessons without retrievals", async () => {
    vi.mocked(loadWorkspaceReasoningBankLessons).mockResolvedValue([
      {
        id: "first",
        title: "Check generated bindings",
        description: "Check bindings after schema edits.",
        content: "Regenerate bindings after schema changes.",
        triggerTerms: ["schema"],
        outcome: "success",
        confidence: 0.8,
        evidenceCount: 2,
        helpfulCount: 1,
        harmfulCount: 0,
        retrievalCount: 3,
        lastRetrievedAt: Date.UTC(2026, 8, 25, 12),
        createdAt: Date.UTC(2026, 8, 20),
        updatedAt: Date.UTC(2026, 8, 21),
      },
      {
        id: "second",
        title: "Inspect failures before retrying",
        description: "Use the failure output.",
        content: "Read the failure output before retrying.",
        triggerTerms: ["failure"],
        outcome: "failure",
        confidence: 0.6,
        evidenceCount: 1,
        helpfulCount: 0,
        harmfulCount: 1,
        createdAt: Date.UTC(2026, 8, 22),
        updatedAt: Date.UTC(2026, 8, 23),
      },
    ]);

    render(
      createElement(WorkspaceReasoningBankPanel, { workspaceRoot: "C:/work" }),
    );
    expect(await screen.findByText("Check generated bindings")).toBeTruthy();
    expect(screen.getByText("Inspect failures before retrying")).toBeTruthy();
    expect(
      screen.getByText("Regenerate bindings after schema changes."),
    ).toBeTruthy();
    expect(screen.getByText("Never")).toBeTruthy();
    expect(screen.getByText("Paused")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(
      document.querySelector('time[datetime="2026-09-25T12:00:00.000Z"]'),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Refresh ReasoningBank" }),
    );
    await waitFor(() =>
      expect(loadWorkspaceReasoningBankLessons).toHaveBeenCalledTimes(2),
    );
  });
});
