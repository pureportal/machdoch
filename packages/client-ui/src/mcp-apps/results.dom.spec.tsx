import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  McpAppRequest,
  McpAppView,
} from "@machdoch/fleet-protocol/mcp-apps";
import { connectMcpApp, type McpAppInvoke } from "./host";
import { McpAppResults } from "./results";
import { McpAppsSettings } from "./settings";

vi.mock("./host", () => ({
  connectMcpApp: vi.fn(() => ({ receive: vi.fn(), close: vi.fn() })),
}));
vi.mock("./sandbox", () => ({ sandboxProxyUrl: () => "about:blank" }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const view: McpAppView = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Interactive comparison",
  html: "<p>Comparison</p>",
  csp: {
    connectDomains: [],
    resourceDomains: [],
    frameDomains: [],
    baseUriDomains: [],
  },
  arguments: {},
  result: {},
};

it("retries an app that never initializes and clears the startup timer after initialization", async () => {
  const run = vi.fn(async (_root: string, input: McpAppRequest) =>
    input.action === "load" ? view : { enabled: true },
  );
  const invoke: McpAppInvoke = <T,>(root: string, input: McpAppRequest) =>
    run(root, input) as Promise<T>;
  vi.useFakeTimers();
  await act(async () => {
    render(
      <McpAppResults
        appIds={[view.id]}
        workspaceRoot="C:/workspace"
        invoke={invoke}
      />,
    );
  });
  const first = screen.getByTitle(view.title);
  expect(screen.getByRole("status").textContent).toContain("Loading");
  await act(async () => vi.advanceTimersByTime(20_000));
  expect(screen.queryByTitle(view.title)).toBeNull();
  expect(screen.getByRole("alert").textContent).toContain("did not start");
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Retry" })),
  );
  expect(screen.getByTitle(view.title)).not.toBe(first);
  const host = vi.mocked(connectMcpApp).mock.calls.at(-1)![0];
  act(() => host.onInitialized?.());
  expect(screen.queryByRole("status")).toBeNull();
  await act(async () => vi.advanceTimersByTime(20_000));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByTitle(view.title)).toBeTruthy();
  expect(
    run.mock.calls.filter(([, input]) => input.action === "load"),
  ).toHaveLength(2);
});

it("updates the app toggle immediately and restores it when saving fails", async () => {
  let rejectSave!: (error: Error) => void;
  const pending = new Promise<never>((_resolve, reject) => {
    rejectSave = reject;
  });
  const invoke: McpAppInvoke = <T,>(_root: string, input: McpAppRequest) =>
    (input.action === "set-enabled"
      ? pending
      : Promise.resolve({ enabled: true })) as Promise<T>;
  render(<McpAppsSettings invoke={invoke} />);
  const toggle = screen.getByRole("checkbox", {
    name: "MCP Apps",
  }) as HTMLInputElement;
  await waitFor(() => expect(toggle.disabled).toBe(false));
  fireEvent.click(toggle);
  expect(toggle.checked).toBe(false);
  expect(toggle.disabled).toBe(true);
  await act(async () => rejectSave(new Error("Connection lost. Try again.")));
  expect(toggle.checked).toBe(true);
  expect(toggle.disabled).toBe(false);
  expect(screen.getByRole("alert").textContent).toBe(
    "Connection lost. Try again.",
  );
});

it("retries a failed load without reopening the conversation", async () => {
  const run = vi.fn(
    async (_root: string, input: McpAppRequest): Promise<unknown> => {
      if (input.action === "load")
        throw new Error("Server disconnected. Try again.");
      return { enabled: true };
    },
  );
  const invoke: McpAppInvoke = <T,>(root: string, input: McpAppRequest) =>
    run(root, input) as Promise<T>;
  render(
    <McpAppResults
      appIds={[view.id]}
      workspaceRoot="C:/workspace"
      invoke={invoke}
    />,
  );
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Server disconnected. Try again.",
  );
  run.mockImplementation(async (_root, input) =>
    input.action === "load" ? view : { enabled: true },
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByTitle(view.title)).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("removes the old app immediately when the workspace changes", async () => {
  let resolveSettings!: (value: { enabled: boolean }) => void;
  const pending = new Promise<{ enabled: boolean }>((resolve) => {
    resolveSettings = resolve;
  });
  const invoke: McpAppInvoke = <T,>(root: string, input: McpAppRequest) =>
    (root === "C:/second"
      ? pending
      : Promise.resolve(
          input.action === "load" ? view : { enabled: true },
        )) as Promise<T>;
  const { rerender } = render(
    <McpAppResults
      appIds={[view.id]}
      workspaceRoot="C:/first"
      invoke={invoke}
    />,
  );
  await screen.findByTitle(view.title);
  rerender(
    <McpAppResults
      appIds={[view.id]}
      workspaceRoot="C:/second"
      invoke={invoke}
    />,
  );
  expect(screen.queryByTitle(view.title)).toBeNull();
  await act(async () => resolveSettings({ enabled: false }));
});

it("disables existing apps immediately and reloads them when enabled again", async () => {
  vi.stubGlobal("BroadcastChannel", undefined);
  let enabled = true;
  const run = vi.fn(async (_root: string, input: McpAppRequest) => {
    if (input.action === "set-enabled") enabled = input.enabled;
    return input.action === "load" ? view : { enabled };
  });
  const invoke: McpAppInvoke = <T,>(root: string, input: McpAppRequest) =>
    run(root, input) as Promise<T>;
  render(
    <>
      <McpAppsSettings invoke={invoke} />
      <McpAppResults
        appIds={[view.id]}
        workspaceRoot="C:/workspace"
        invoke={invoke}
      />
    </>,
  );
  const frame = await screen.findByTitle(view.title);
  const toggle = screen.getByRole("checkbox", { name: "MCP Apps" });
  expect((toggle as HTMLInputElement).checked).toBe(true);
  fireEvent(window, new Event("focus"));
  await waitFor(() =>
    expect(
      run.mock.calls.filter(([, input]) => input.action === "settings").length,
    ).toBeGreaterThan(2),
  );
  expect(screen.getByTitle(view.title)).toBe(frame);
  fireEvent.click(toggle);
  await waitFor(() => expect(screen.queryByTitle(view.title)).toBeNull());
  expect((toggle as HTMLInputElement).checked).toBe(false);
  fireEvent.click(toggle);
  expect(await screen.findByTitle(view.title)).not.toBe(frame);
  expect(
    run.mock.calls.filter(([, input]) => input.action === "load"),
  ).toHaveLength(2);
});

it("does not mount a delayed app after the setting was disabled", async () => {
  vi.stubGlobal("BroadcastChannel", undefined);
  let enabled = true;
  let finish!: (result: McpAppView) => void;
  const pending = new Promise<McpAppView>((resolve) => {
    finish = resolve;
  });
  const run = vi.fn(async (_root: string, input: McpAppRequest) =>
    input.action === "load" ? pending : { enabled },
  );
  const invoke: McpAppInvoke = <T,>(root: string, input: McpAppRequest) =>
    run(root, input) as Promise<T>;
  render(
    <McpAppResults
      appIds={[view.id]}
      workspaceRoot="C:/workspace"
      invoke={invoke}
    />,
  );
  await waitFor(() =>
    expect(run).toHaveBeenCalledWith("C:/workspace", {
      action: "load",
      id: view.id,
    }),
  );
  enabled = false;
  fireEvent(window, new Event("machdoch:mcp-apps"));
  await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  await act(async () => {
    finish(view);
    await pending;
  });
  expect(screen.queryByTitle(view.title)).toBeNull();
});
