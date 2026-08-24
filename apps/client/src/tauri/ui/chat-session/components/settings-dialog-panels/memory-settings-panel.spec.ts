// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationMemoryEntry } from "../../../../../core/types.js";
import { MemorySettingsPanel } from "./memory-settings-panel";

const createEntry = (
  id: string,
  scope: "workspace" | "global",
  content: string,
): ConversationMemoryEntry => ({
  id,
  scope,
  key: id,
  kind: "fact",
  content,
  searchTerms: [],
  importance: 3,
  confidence: 1,
  createdAt: 1,
  updatedAt: 1,
});

afterEach(() => cleanup());

describe("MemorySettingsPanel", () => {
  it("shows workspace and global memory with separate forget actions", () => {
    const onForgetGlobal = vi.fn();
    const onForgetWorkspace = vi.fn();

    render(
      createElement(MemorySettingsPanel, {
        setup: {
          settings: {
            globalEnabled: true,
            entries: [
              createEntry("global", "global", "Prefers concise answers"),
            ],
          },
          workspaceRoot: "C:/workspace",
          workspaceEntries: [
            createEntry("workspace", "workspace", "Package manager: pnpm"),
          ],
          saving: false,
          message: null,
          onGlobalEnabledChange: vi.fn(),
          onForgetGlobal,
          onForgetWorkspace,
        },
      }),
    );

    const workspaceSection = screen
      .getByRole("heading", { name: "Workspace memory" })
      .closest("section");
    const globalSection = screen
      .getByRole("heading", { name: "Global memory" })
      .closest("section");

    expect(workspaceSection).not.toBeNull();
    expect(globalSection).not.toBeNull();
    expect(
      within(workspaceSection!).getByText("Package manager: pnpm"),
    ).toBeTruthy();
    expect(
      within(globalSection!).getByText("Prefers concise answers"),
    ).toBeTruthy();

    fireEvent.click(
      within(workspaceSection!).getByRole("button", { name: "Forget" }),
    );
    fireEvent.click(
      within(globalSection!).getByRole("button", { name: "Forget" }),
    );

    expect(onForgetWorkspace).toHaveBeenCalledWith("workspace");
    expect(onForgetGlobal).toHaveBeenCalledWith("global");
  });
});
