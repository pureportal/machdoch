import { describe, expect, it, vi } from "vitest";
import type { SessionSidebarCommandState } from "@machdoch/product-ui";
import type { CommandContextSnapshot } from "@machdoch/media-studio/tauri/ui/commands/command-types.js";
import { createSessionSidebarCommands } from "./sidebar-commands";

const context: CommandContextSnapshot = {
  windowKind: "main",
  platform: "windows",
  runtime: "browser",
  activeView: "chat",
  focus: { kind: "document", ownerPath: [] },
  overlays: [],
  singleKeyShortcutsEnabled: false,
  busyCommands: new Set(),
};
const signal = new AbortController().signal;
function fixture(): SessionSidebarCommandState {
  return {
    disabled: false,
    sessions: [
      {
        id: "protected",
        title: "Quick",
        pinned: true,
        tags: [],
        actions: {
          pin: false,
          duplicate: false,
          archive: false,
          delete: false,
        },
      },
      {
        id: "empty",
        title: "New session",
        pinned: false,
        workspace: "C:\\work",
        tags: ["Review"],
        actions: { pin: true, duplicate: true, archive: true, delete: true },
      },
      {
        id: "full",
        title: "History",
        pinned: true,
        tags: [],
        actions: { pin: true, duplicate: true, archive: true, delete: false },
      },
    ],
    scope: "all",
    scopeOptions: [
      { id: "all", label: "All" },
      { id: "open", label: "Open" },
    ],
    statuses: ["any"],
    statusOptions: [
      { id: "any", label: "Any status" },
      { id: "failed", label: "Failed" },
    ],
    project: "all",
    projects: [{ id: "work", label: "Work", path: "C:\\work" }],
    tags: ["review"],
    availableTags: ["Review"],
    importSessions: vi.fn(),
    exportSessions: vi.fn(),
    onScopeChange: vi.fn(),
    onStatusToggle: vi.fn(),
    onProjectChange: vi.fn(),
    onTagToggle: vi.fn(),
    onSessionAction: vi.fn(),
  };
}

describe("shared session commands", () => {
  it("uses current sessions and callbacks without exposing protected or nonempty deletion targets", async () => {
    let state = fixture();
    const commands = createSessionSidebarCommands(() => state);
    const deletion = commands.find(
      ({ id }) => id === "chat.sessions.delete.select",
    )!;
    let page = await deletion.children!(context, signal);
    expect(page.groups[0]!.items.map(({ id }) => id)).toEqual(["empty"]);
    const callback = vi.fn();
    state = { ...state, onSessionAction: callback };
    await page.groups[0]!.items[0]!.execute(context, signal);
    expect(callback).toHaveBeenCalledWith("delete", "empty");
    state = { ...state, sessions: [] };
    page = await deletion.children!(context, signal);
    expect(page.groups[0]!.items).toEqual([]);
    expect(deletion.availability!(context).state).toBe("disabled");
  });

  it("reflects pin and case-insensitive tag state and delegates filtering", async () => {
    const state = fixture();
    const commands = createSessionSidebarCommands(() => state);
    const pin = await commands.find(
      ({ id }) => id === "chat.sessions.pin.select",
    )!.children!(context, signal);
    expect(pin.groups[0]!.items.map(({ title }) => title)).toEqual([
      "Pin New session",
      "Unpin History",
    ]);
    const tags = await commands.find(
      ({ id }) => id === "chat.sessions.tag-filter.toggle",
    )!.children!(context, signal);
    expect(tags.groups[0]!.items[0]!.current).toBe(true);
    await tags.groups[0]!.items[0]!.execute(context, signal);
    expect(state.onTagToggle).toHaveBeenCalledWith("Review");
    const statuses = await commands.find(
      ({ id }) => id === "chat.sessions.status-filter.toggle",
    )!.children!(context, signal);
    expect(statuses.groups[0]!.items[0]!.current).toBe(true);
    await statuses.groups[0]!.items[1]!.execute(context, signal);
    expect(state.onStatusToggle).toHaveBeenCalledWith("failed");
  });

  it("shares archive actions and prevents unavailable or busy actions", async () => {
    let state = fixture();
    const commands = createSessionSidebarCommands(() => state);
    const exported = commands.find(({ id }) => id === "chat.sessions.export")!;
    await exported.execute!(context, signal);
    expect(state.exportSessions).toHaveBeenCalledOnce();
    state = { ...state, exportSessions: undefined };
    expect(exported.availability!(context).state).toBe("disabled");
    state = { ...state, disabled: true };
    expect(
      commands.find(({ id }) => id === "chat.sessions.pin.select")!
        .availability!(context).state,
    ).toBe("disabled");
    expect(
      commands.find(({ id }) => id === "chat.sessions.workspace-filter.select")!
        .availability!(context).state,
    ).toBe("disabled");
  });
});
