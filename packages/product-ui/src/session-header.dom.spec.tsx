import type { ProductSession } from "@machdoch/fleet-protocol";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionHeader } from "./session-header";

const session: ProductSession = {
  id: "session",
  title: "Original title",
  status: "idle",
  provider: "openai",
  model: "model",
  effectiveMode: "machdoch",
  createdAt: 1,
  updatedAt: 1,
  tags: ["original"],
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

function harness() {
  const onCommand = vi.fn().mockResolvedValue(true);
  const element = (value: ProductSession, pending = false) => (
    <SessionHeader session={value} pending={pending} onCommand={onCommand} />
  );
  const view = render(element(session));
  return {
    onCommand,
    show: (value: ProductSession, pending = false) =>
      view.rerender(element(value, pending)),
  };
}

function rename() {
  fireEvent.click(screen.getByRole("button", { name: "Rename session" }));
  const input = screen.getByRole<HTMLInputElement>("textbox", {
    name: "Session title",
  });
  fireEvent.change(input, { target: { value: "Edited title" } });
  return input;
}

afterEach(cleanup);

describe("session header editing", () => {
  it("preserves an in-progress title when a snapshot refreshes tags", () => {
    const view = harness();
    const input = rename();
    view.show({ ...session, tags: ["refreshed"] });
    expect(input.value).toBe("Edited title");
    expect(view.onCommand).not.toHaveBeenCalled();
  });

  it("cancels renaming on Escape without saving on blur", () => {
    const view = harness();
    fireEvent.keyDown(rename(), { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Session title" })).toBeNull();
    expect(screen.getByRole("heading").textContent).toBe("Original title");
    expect(view.onCommand).not.toHaveBeenCalled();
  });

  it("waits for IME confirmation before committing a title once", async () => {
    const view = harness();
    const input = rename();
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(view.onCommand).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(view.onCommand.mock.calls).toEqual([
      [
        {
          kind: "rename-session",
          sessionId: session.id,
          title: "Edited title",
        },
      ],
    ]);
    await act(async () => {});
  });

  it("commits normalized tags once on Enter and discards a later Escape edit", async () => {
    const view = harness();
    const input = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Session tags",
    });
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "release, release, review" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(view.onCommand.mock.calls).toEqual([
      [
        {
          kind: "tag-session",
          sessionId: session.id,
          tags: ["release", "review"],
        },
      ],
    ]);
    await act(async () => {});
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "discard" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(view.onCommand).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("original");
  });

  it("keeps a rejected title through polling so it can be corrected and retried", async () => {
    const view = harness();
    view.onCommand.mockResolvedValueOnce(false);
    fireEvent.keyDown(rename(), { key: "Enter" });
    await act(async () => {});
    view.show({ ...session, updatedAt: 2 });
    const input = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Session title",
    });
    expect(input.value).toBe("Edited title");
    act(() => input.focus());
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => {});
    expect(view.onCommand).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("textbox", { name: "Session title" })).toBeNull();
  });

  it("keeps rejected tags until a retry succeeds", async () => {
    const view = harness();
    view.onCommand.mockResolvedValueOnce(false);
    const input = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Session tags",
    });
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "release" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => {});
    view.show({ ...session, updatedAt: 2 });
    expect(input.value).toBe("release");
    act(() => input.focus());
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => {});
    expect(view.onCommand).toHaveBeenCalledTimes(2);
  });

  it("blocks lifecycle actions while pending and offers restoration for archived sessions", () => {
    const view = harness();
    view.show({ ...session, archivedAt: 2 }, true);
    const restore = screen.getByRole<HTMLButtonElement>("button", {
      name: "Restore session",
    });
    expect(restore.disabled).toBe(true);
    fireEvent.click(restore);
    fireEvent.click(screen.getByRole("button", { name: "Duplicate session" }));
    expect(view.onCommand).not.toHaveBeenCalled();
    expect(
      screen.getByRole<HTMLInputElement>("textbox", { name: "Session tags" })
        .readOnly,
    ).toBe(true);
    view.show({ ...session, archivedAt: 2 });
    fireEvent.click(restore);
    expect(view.onCommand).toHaveBeenCalledWith({
      kind: "archive-session",
      sessionId: session.id,
    });
  });
});
