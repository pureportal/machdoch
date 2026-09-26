import type { ProductSession } from "@machdoch/fleet-protocol";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceMenu } from "./composer-menus";

afterEach(cleanup);

const session: ProductSession = {
  id: "session-1",
  title: "Chat",
  status: "idle",
  provider: "openai",
  model: "model",
  effectiveMode: "machdoch",
  createdAt: 1,
  updatedAt: 1,
  tags: [],
  messageCount: 0,
  promptHistoryCount: 0,
  attachmentCount: 0,
  canRename: true,
  canDelete: true,
  canArchive: true,
  canPin: true,
  canDuplicate: true,
  canBranch: true,
};

describe("Fleet workspace selection", () => {
  it("accepts a host folder beyond the recent workspace list", async () => {
    const onCommand = vi.fn().mockResolvedValue(true);
    render(
      <div className="machdoch-product">
        <WorkspaceMenu
          session={session}
          workspaces={[]}
          disabled={false}
          onCommand={onCommand}
        />
      </div>,
    );
    fireEvent.keyDown(
      screen.getByRole("button", { name: "Workspace: No workspace" }),
      {
        key: "ArrowDown",
      },
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Other folder…" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Folder path" }), {
      target: { value: " C:\\Projects\\demo " },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Use folder" }));
    });
    expect(onCommand).toHaveBeenCalledWith({
      kind: "set-session-workspace",
      sessionId: "session-1",
      workspace: "C:\\Projects\\demo",
    });
    expect(
      screen.queryByRole("dialog", { name: "Workspace folder" }),
    ).toBeNull();
  });
});
