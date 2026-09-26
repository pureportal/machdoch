/** @vitest-environment jsdom */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSession,
  type ChatSessionContextAttachment,
} from "../../chat-session.model";
import { TooltipProvider } from "@machdoch/media-studio/tauri/ui/components/ui/tooltip.js";
import { SessionsSidebar, type SessionsSidebarProps } from "./sessions-sidebar";
import {
  ContextAttachmentsList,
  MessageAttachmentsList,
} from "./context-attachments";

const writeText = vi.fn();
const activate = vi.fn();
const noop = () => {};

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  activate.mockReset();
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const renderSessions = () => {
  const props: SessionsSidebarProps = {
    totalSessions: 2,
    activeSessionId: "selected",
    filteredSessions: [
      createSession({ id: "selected", manualTitle: "Selected" }),
      createSession({ id: "target-id", manualTitle: "Complete target title" }),
    ],
    queuedSessionMessages: [],
    sessionScopeFilter: "all",
    sessionStatusFilters: ["any"],
    sessionSearchQuery: "",
    sessionProjectFilter: "all",
    inactiveSessionArchiveDays: 7,
    archivedSessionRetentionDays: 7,
    sessionProjectFacets: [],
    sessionTagFacets: [],
    sessionTagFilters: [],
    onSessionScopeFilterChange: noop,
    onSessionStatusFiltersChange: noop,
    onSessionSearchQueryChange: noop,
    onSessionProjectFilterChange: noop,
    onSessionTagFilterToggle: noop,
    onCreateSession: noop,
    onActivateSession: activate,
    onArchiveSession: noop,
    onDeleteSession: noop,
    onTogglePinnedSession: noop,
    onDuplicateSession: noop,
    onExportSessions: noop,
    onImportSessions: noop,
  };
  return render(
    createElement(TooltipProvider, null, createElement(SessionsSidebar, props)),
  );
};

describe("session and attachment copy menus", () => {
  it("copies the right-clicked session without activating it", async () => {
    renderSessions();
    fireEvent.contextMenu(
      screen.getByRole("button", {
        name: "Open session Complete target title",
      }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Copy session ID" }),
    );
    expect(writeText).toHaveBeenCalledWith("target-id");
    expect(activate).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.click(
      screen.getByRole("button", {
        name: "Session actions for Complete target title",
      }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Copy title" }),
    );
    expect(writeText).toHaveBeenLastCalledWith("Complete target title");
  });

  it("supports keyboard navigation and restores session focus", async () => {
    renderSessions();
    const trigger = screen.getByRole("button", {
      name: "Open session Complete target title",
    });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "F10", shiftKey: true });
    const menu = await screen.findByRole("menu");
    fireEvent.keyDown(menu, { key: "End" });
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("role")).toBe("menuitem"),
    );
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it.each(["composer", "message"])(
    "copies a full attachment path in the %s without opening or removing it",
    async (surface) => {
      const attachment: ChatSessionContextAttachment = {
        id: "file-id",
        source: "path",
        kind: "file",
        name: "example.txt",
        path: "C:/Workspace/long-folder/example.txt",
      };
      const onOpen = vi.fn();
      const onRemove = vi.fn();
      render(
        createElement(
          TooltipProvider,
          null,
          surface === "composer"
            ? createElement(ContextAttachmentsList, {
                attachments: [attachment],
                onOpen,
                onRemove,
                onClearAll: noop,
              })
            : createElement(MessageAttachmentsList, {
                attachments: [attachment],
                onOpen,
              }),
        ),
      );
      fireEvent.contextMenu(
        screen.getByRole("button", { name: "Show file example.txt" }),
      );
      fireEvent.click(
        await screen.findByRole("menuitem", { name: "Copy path" }),
      );
      expect(writeText).toHaveBeenCalledWith(attachment.path);
      expect(onOpen).not.toHaveBeenCalled();
      expect(onRemove).not.toHaveBeenCalled();
    },
  );
});
