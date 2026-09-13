import type { CommandReceipt, ProductCommand, ProductSnapshot } from "@machdoch/fleet-protocol";
import { act, cleanup, render, screen } from "@testing-library/react";
import { StrictMode, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductRuntime } from "./product-runtime";
import type { ProductShell } from "./product-shell";
import { RemoteProductApp } from "./remote-product-app";

type ShellProps = ComponentProps<typeof ProductShell>;
let shell: ShellProps;

vi.mock("./product-shell", () => ({
  ProductShell: (props: ShellProps) => {
    shell = props;
    return <output data-testid="state">{JSON.stringify({
      eventId: props.snapshot?.eventId ?? null,
      error: props.error,
      commandError: props.commandError,
      pending: props.pendingCommands,
    })}</output>;
  },
}));

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function transport() {
  const snapshots: Array<ReturnType<typeof deferred<ProductSnapshot>> & { signal: AbortSignal | undefined }> = [];
  const commands: Array<ReturnType<typeof deferred<CommandReceipt>> & { signal: AbortSignal | undefined }> = [];
  const runtime: ProductRuntime = {
    getSnapshot: vi.fn((signal?: AbortSignal) => {
      const request = { ...deferred<ProductSnapshot>(), signal };
      snapshots.push(request);
      return request.promise;
    }),
    execute: vi.fn((_command: ProductCommand, signal?: AbortSignal) => {
      const request = { ...deferred<CommandReceipt>(), signal };
      commands.push(request);
      return request.promise;
    }),
  };
  return { runtime, snapshots, commands };
}

const snapshot = (eventId: number): ProductSnapshot => ({
  enabled: true, serverTime: eventId, eventId, sessions: [], commands: [],
});
const command: ProductCommand = { kind: "rename-session", sessionId: "session", title: "Renamed" };
const receipt: CommandReceipt = { commandId: "command", duplicate: false };
const flush = async () => { await act(async () => {}); };
const state = () => JSON.parse(screen.getByTestId("state").textContent!);

function startCommand() {
  let result: boolean | undefined;
  act(() => { void shell.onCommand(command).then((value) => { result = value; }); });
  return () => result;
}

function harness(strict = false) {
  const remote = transport();
  const element = (runtime: ProductRuntime) => strict
    ? <StrictMode><RemoteProductApp instanceName="Instance" runtime={runtime} /></StrictMode>
    : <RemoteProductApp instanceName="Instance" runtime={runtime} />;
  const view = render(element(remote.runtime));
  return { ...remote, show: (runtime: ProductRuntime) => view.rerender(element(runtime)), unmount: view.unmount };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("remote runtime refresh lifecycle", () => {
  it("keeps background draft saves out of the foreground pending state", async () => {
    const view = harness();
    view.snapshots[0]!.resolve(snapshot(1));
    await flush();
    act(() => {
      void shell.onCommand({
        kind: "update-draft",
        sessionId: "session",
        prompt: "Draft",
      });
    });
    expect(view.commands).toHaveLength(1);
    expect(state().pending).toBe(0);
    view.commands[0]!.resolve(receipt);
    await flush();
    view.snapshots[1]!.resolve(snapshot(2));
    await flush();
    expect(state().pending).toBe(0);
  });

  it("blocks commands while disconnected and enables them after recovery", async () => {
    const view = harness();
    view.snapshots[0]!.reject(new Error("Offline"));
    await flush();
    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await shell.onCommand(command);
    });
    expect(accepted).toBe(false);
    expect(view.commands).toHaveLength(0);
    act(() => {
      void shell.onRefresh();
    });
    view.snapshots[1]!.resolve(snapshot(2));
    await flush();
    startCommand();
    expect(view.commands).toHaveLength(1);
  });
  it("waits for a post-command snapshot when a command finishes during a poll", async () => {
    const view = harness();
    view.snapshots[0]!.resolve(snapshot(1));
    await flush();
    act(() => { vi.advanceTimersByTime(1500); });
    const result = startCommand();
    view.commands[0]!.resolve(receipt);
    await flush();
    expect(result()).toBeUndefined();
    expect(state().pending).toBe(1);
    expect(view.snapshots).toHaveLength(2);
    view.snapshots[1]!.resolve(snapshot(2));
    await flush();
    expect(view.snapshots).toHaveLength(3);
    expect(result()).toBeUndefined();
    view.snapshots[2]!.resolve(snapshot(3));
    await flush();
    expect(result()).toBe(true);
    expect(state()).toMatchObject({ eventId: 3, pending: 0, error: null });
  });

  it("coalesces commands completed before the next request starts", async () => {
    const view = harness();
    const first = startCommand();
    const second = startCommand();
    view.commands.forEach((request) => request.resolve(receipt));
    await flush();
    expect([first(), second()]).toEqual([undefined, undefined]);
    view.snapshots[0]!.resolve(snapshot(1));
    await flush();
    expect(view.snapshots).toHaveLength(2);
    expect([first(), second()]).toEqual([undefined, undefined]);
    view.snapshots[1]!.resolve(snapshot(2));
    await flush();
    expect([first(), second()]).toEqual([true, true]);
    expect(state().pending).toBe(0);
  });

  it("requires another request for a command completed during a command refresh", async () => {
    const view = harness();
    view.snapshots[0]!.resolve(snapshot(1));
    await flush();
    const first = startCommand();
    const second = startCommand();
    view.commands[0]!.resolve(receipt);
    await flush();
    expect(view.snapshots).toHaveLength(2);
    view.commands[1]!.resolve(receipt);
    await flush();
    view.snapshots[1]!.resolve(snapshot(2));
    await flush();
    expect(second()).toBeUndefined();
    expect(view.snapshots).toHaveLength(3);
    view.snapshots[2]!.resolve(snapshot(3));
    await flush();
    expect([first(), second()]).toEqual([true, true]);
  });

  it.each(["resolve", "reject"] as const)("ignores a replaced runtime's late snapshot %s without releasing the new poll", async (outcome) => {
    const view = harness();
    const next = transport();
    view.show(next.runtime);
    expect(view.snapshots[0]!.signal?.aborted).toBe(true);
    expect(next.snapshots).toHaveLength(1);
    const result = startCommand();
    next.commands[0]!.resolve(receipt);
    await flush();
    if (outcome === "resolve") view.snapshots[0]!.resolve(snapshot(99));
    else view.snapshots[0]!.reject(new Error("obsolete snapshot"));
    await flush();
    expect(state()).toMatchObject({ eventId: null, error: null, pending: 1 });
    act(() => { vi.advanceTimersByTime(4500); });
    expect(next.snapshots).toHaveLength(1);
    expect(result()).toBeUndefined();
    next.snapshots[0]!.resolve(snapshot(1));
    await flush();
    expect(result()).toBeUndefined();
    next.snapshots[1]!.resolve(snapshot(2));
    await flush();
    expect(result()).toBe(true);
    expect(state().eventId).toBe(2);
  });

  it.each(["resolve", "reject"] as const)("ignores a replaced runtime's late command %s", async (outcome) => {
    const view = harness();
    const oldResult = startCommand();
    const next = transport();
    view.show(next.runtime);
    const newResult = startCommand();
    expect(view.commands[0]!.signal?.aborted).toBe(true);
    if (outcome === "resolve") view.commands[0]!.resolve(receipt);
    else view.commands[0]!.reject(new Error("obsolete command"));
    await flush();
    expect(oldResult()).toBe(false);
    expect(newResult()).toBeUndefined();
    expect(state()).toMatchObject({ pending: 1, commandError: null });
    expect(view.snapshots).toHaveLength(1);
    expect(next.snapshots).toHaveLength(1);
    next.snapshots[0]!.resolve(snapshot(1));
    next.commands[0]!.resolve(receipt);
    await flush();
    next.snapshots[1]!.resolve(snapshot(2));
    await flush();
    expect(newResult()).toBe(true);
  });

  it.each(["resolve", "reject"] as const)("cancels a command refresh on unmount and ignores its late %s", async (outcome) => {
    const view = harness();
    view.snapshots[0]!.resolve(snapshot(1));
    await flush();
    const result = startCommand();
    view.commands[0]!.resolve(receipt);
    await flush();
    const refresh = view.snapshots[1]!;
    expect(refresh.signal?.aborted).toBe(false);
    view.unmount();
    await flush();
    expect(refresh.signal?.aborted).toBe(true);
    expect(result()).toBe(false);
    if (outcome === "resolve") refresh.resolve(snapshot(99));
    else refresh.reject(new Error("unmounted"));
    await flush();
    act(() => { vi.advanceTimersByTime(4500); });
    expect(view.snapshots).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels unfinished commands and polls on unmount", async () => {
    const view = harness();
    const result = startCommand();
    view.unmount();
    expect(view.commands[0]!.signal?.aborted).toBe(true);
    expect(view.snapshots[0]!.signal?.aborted).toBe(true);
    view.commands[0]!.resolve(receipt);
    view.snapshots[0]!.resolve(snapshot(99));
    await flush();
    expect(result()).toBe(false);
    expect(view.snapshots).toHaveLength(1);
  });

  it("settles refresh waiters through snapshot errors and allows recovery", async () => {
    const view = harness();
    const first = startCommand();
    const second = startCommand();
    view.commands.forEach((request) => request.resolve(receipt));
    await flush();
    view.snapshots[0]!.reject(new Error("superseded poll"));
    await flush();
    expect(state().error).toBeNull();
    expect([first(), second()]).toEqual([undefined, undefined]);
    view.snapshots[1]!.reject(new Error("refresh failed"));
    await flush();
    expect([first(), second()]).toEqual([true, true]);
    expect(state()).toMatchObject({ error: "refresh failed", commandError: null, pending: 0 });
    let refreshed = false;
    act(() => { void shell.onRefresh().then(() => { refreshed = true; }); });
    view.snapshots[2]!.resolve(snapshot(3));
    await flush();
    expect(refreshed).toBe(true);
    expect(state()).toMatchObject({ eventId: 3, error: null });
  });

  it("reports active command errors without starting a refresh", async () => {
    const view = harness();
    const result = startCommand();
    view.commands[0]!.reject(new Error("command failed"));
    await flush();
    expect(result()).toBe(false);
    expect(state()).toMatchObject({ commandError: "command failed", pending: 0 });
    expect(view.snapshots).toHaveLength(1);
  });

  it.each([false, true])("rejects retained callbacks after runtime replacement (reuse=%s)", async (reuse) => {
    const view = harness();
    const oldCommand = shell.onCommand;
    const oldRefresh = shell.onRefresh;
    const next = transport();
    view.show(next.runtime);
    if (reuse) view.show(view.runtime);
    let result: boolean | undefined;
    act(() => { void oldCommand(command).then((value) => { result = value; }); });
    await flush();
    expect(view.commands).toHaveLength(0);
    expect(next.commands).toHaveLength(0);
    expect(result).toBe(false);
    expect(state().pending).toBe(0);
    const active = reuse ? view : next;
    const count = active.snapshots.length;
    await act(async () => { await oldRefresh(); });
    active.snapshots.at(-1)!.resolve(snapshot(1));
    await flush();
    expect(active.snapshots).toHaveLength(count);
    expect(state().eventId).toBe(1);
  });

  it("isolates StrictMode effect cleanup from the replacement setup", async () => {
    const view = harness(true);
    expect(view.snapshots).toHaveLength(2);
    expect(view.snapshots[0]!.signal?.aborted).toBe(true);
    view.snapshots[0]!.resolve(snapshot(99));
    await flush();
    expect(state().eventId).toBeNull();
    view.snapshots[1]!.resolve(snapshot(1));
    await flush();
    expect(state().eventId).toBe(1);
  });
});
