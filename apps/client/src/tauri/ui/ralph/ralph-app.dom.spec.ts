// @vitest-environment jsdom

import { createElement, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RalphApp } from "./ralph-app";
import type { RalphFlowEditorProps } from "./ralph-flow-editor";

const mocks = vi.hoisted(() => ({
  editor: vi.fn(),
  overview: vi.fn(),
  save: vi.fn(),
}));
vi.mock("./ralph-flow-editor", () => ({
  RalphFlowEditor: (props: RalphFlowEditorProps) => {
    mocks.editor(props);
    const [draft, setDraft] = useState("");
    return createElement("textarea", {
      "aria-label": "Flow draft",
      value: draft,
      onChange: (event: { target: { value: string } }) => {
        setDraft(event.target.value);
        props.onDirtyChange?.(true);
      },
    });
  },
}));
vi.mock("./use-ralph-overview", () => ({ useRalphOverview: mocks.overview }));
vi.mock("../runtime", () => ({
  loadGlobalProviderAvailability: vi.fn().mockResolvedValue([]),
  loadProviderModelCatalog: vi.fn().mockResolvedValue(null),
}));
vi.mock("../settings-transfer", () => ({
  subscribeToSettingsImport: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("../chat-session/components/workspace-picker", () => ({
  WorkspacePicker: () => createElement("div", null, "Workspace picker"),
}));
vi.mock("../lib/shell-store", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/shell-store")>();
  return {
    ...original,
    loadRalphSettings: vi
      .fn()
      .mockResolvedValue({
        ...original.DEFAULT_RALPH_SETTINGS,
        workspaceRoot: "/one",
      }),
    saveRalphSettings: mocks.save,
    loadShellState: vi
      .fn()
      .mockImplementation(async (initial) => ({
        ...initial,
        recentWorkspaces: ["/one", "/two"],
      })),
    subscribeToShellStateChanged: vi.fn().mockResolvedValue(() => {}),
    updateShellStateAtomically: vi.fn().mockResolvedValue(undefined),
    broadcastShellStateChanged: vi.fn().mockResolvedValue(undefined),
  };
});

import {
  createOverviewLibrary,
  createOverviewTask,
} from "./__test__/ralph-overview-fixtures";

beforeEach(() => {
  mocks.editor.mockClear();
  mocks.save.mockImplementation(async (settings) => settings);
  mocks.overview.mockReturnValue({
    libraries: [createOverviewLibrary("/one"), createOverviewLibrary("/two")],
    tasks: [createOverviewTask("/two")],
    tasksLoaded: true,
    taskError: null,
    refresh: vi.fn(),
  });
});
afterEach(cleanup);

describe("RALPH overview navigation", () => {
  it("opens activity in the matching workspace and preserves the editor draft while checking other workspaces", async () => {
    render(createElement(RalphApp, { isActive: true }));
    await waitFor(() =>
      expect(mocks.overview.mock.calls.at(-1)?.[1]).toBe(true),
    );
    expect(mocks.editor).not.toHaveBeenCalled();
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: "Open Release in /two" }),
      ),
    );
    expect(mocks.editor.mock.calls.at(-1)?.[0]).toMatchObject({
      workspaceRoot: "/two",
      initialSelection: {
        flowId: "release",
        scope: "workspace",
        running: true,
      },
      isActive: true,
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Flow draft" }), {
      target: { value: "Unsaved changes" },
    });
    fireEvent.click(screen.getByRole("button", { name: "All workspaces" }));
    expect(screen.queryByRole("textbox", { name: "Flow draft" })).toBeNull();
    expect(mocks.editor.mock.calls.at(-1)?.[0].isActive).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Back to editor" }));
    expect(
      (
        screen.getByRole("textbox", {
          name: "Flow draft",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("Unsaved changes");
  });

  it("does not discard an edited flow when workspace navigation is declined", async () => {
    render(createElement(RalphApp, { isActive: true }));
    await waitFor(() =>
      expect(mocks.overview.mock.calls.at(-1)?.[1]).toBe(true),
    );
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: "Open Release in /two" }),
      ),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Flow draft" }), {
      target: { value: "Keep this" },
    });
    fireEvent.click(screen.getByRole("button", { name: "All workspaces" }));
    vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(
      screen.getByRole("button", { name: "Open Release in one" }),
    );
    expect(window.confirm).toHaveBeenCalledOnce();
    expect(screen.queryByRole("textbox", { name: "Flow draft" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to editor" }));
    expect(
      (
        screen.getByRole("textbox", {
          name: "Flow draft",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("Keep this");
  });
});
