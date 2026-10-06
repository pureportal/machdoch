import type { ProductSnapshot } from "@machdoch/fleet-protocol";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
vi.mock("./inspector", () => ({ Inspector: () => null }));
vi.mock("./product-panel", () => ({ ProductPanel: () => null }));

afterEach(cleanup);

it("keeps the workspace frame mounted while navigating and changing workspace context", () => {
  const first = snapshot("first");
  first.shell!.sessions[0]!.workspace = "C:\\first";
  const props = {
    instanceName: "Test",
    workspaceHref: "/workspaces?instance=device",
    snapshot: first,
    error: null,
    pendingCommands: 0,
    drafts: {} as ComposerDraftStore,
    onCommand: vi.fn(),
    onRefresh: vi.fn(),
  };
  const view = render(
    <ProductShell Conversation={() => null} Composer={() => null} {...props} />,
  );
  fireEvent.click(
    screen.getAllByRole("button", { name: "Workspace Management" })[0]!,
  );
  const frame = view.container.querySelector<HTMLIFrameElement>(
    'iframe[title="Workspace Management"]',
  )!;
  const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
  fireEvent.click(screen.getAllByRole("button", { name: /^Chat$/ })[0]!);
  expect(
    view.container.querySelector('iframe[title="Workspace Management"]'),
  ).toBe(frame);
  const second = snapshot("second");
  second.shell!.sessions[0]!.workspace = "C:\\second";
  view.rerender(
    <ProductShell
      Conversation={() => null}
      Composer={() => null}
      {...props}
      snapshot={second}
    />,
  );
  expect(
    view.container.querySelector('iframe[title="Workspace Management"]'),
  ).toBe(frame);
  expect(frame.getAttribute("src")).toBe(props.workspaceHref);
  expect(postMessage).toHaveBeenCalledWith(
    { type: "machdoch:workspace-tools-workspace", workspace: "C:\\second" },
    window.location.origin,
  );
});

const snapshot = (sessionId: string): ProductSnapshot =>
  ({
    sessions: [],
    shell: {
      activeSessionId: sessionId,
      sessions: [{ id: sessionId, workspace: null }],
      visibleMessages: [],
    },
  }) as unknown as ProductSnapshot;

it("opens the native Quick Chat and switches to its conversation only after acceptance", async () => {
  const state = snapshot("session");
  state.shell!.quickTask = {
    status: "idle",
    draft: "",
    isExecuting: false,
    provider: "langdock",
    model: "gpt-5.5",
    autopilotEnabled: false,
    globalMemoryEnabled: false,
    uiControlEnabled: false,
    attachmentCount: 0,
  };
  const onCommand = vi.fn().mockResolvedValue(false);
  const view = render(
    <ProductShell
      Conversation={() => null}
      Composer={() => null}
      initialView="instructions"
      instructionsHref="/instructions"
      instanceName="Test"
      snapshot={state}
      error={null}
      pendingCommands={0}
      drafts={{} as ComposerDraftStore}
      onCommand={onCommand}
      onRefresh={vi.fn()}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Quick Chat" }),
  );
  await waitFor(() =>
    expect(onCommand).toHaveBeenCalledWith({ kind: "open-quick-chat" }),
  );
  expect(
    view.container
      .querySelector(".m-product-layout")
      ?.getAttribute("data-view"),
  ).toBe("instructions");
  onCommand.mockResolvedValue(true);
  fireEvent.click(
    screen.getByRole("button", { name: "Quick Chat" }),
  );
  await waitFor(() =>
    expect(
      view.container
        .querySelector(".m-product-layout")
        ?.getAttribute("data-view"),
    ).toBe("chat"),
  );
});

it("hides Quick Chat when the host has no native Quick Chat", () => {
  render(
    <ProductShell
      Conversation={() => null}
      Composer={() => null}
      instanceName="Test"
      snapshot={snapshot("session")}
      error={null}
      pendingCommands={0}
      drafts={{} as ComposerDraftStore}
      onCommand={vi.fn()}
      onRefresh={vi.fn()}
    />,
  );
  expect(
    screen.queryByRole("button", { name: "Quick Chat" }),
  ).toBeNull();
});

it("hands composer requests to the owned Media frame after readiness and acknowledges delivery", async () => {
  const state = snapshot("session");
  state.shell!.composer = { sessionId: "session" } as NonNullable<
    ProductSnapshot["shell"]
  >["composer"];
  const view = render(
    <ProductShell
      Conversation={() => null}
      Composer={({ onBrowseMediaAssets, onCreateMediaAsset }) => (
        <>
          <button onClick={onBrowseMediaAssets}>
            Browse media from composer
          </button>
          <button
            onClick={() => onCreateMediaAsset?.("Unsaved Unicode prompt 🌿")}
          >
            Create media from composer
          </button>
        </>
      )}
      initialView="chat"
      instanceName="Test"
      mediaHref="/media"
      snapshot={state}
      error={null}
      pendingCommands={0}
      drafts={{} as ComposerDraftStore}
      onCommand={vi.fn()}
      onRefresh={vi.fn()}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Browse media from composer" }),
  );
  const frame = view.container.querySelector<HTMLIFrameElement>(
    'iframe[title="Media Studio"]',
  )!;
  const post = vi.spyOn(frame.contentWindow!, "postMessage");
  const ready = (
    source: Window | null = frame.contentWindow,
    origin = window.location.origin,
  ) =>
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin,
          source,
          data: { type: "machdoch:media-ready" },
        }),
      );
    });
  ready(window);
  ready(frame.contentWindow, "https://untrusted.test");
  expect(post).not.toHaveBeenCalled();
  ready();
  expect(post).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: "machdoch:media-compose",
      section: "library",
    }),
    window.location.origin,
  );
  const id = post.mock.calls.at(-1)![0].id;
  await act(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        source: frame.contentWindow,
        data: { type: "machdoch:media-compose-received", id },
      }),
    ),
  );
  post.mockClear();
  ready();
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(screen.getAllByRole("button", { name: /^Chat$/ })[0]!);
  fireEvent.click(
    screen.getByRole("button", { name: "Create media from composer" }),
  );
  expect(view.container.querySelector('iframe[title="Media Studio"]')).toBe(
    frame,
  );
  expect(post).toHaveBeenLastCalledWith(
    expect.objectContaining({
      section: "generate",
      prompt: "Unsaved Unicode prompt 🌿",
    }),
    window.location.origin,
  );
});

describe("pose Chat handoff", () => {
  it("shows the current generated scene in a pose chat", () => {
    const state = snapshot("pose");
    state.shell!.sessions[0]!.specialKind = "pose";
    state.shell!.poseSceneSvg =
      '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
    render(
      <ProductShell
        Conversation={() => null}
        Composer={() => null}
        instanceName="Test"
        snapshot={state}
        error={null}
        pendingCommands={0}
        drafts={{} as ComposerDraftStore}
        onCommand={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByAltText("Current pose scene")).toBeTruthy();
  });
  it("opens a new pose chat with no starting scene", async () => {
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
    const view = render(
      <ProductShell
        Conversation={() => null}
        Composer={() => null}
        {...props}
      />,
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: "Media Studio" })[0]!,
    );
    const frame = screen
      .getAllByTitle("Media Studio")
      .find((element) => element.tagName === "IFRAME") as HTMLIFrameElement;
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          source: frame.contentWindow,
          data: { type: "machdoch:pose-chat", map: null },
        }),
      );
    });
    await waitFor(() =>
      expect(onCommand).toHaveBeenCalledWith({
        kind: "create-session",
        specialKind: "pose",
      }),
    );
    view.rerender(
      <ProductShell
        Conversation={() => null}
        Composer={() => null}
        {...props}
        snapshot={snapshot("new")}
      />,
    );
    await waitFor(() =>
      expect(onCommand).toHaveBeenCalledWith({
        kind: "update-draft",
        sessionId: "new",
        prompt: "Create a pose scene",
      }),
    );
  });
  it("creates a fresh pose Chat and sends the composed map", async () => {
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
    const view = render(
      <ProductShell
        Conversation={() => null}
        Composer={() => null}
        {...props}
      />,
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: "Media Studio" })[0]!,
    );
    const frame = screen
      .getAllByTitle("Media Studio")
      .find((element) => element.tagName === "IFRAME") as HTMLIFrameElement;
    const map = {
      aspectRatio: "1:1",
      people: [
        { pose: "standing", x: 0.3, y: 0.92, scale: 0.8, mirror: false },
        { pose: "sitting", x: 0.7, y: 0.92, scale: 0.8, mirror: false },
      ],
    };

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          source: window,
          data: { type: "machdoch:pose-chat", map },
        }),
      );
    });
    expect(onCommand).not.toHaveBeenCalled();
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          source: frame.contentWindow,
          data: { type: "machdoch:pose-chat", map },
        }),
      );
    });
    await waitFor(() =>
      expect(onCommand).toHaveBeenCalledWith({
        kind: "create-session",
        specialKind: "pose",
        poseScene: map,
      }),
    );
    view.rerender(
      <ProductShell
        Conversation={() => null}
        Composer={() => null}
        {...props}
        snapshot={snapshot("new")}
      />,
    );
    await waitFor(() =>
      expect(onCommand).toHaveBeenCalledWith({
        kind: "set-session-mode",
        sessionId: "new",
        mode: "machdoch",
      }),
    );
    await waitFor(() =>
      expect(onCommand).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "update-draft", sessionId: "new" }),
      ),
    );
    const draft = onCommand.mock.calls.find(
      ([command]) => command.kind === "update-draft",
    )![0].prompt as string;
    expect(draft).toBe("Refine this pose scene");
    await waitFor(() =>
      expect(
        screen
          .getAllByRole("button", { name: "Chat" })[0]!
          .getAttribute("aria-current"),
      ).toBe("page"),
    );
  });
});
