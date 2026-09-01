// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceMemoryPanel } from "./workspace-memory-panel";

afterEach(() => cleanup());

describe("WorkspaceMemoryPanel", () => {
  it("shows provenance and forgets workspace memory", () => {
    const onForget = vi.fn();
    render(
      createElement(WorkspaceMemoryPanel, {
        entries: [
          {
            id: "memory-1",
            scope: "workspace",
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
        ],
        sourceSessions: [{ id: "session-1", title: "Workspace setup" }],
        loading: false,
        disabled: false,
        error: null,
        onForget,
      }),
    );

    expect(screen.getByText("Package manager: pnpm")).toBeTruthy();
    expect(screen.getByText("Workspace setup")).toBeTruthy();
    expect(document.querySelector("time")?.getAttribute("datetime")).toBe(
      "2026-08-31T14:30:00.000Z",
    );

    fireEvent.click(screen.getByRole("button", { name: "Forget" }));
    expect(onForget).toHaveBeenCalledWith("memory-1");
  });
});
