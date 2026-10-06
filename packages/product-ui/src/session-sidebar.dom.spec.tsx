import type { ProductSession } from "@machdoch/fleet-protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SessionSidebar } from "./session-sidebar";
import { getSessionProjectId } from "./session-sidebar-model";

afterEach(cleanup);

const session = (
  id: string,
  values: Partial<ProductSession> = {},
): ProductSession => ({
  id,
  title: id,
  status: "done",
  workspace: "C:/alpha",
  provider: "langdock",
  model: "gpt-5.5",
  effectiveMode: "ask",
  createdAt: 0,
  updatedAt: 0,
  tags: [],
  messageCount: 2,
  promptHistoryCount: 1,
  attachmentCount: 0,
  canRename: true,
  canDelete: true,
  canArchive: true,
  canPin: true,
  canDuplicate: true,
  canBranch: true,
  ...values,
});

const renderSessions = (sessions: ProductSession[]) =>
  render(
    <SessionSidebar
      sessions={sessions}
      activeSessionId={undefined}
      workspace={undefined}
      pending={false}
      onCommand={vi.fn().mockResolvedValue(true)}
    />,
  );

it("combines workspace and every selected tag while keeping Quick Chat visible", () => {
  renderSessions([
    session("Quick Chat", { specialKind: "quick-voice" }),
    session("Matching", { tags: ["UI", "Urgent"] }),
    session("One tag", { tags: ["UI"] }),
    session("Other workspace", {
      workspace: "C:/beta",
      tags: ["UI", "Urgent"],
    }),
  ]);
  fireEvent.change(screen.getByRole("combobox", { name: "Workspace filter" }), {
    target: { value: getSessionProjectId("C:/alpha") },
  });
  const tagFilter = screen.getByRole("combobox", { name: "Tag filter" });
  fireEvent.change(tagFilter, { target: { value: "UI" } });
  fireEvent.change(tagFilter, { target: { value: "Urgent" } });
  expect(screen.getByText("Matching")).toBeTruthy();
  expect(screen.getByText("Quick Chat")).toBeTruthy();
  expect(screen.queryByText("One tag")).toBeNull();
  expect(screen.queryByText("Other workspace")).toBeNull();
});

it("keeps native group order and a single divider while ranking search matches within each group", () => {
  const view = renderSessions([
    session("Normal", { title: "Alpha normal" }),
    session("Pinned", { title: "Alpha pinned", pinnedAt: 0 }),
    session("Quick Chat", { specialKind: "quick-voice" }),
  ]);
  fireEvent.change(screen.getByRole("textbox", { name: "Search sessions" }), {
    target: { value: "alpha" },
  });
  const rows = [...view.container.querySelectorAll(".m-product-session-item")];
  expect(
    rows.map(
      (row) => row.querySelector(".m-product-session-title")?.textContent,
    ),
  ).toEqual(["Quick Chat", "Alpha pinned", "Alpha normal"]);
  expect(
    rows.filter((row) => row.getAttribute("data-unpinned-divider") === "true"),
  ).toHaveLength(1);
});

it("filters authoritative unread state and combines it with other selected statuses", () => {
  renderSessions([
    session("Read", { unread: false }),
    session("Unread", { unread: true }),
    session("Failed", { status: "failed", unread: false }),
  ]);
  fireEvent.click(
    screen.getByRole("button", { name: "Status: Unread" }),
  );
  expect(screen.getByText("Unread")).toBeTruthy();
  expect(screen.queryByText("Read")).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Status: Failed" }),
  );
  expect(screen.getByText("Failed")).toBeTruthy();
  expect(screen.queryByLabelText("Unread reply")).toBeTruthy();
});
