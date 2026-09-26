import type { ProductSnapshot } from "@machdoch/fleet-protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductShell } from "./product-shell";
import type { ComposerDraftStore } from "./use-composer-draft";

vi.mock("./responsive-layout", () => ({
  useMediaQuery: () => false,
  useProductViewport: () => ({ current: null }),
}));
vi.mock("./session-sidebar", () => ({ SessionSidebar: () => null }));
vi.mock("./session-header", () => ({ SessionHeader: () => null }));
vi.mock("./conversation", () => ({ Conversation: () => null }));
vi.mock("./composer", () => ({ Composer: () => null }));
vi.mock("./inspector", () => ({ Inspector: () => null }));
vi.mock("./product-panel", () => ({ ProductPanel: () => null }));

afterEach(cleanup);

const snapshot = (sessionId: string): ProductSnapshot => ({
  sessions: [],
  shell: { activeSessionId: sessionId, sessions: [{ id: sessionId, workspace: null }], visibleMessages: [] },
} as unknown as ProductSnapshot);

describe("pose Chat handoff", () => {
  it("shows the current generated scene in a pose chat", () => {
    const state = snapshot("pose");
    state.shell!.sessions[0]!.specialKind = "pose";
    state.shell!.poseSceneSvg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
    render(<ProductShell instanceName="Test" snapshot={state} error={null} pendingCommands={0} drafts={{} as ComposerDraftStore} onCommand={vi.fn()} onRefresh={vi.fn()} />);
    expect(screen.getByAltText("Current pose scene")).toBeTruthy();
  });
  it("opens a new pose chat with no starting scene", async () => {
    const onCommand = vi.fn().mockResolvedValue(true);
    const props = { instanceName: "Test", mediaHref: "/media", snapshot: snapshot("old"), error: null, pendingCommands: 0, drafts: {} as ComposerDraftStore, onCommand, onRefresh: vi.fn().mockResolvedValue(undefined) };
    const view = render(<ProductShell {...props} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Media Studio" })[0]!);
    const frame = screen.getByTitle("Media Studio") as HTMLIFrameElement;
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { origin: window.location.origin, source: frame.contentWindow, data: { type: "machdoch:pose-chat", map: null } }));
    });
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith({ kind: "create-session", specialKind: "pose" }));
    view.rerender(<ProductShell {...props} snapshot={snapshot("new")} />);
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith({ kind: "update-draft", sessionId: "new", prompt: "Create a pose scene" }));
  });
  it("creates a fresh Chat, clears its workspace, and sends the composed map", async () => {
    const onCommand = vi.fn().mockResolvedValue(true);
    const props = {
      instanceName: "Test",
      mediaHref: "/media",
      snapshot: snapshot("old"),
      error: null,
      pendingCommands: 0,
      drafts: {} as ComposerDraftStore,
      onCommand,
      onRefresh: vi.fn().mockResolvedValue(undefined),
    };
    const view = render(<ProductShell {...props} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Media Studio" })[0]!);
    const frame = screen.getByTitle("Media Studio") as HTMLIFrameElement;
    const map = { aspectRatio: "1:1", people: [
      { pose: "standing", x: 0.3, y: 0.92, scale: 0.8, mirror: false },
      { pose: "sitting", x: 0.7, y: 0.92, scale: 0.8, mirror: false },
    ] };

    act(() => {
      window.dispatchEvent(new MessageEvent("message", { origin: window.location.origin, source: window, data: { type: "machdoch:pose-chat", map } }));
    });
    expect(onCommand).not.toHaveBeenCalled();
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { origin: window.location.origin, source: frame.contentWindow, data: { type: "machdoch:pose-chat", map } }));
    });
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith({ kind: "create-session", specialKind: "pose", poseScene: map }));
    view.rerender(<ProductShell {...props} snapshot={snapshot("new")} />);
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith({ kind: "set-session-mode", sessionId: "new", mode: "machdoch" }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ kind: "update-draft", sessionId: "new" })));
    const draft = onCommand.mock.calls.find(([command]) => command.kind === "update-draft")![0].prompt as string;
    expect(draft).toBe("Refine this pose scene");
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Chat" })[0]!.getAttribute("aria-pressed")).toBe("true"));
  });
});
