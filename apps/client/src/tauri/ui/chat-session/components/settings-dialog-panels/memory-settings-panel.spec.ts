// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationMemoryEntry } from "../../../../../core/types.js";
import { MemorySettingsPanel } from "./memory-settings-panel";

const createEntry = (id: string, content: string): ConversationMemoryEntry => ({
  id,
  scope: "global",
  key: id,
  kind: "fact",
  content,
  searchTerms: [],
  importance: 3,
  confidence: 1,
  sourceSessionId: "session-1",
  createdAt: Date.UTC(2026, 7, 31, 14, 30),
  updatedAt: Date.UTC(2026, 7, 31, 14, 30),
});

afterEach(() => cleanup());

describe("MemorySettingsPanel", () => {
  it("shows global memory with source and creation time", () => {
    const onForgetGlobal = vi.fn();

    render(
      createElement(MemorySettingsPanel, {
        setup: {
          settings: {
            globalEnabled: true,
            entries: [createEntry("global", "Prefers concise answers")],
          },
          sourceSessions: [{ id: "session-1", title: "API review" }],
          saving: false,
          message: null,
          onGlobalEnabledChange: vi.fn(),
          onForgetGlobal,
        },
      }),
    );

    expect(screen.queryByText("Workspace memory")).toBeNull();
    expect(screen.getByText("Prefers concise answers")).toBeTruthy();
    expect(screen.getByText("API review")).toBeTruthy();
    expect(document.querySelector("time")?.getAttribute("datetime")).toBe(
      "2026-08-31T14:30:00.000Z",
    );

    fireEvent.click(screen.getByRole("button", { name: "Forget" }));

    expect(onForgetGlobal).toHaveBeenCalledWith("global");
  });
});
