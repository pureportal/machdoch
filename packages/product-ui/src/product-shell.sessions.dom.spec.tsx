import { productSnapshotSchema } from "@machdoch/fleet-protocol";
import fixture from "../../fleet-protocol/fixtures/desktop-snapshot.json";
import type { SessionIndexPage } from "@machdoch/fleet-protocol/session-data";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProductShell } from "./product-shell";
import { createComposerDraftStore } from "./use-composer-draft";

vi.mock("./responsive-layout", () => ({
  useMediaQuery: () => true,
  useProductViewport: () => {},
}));

afterEach(cleanup);

function setup(settingsHref?: string, servicesHref?: string) {
  const snapshot = productSnapshotSchema.parse(fixture.response.snapshot);
  snapshot.shell!.sessions = [
    {
      id: "session-1",
      title: "Existing chat",
      status: "done",
      provider: "openai",
      model: "gpt-6",
      effectiveMode: "machdoch",
      createdAt: 1,
      updatedAt: 2,
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
    },
  ];
  snapshot.shell!.activeSessionId = "session-1";
  const page: SessionIndexPage = {
    sessions: snapshot.shell!.sessions,
    sessionIds: snapshot.shell!.sessions.map(({ id }) => id),
    total: snapshot.shell!.sessions.length,
    nextOffset: null,
    projects: [],
    tags: [],
    statuses: [],
  };
  let resolve!: (value: SessionIndexPage) => void;
  let reject!: (error: Error) => void;
  const index = vi.fn(
    () =>
      new Promise<SessionIndexPage>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
      }),
  );
  render(
    <ProductShell
      Composer={() => null}
      Conversation={() => null}
      instanceName="Device"
      initialView="chat"
      settingsHref={settingsHref}
      servicesHref={servicesHref}
      snapshot={snapshot}
      error={null}
      pendingCommands={0}
      drafts={createComposerDraftStore()}
      onCommand={vi.fn().mockResolvedValue(true)}
      onRefresh={vi.fn()}
      sessionData={{ index, export: vi.fn(), import: vi.fn() }}
    />,
  );
  return {
    index,
    page,
    resolve: () => resolve(page),
    reject: () => reject(new Error("Device is unavailable. Retry.")),
  };
}

it("preloads chats before the mobile drawer opens and retains them on reopen", async () => {
  const source = setup();
  expect(screen.queryByRole("dialog", { name: "Sessions" })).toBeNull();
  expect(source.index).toHaveBeenCalledOnce();
  await act(async () => source.resolve());
  fireEvent.click(
    screen.getByRole("button", { name: "Sessions" }),
  );
  const rows = () => document.querySelectorAll(".m-product-session-item");
  expect(rows()).toHaveLength(source.page.sessions.length);
  expect(screen.queryByRole("status", { name: "Loading sessions" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Close sessions" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Sessions" }),
  );
  expect(rows()).toHaveLength(source.page.sessions.length);
  expect(source.index).toHaveBeenCalledOnce();
});

it("keeps a slow request across drawer closes and shows loading until it completes", async () => {
  const source = setup();
  fireEvent.click(
    screen.getByRole("button", { name: "Sessions" }),
  );
  expect(screen.getByRole("status", { name: "Loading sessions" })).toBeTruthy();
  expect(screen.queryByText("No sessions")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Close sessions" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Sessions" }),
  );
  expect(source.index).toHaveBeenCalledOnce();
  await act(async () => source.resolve());
  expect(document.querySelectorAll(".m-product-session-item")).toHaveLength(
    source.page.total,
  );
  expect(screen.queryByRole("status", { name: "Loading sessions" })).toBeNull();
});

it("shows a recoverable load error and distinguishes an empty result from loading", async () => {
  const source = setup();
  fireEvent.click(
    screen.getByRole("button", { name: "Sessions" }),
  );
  await act(async () => source.reject());
  expect(screen.getByRole("alert").textContent).toContain(
    "Device is unavailable",
  );
  expect(screen.queryByText("No sessions")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  source.page.sessions = [];
  source.page.sessionIds = [];
  source.page.total = 0;
  await act(async () => source.resolve());
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(screen.getByRole("status").textContent).toBe("No matching sessions");
});

it("isolates the settings overlay and returns focus when it closes", () => {
  setup("/settings.html");
  const opener = screen.getAllByRole("button", { name: "Settings" }).at(-1)!;
  opener.focus();
  fireEvent.click(opener);
  const frame = document.querySelector<HTMLIFrameElement>(
    ".m-product-settings-frame",
  )!;
  expect(frame).toBeTruthy();
  expect(
    document.querySelector(".m-application-content")?.hasAttribute("inert"),
  ).toBe(true);
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        source: frame.contentWindow,
        data: { type: "machdoch:close-settings" },
      }),
    );
  });
  expect(document.querySelector(".m-product-settings-frame")).toBeNull();
  expect(
    document.querySelector(".m-application-content")?.hasAttribute("inert"),
  ).toBe(false);
  expect(document.activeElement).toBe(opener);
});

it("names the browser tab after the open chat and device", () => {
  setup();
  expect(document.title).toBe("Existing chat · Device");
});

it("opens services inside the instance app instead of leaving it", () => {
  setup(undefined, "/instances/device/runs");
  fireEvent.click(screen.getByRole("button", { name: "Services & previews" }));
  const frame = document.querySelector("iframe[title=\"Services & previews\"]")!;
  expect(frame.getAttribute("src")).toBe("/instances/device/runs");
  expect(document.querySelector('a[href="/instances/device/runs"]')).toBeNull();
});

it("tells embedded views when they are hidden", () => {
  setup(undefined, "/instances/device/runs");
  fireEvent.click(screen.getByRole("button", { name: "Services & previews" }));
  const frame = document.querySelector<HTMLIFrameElement>(
    'iframe[title="Services & previews"]',
  )!;
  const post = vi.spyOn(frame.contentWindow!, "postMessage");
  fireEvent.click(screen.getByRole("button", { name: "Chat" }));
  expect(post).toHaveBeenLastCalledWith(
    { type: "machdoch:view-visibility", visible: false },
    window.location.origin,
  );
  fireEvent.click(screen.getByRole("button", { name: "Services & previews" }));
  expect(post).toHaveBeenLastCalledWith(
    { type: "machdoch:view-visibility", visible: true },
    window.location.origin,
  );
});
